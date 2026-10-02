#!/usr/bin/env bash
# Turns SendGrid's signed Inbound Parse webhooks on or off for this receiver.
#
#   scripts/sendgrid-signing.sh enable  <parse-host> [--apply]
#   scripts/sendgrid-signing.sh disable <parse-host> [--apply]
#   scripts/sendgrid-signing.sh status  <parse-host>
#   scripts/sendgrid-signing.sh check   [--since 15m]
#
# <parse-host> is your Parse setting's Receiving Domain, e.g. inbound.example.com.
# --apply also sets or removes SENDGRID_INBOUND_VERIFICATION_KEY in this
#   checkout's .env and recreates the api container. Use it on the receiver's host.
# check summarizes recent receiver logs (no email content) after a test email.
#
# Asks for a SendGrid API key at a hidden prompt, which keeps it out of
# arguments, output, shell history, and the environment. (SENDGRID_API_KEY also
# works, for automation, but then it's in this script's environment.) For an EU-region
# account, set SENDGRID_API_BASE=https://api.eu.sendgrid.com. Needs curl and jq.
# See docs/DEPLOY.md, "Turn on signed webhooks".
set -euo pipefail

API_BASE="${SENDGRID_API_BASE:-https://api.sendgrid.com}"
POLICY_NAME="owlery-inbound-parse"
KEY_VAR="SENDGRID_INBOUND_VERIFICATION_KEY"
KEY_LINE="^[[:space:]]*(export[[:space:]]+)?${KEY_VAR}="
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO/.env"

say() { echo "==> $*"; }
die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

WORK=""
cleanup() { if [ -n "$WORK" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT

# A private (0700) folder for responses: the Parse setting's url has the Basic Auth password.
make_work() {
  if [ -z "$WORK" ]; then WORK="$(mktemp -d)"; fi
}

need() { command -v "$1" >/dev/null || die "$1 is required${2:+ ($2)}"; }

compose() { (cd "$REPO" && docker compose "$@"); }

# --- SendGrid API ---

start_api() {
  need curl
  need jq "macOS 15 and later include it; otherwise brew install jq"
  make_work
  local key="${SENDGRID_API_KEY:-}"
  # Keeps the key out of the environment that curl and docker inherit.
  unset SENDGRID_API_KEY
  if [ -z "$key" ]; then
    [ -t 0 ] || die "no terminal to prompt on; set SENDGRID_API_KEY instead"
    read -rsp "SendGrid API key (input hidden): " key
    echo
  fi
  [ -n "$key" ] || die "no API key given"
  # A header file, not a curl argument, so the key never shows up in ps.
  (umask 077 && printf 'Authorization: Bearer %s\n' "$key" > "$WORK/auth")
}

# api METHOD PATH [JSON_FILE]: saves the response to $WORK/response.json.
# On an HTTP error it prints only SendGrid's error messages, then fails.
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS --fail-with-body -o "$WORK/response.json" -X "$method" -H @"$WORK/auth")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data @"$body"); fi
  if ! curl "${args[@]}" "$API_BASE$path"; then
    echo "SendGrid returned an error for $method $path:" >&2
    jq '.errors // "no error details"' "$WORK/response.json" >&2 2>/dev/null || true
    return 1
  fi
}

get_setting() {
  api GET "/v3/user/webhooks/parse/settings/$HOST"
  cp "$WORK/response.json" "$WORK/setting.json"
  jq -e '.url' "$WORK/setting.json" >/dev/null || die "no Parse setting found for $HOST"
}

# Never prints url, which contains the Basic Auth password.
show_setting() { jq '{hostname, spam_check, send_raw, security_policy}' "$1"; }

# --- Receiver ---

# Sets KEY_VAR in .env to $1, or removes it when $1 is empty. Keeps the file 0600.
set_env_key() {
  [ ! -L "$ENV_FILE" ] || die "$ENV_FILE is a symlink; refusing to edit it"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found; use --apply on the host that runs the receiver"
  local tmp="$ENV_FILE.tmp.$$" rc=0
  (umask 077 && : > "$tmp")
  # grep exits 1 when no lines are left, which is fine; anything higher is a read error.
  grep -Ev "$KEY_LINE" "$ENV_FILE" > "$tmp" || rc=$?
  if [ "$rc" -gt 1 ]; then rm -f "$tmp"; die "couldn't read $ENV_FILE; it wasn't changed"; fi
  if [ -n "$1" ]; then printf '%s=%s\n' "$KEY_VAR" "$1" >> "$tmp"; fi
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Saves the api container's logs to $WORK/logs.txt.
save_logs() { compose logs --no-log-prefix "$@" api > "$WORK/logs.txt" 2>/dev/null || true; }

logged() { grep -q "$1" "$WORK/logs.txt"; }

# Fails unless the running receiver knows about signatures (logs one of its startup lines).
require_signature_support() {
  need docker
  make_work
  save_logs
  logged "signature verification enabled" || logged "$KEY_VAR not set" \
    || die "the running receiver doesn't log signature support. If it predates it, update first:
  git pull && docker compose up -d --build
then run this again. (If its logs were rotated, recreate it: docker compose up -d --force-recreate api)"
}

# recreate_api on|off: recreates the container (fresh logs) and waits until it says
# whether it's verifying signatures. Fails after 60 seconds or on a bad key.
recreate_api() {
  say "Recreating the api container..."
  compose up -d --force-recreate api
  local i
  for i in $(seq 1 60); do
    save_logs
    if [ "$1" = on ] && logged "signature verification enabled"; then say "The receiver is verifying signatures."; return 0; fi
    if [ "$1" = off ] && logged "$KEY_VAR not set"; then say "The receiver is back to Basic Auth only."; return 0; fi
    if logged "$KEY_VAR is not a valid public key" || logged "$KEY_VAR must be"; then return 1; fi
    sleep 1
  done
  return 1
}

# --- Commands ---

cmd_enable() {
  if [ "$APPLY" = 1 ]; then require_signature_support; fi
  start_api
  get_setting
  say "Current Parse setting for $HOST:"
  show_setting "$WORK/setting.json"
  jq -e '.send_raw == false' "$WORK/setting.json" >/dev/null \
    || die "send_raw is on, but this receiver only handles the parsed format"

  local attached policy_id public_key
  attached="$(jq -r '.security_policy // empty' "$WORK/setting.json")"
  if [ -n "$attached" ]; then
    say "Policy $attached is already attached; reusing it."
    api GET "/v3/user/webhooks/security/policies/$attached"
  else
    say "Creating a signature-only security policy..."
    jq -n --arg name "$POLICY_NAME" '{name: $name, signature: {enabled: true}}' > "$WORK/policy-request.json"
    api POST "/v3/user/webhooks/security/policies" "$WORK/policy-request.json"
  fi
  policy_id="$(jq -r '.policy.id // empty' "$WORK/response.json")"
  public_key="$(jq -r '.policy.signature.public_key // empty' "$WORK/response.json")"
  [ -n "$policy_id" ] || die "SendGrid didn't return a policy ID"
  [ -n "$public_key" ] || die "policy $policy_id has no signing key (is it OAuth-only?)"
  # The documented response doesn't include signature.enabled, so only an explicit false is refused.
  jq -e '.policy.signature.enabled != false' "$WORK/response.json" >/dev/null \
    || die "policy $policy_id has signing turned off; turn it on or detach it, then run this again"

  if [ "$attached" != "$policy_id" ]; then
    say "Attaching policy $policy_id to $HOST..."
    # Resends the current url, spam_check, and send_raw, as SendGrid's example does.
    jq --arg id "$policy_id" '{url, spam_check, send_raw, security_policy: $id}' \
      "$WORK/setting.json" > "$WORK/patch.json"
    api PATCH "/v3/user/webhooks/parse/settings/$HOST" "$WORK/patch.json"
    jq -e --arg id "$policy_id" '.security_policy == $id' "$WORK/response.json" >/dev/null \
      || die "SendGrid didn't confirm the policy is attached, so the receiver wasn't changed. Check with: $0 status $HOST"
    show_setting "$WORK/response.json"
  fi

  if [ "$APPLY" != 1 ]; then
    echo
    say "SendGrid is signing requests. Now add this line to the receiver's .env:"
    echo "$KEY_VAR=$public_key"
    echo "then run: docker compose up -d --force-recreate api"
    return
  fi

  say "Setting $KEY_VAR in $ENV_FILE..."
  set_env_key "$public_key"
  if ! recreate_api on; then
    echo "The receiver didn't confirm it's verifying signatures. Its last log lines:" >&2
    compose logs --no-log-prefix --tail 15 api >&2 || true
    say "Removing the key again so mail keeps arriving..."
    set_env_key ""
    recreate_api off \
      || die "the key is out of .env again, but the receiver didn't confirm it restarted. Check it now: docker compose ps; docker compose logs --tail 20 api"
    die "signing not turned on at the receiver. The policy is still attached, which is harmless while the key is unset."
  fi
  echo
  say "Done. Now send a real email from an allowlisted address, wait a minute, and run:"
  echo "  $0 check"
}

cmd_disable() {
  if [ "$APPLY" = 1 ]; then
    need docker
    make_work
    say "Removing $KEY_VAR from $ENV_FILE..."
    set_env_key ""
    # Detaching while the receiver still verifies would reject every email, so stop here.
    recreate_api off \
      || die "the receiver didn't confirm it's back to Basic Auth only, so the policy is still attached. Check: docker compose logs --tail 20 api"
  else
    echo "Detaching the policy while the receiver still has $KEY_VAR set rejects every email."
    [ -t 0 ] || die "no terminal to confirm on; run this with --apply on the receiver's host"
    local answer
    read -rp "Is $KEY_VAR already unset on the receiver, and has it been recreated? [y/N] " answer
    case "$answer" in y|Y|yes) ;; *) die "unset it first, or run this with --apply on the receiver's host" ;; esac
  fi

  start_api
  get_setting
  say "Detaching the security policy from $HOST..."
  # SendGrid doesn't document detaching; null is our best guess, so the result is checked.
  jq '{url, spam_check, send_raw, security_policy: null}' "$WORK/setting.json" > "$WORK/patch.json"
  api PATCH "/v3/user/webhooks/parse/settings/$HOST" "$WORK/patch.json"
  show_setting "$WORK/response.json"
  if jq -e '.security_policy // empty' "$WORK/response.json" >/dev/null; then
    echo "warning: SendGrid didn't clear security_policy. That's harmless: with the key unset, the receiver ignores the signature headers." >&2
  else
    say "Detached."
  fi
}

cmd_status() {
  start_api
  get_setting
  show_setting "$WORK/setting.json"
  if [ -f "$ENV_FILE" ]; then
    if grep -Eq "${KEY_LINE}." "$ENV_FILE"; then
      echo "This checkout's .env: $KEY_VAR is set."
    else
      echo "This checkout's .env: $KEY_VAR is not set."
    fi
  fi
}

cmd_check() {
  need docker
  need jq
  make_work
  save_logs --since "$SINCE"
  say "Receiver log summary for the last $SINCE (no email content):"
  jq -Rrn '
    [inputs | fromjson? | select(type == "object") | {message: (.message // ""), reason}] as $l
    | def count(f): [$l[] | select(f)] | length;
    "  Emails recorded:           \(count(.message == "Inbound email recorded"))",
    "  Signature check failures:  \(count(.message == "Inbound request rejected: signature check failed"))",
    ([$l[] | select(.message == "Inbound request rejected: signature check failed") | .reason]
      | group_by(.) | .[] | "    \(.[0]): \(length)"),
    "  Not multipart (signed):    \(count(.message | startswith("Inbound request rejected: signed body")))",
    "  Basic Auth rejections:     \(count(.message == "Webhook auth rejected"))",
    "  Sender not allowlisted:    \(count(.message | startswith("Inbound email rejected: sender domain")))"
  ' "$WORK/logs.txt"
  echo "To see the emails themselves: docker compose exec -T -u bun api bun src/cli.ts tail"
}

# --- Arguments ---

CMD="${1:-}"
if [ $# -gt 0 ]; then shift; fi
HOST=""
APPLY=0
SINCE="15m"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --since) [ $# -ge 2 ] || die "--since needs a value, such as 15m"; SINCE="$2"; shift ;;
    -h|--help) usage ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$HOST" ] || die "unexpected argument: $1"; HOST="$1" ;;
  esac
  shift
done

case "$CMD" in
  enable|disable|status)
    [ -n "$HOST" ] || die "$CMD needs your Parse hostname, such as inbound.example.com"
    case "$HOST" in *[!A-Za-z0-9.-]*) die "not a hostname: $HOST" ;; esac
    "cmd_$CMD"
    ;;
  check) cmd_check ;;
  ""|help|-h|--help) usage ;;
  *) echo "unknown command: $CMD" >&2; usage 1 ;;
esac
