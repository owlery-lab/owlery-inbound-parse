# Deploying owlery-inbound-parse

This guide works on any host that can run Docker or Bun and has a public HTTPS URL.

> **Setting up on a Mac Mini?** Use [`SETUP-MAC-MINI.md`](SETUP-MAC-MINI.md) instead. It's the tested step-by-step version and lists every problem we hit on the first deployment.

## What you get

- A public HTTPS endpoint at `/sendgrid/inbound` that receives SendGrid Inbound Parse POSTs.
- Parsing of the `from`, `to`, `subject`, `text`, `html`, and `attachmentN` fields.
- Basic Auth on the endpoint, optional verification of SendGrid's request signatures, and a sender-domain allowlist, to limit who can post.
- One row per email in `inbound_emails` (SQLite), with attachments on disk under `data/inbound-parse/<uuid>/`.
- CLI commands to inspect emails and purge old ones: `tail`, `show <id>`, and `purge --older-than <days>`.
- An optional forwarder that sends each email on to another service, such as a Twilio Function. See [Forwarding to a Twilio Function](#forwarding-to-a-twilio-function).

## Prerequisites

- A domain whose DNS you can edit.
- A SendGrid account that has authenticated that domain (**Settings → Sender Authentication**). Only authenticated domains show up in the Inbound Parse setup screen.
- A host running this receiver (Docker recommended).
- A public HTTPS URL that reaches the host's port 3000. [Step 2](#2-public-https-ingress) covers two options.

## 1. DNS: point your mail subdomain at SendGrid

Add a single MX record for the subdomain that will receive mail. For `inbound.example.com`:

```
Type: MX
Name: inbound
Value: mx.sendgrid.net
Priority: 10
```

- **Use a subdomain, not the root domain.** That way you don't take over mail the root domain already receives.
- **Don't add a CNAME or A record for that subdomain.** A CNAME can't share a name with an MX record, and neither record is needed.

Check it: `dig +short MX inbound.example.com @8.8.8.8` should return `10 mx.sendgrid.net.`

## 2. Public HTTPS ingress

SendGrid needs a public HTTPS URL it can POST to. Pick one of these options.

### 2a. Tailscale Funnel

1. Allow Funnel in your tailnet policy: **Access controls → JSON editor**. Add `"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`.
2. On the host, run `tailscale funnel --bg 3000`. No `sudo` needed. The first time, it prints a link to turn Funnel on for your tailnet. Open the link and run the command again. `--bg` saves the setting so it survives restarts.
3. Your public URL is `https://<host>.<tailnet>.ts.net`. Public DNS for the new name can take several minutes. Check it with `dig @8.8.8.8`.

### 2b. Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create inbound
cloudflared tunnel route dns inbound receiver.example.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: inbound
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: receiver.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Then run `cloudflared tunnel run inbound`. Pick a tunnel hostname that isn't your mail subdomain, because the mail subdomain's DNS belongs to the MX record.

## 3. Configure and start

```bash
cp .env.example .env && chmod 600 .env
openssl rand -base64 32 | tr -d '=+/' | cut -c1-32     # use this as the Basic Auth password
```

Set these in `.env`:

```bash
SENDGRID_INBOUND_BASIC_AUTH_USER=inbound
SENDGRID_INBOUND_BASIC_AUTH_PASS=<the generated password>
SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS=example.com
```

Replace `example.com` with the domain or domains you'll send test mail from, separated by commas. Empty accepts everyone, which is fine locally but not on a public URL.

If you use Docker, leave `DB_PATH` and `INBOUND_ATTACHMENTS_DIR` unset. The image already points both at `/data`, which is a Docker named volume called `owlery-data`.

Then start the receiver:

```bash
# Docker (recommended)
docker compose up -d --build
docker compose logs -f api

# Or run it directly with Bun
bun install
bun run dev
```

The database tables are created automatically at startup. With Docker, the container's entrypoint starts as root, gives the unprivileged `bun` user ownership of `/data`, and then runs the server as that user.

**Keep the database in the named volume, and let only the running container open it.** SQLite depends on file locking. Folders that Docker Desktop shares from macOS or Windows don't lock reliably. If a second process opens the database there, the server can report emails as saved while the writes are actually lost. So:

- Run every CLI command inside the running container, as shown below.
- Don't mount a host folder at `/data`.
- Don't open the database file from the host or from a second container.

Test it locally:

```bash
set -a; source .env; set +a
curl -u "inbound:$SENDGRID_INBOUND_BASIC_AUTH_PASS" \
  -F 'from=you@example.com' -F 'subject=hi' -F 'text=hello from curl' \
  http://localhost:3000/sendgrid/inbound
# → {"ok":true,"id":1,"num_attachments":0}
```

## 4. Register the route in SendGrid

In SendGrid, go to **Settings → Inbound Parse → Add Host & URL** and fill in:

- **Receiving Domain:** your mail subdomain, for example `inbound.example.com`.
- **Destination URL:** `https://inbound:<password>@<public-host>/sendgrid/inbound`. Use the public HTTPS host from Step 2 here, not the mail subdomain.
- **Check incoming emails for spam:** on.
- **POST the raw, full MIME message:** off. This receiver only handles the parsed format.

## 5. Turn on signed webhooks

SendGrid can sign every Inbound Parse request with ECDSA. With the signing key set, the receiver rejects any request that SendGrid didn't sign, even one with the right Basic Auth password. Basic Auth stays on as a second layer. See SendGrid's [Securing your Inbound Parse Webhooks](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks).

This has to be done through the SendGrid API, not the console. You need an API key that can manage Inbound Parse settings, and `jq` (macOS 15 and later include it; otherwise `brew install jq`).

**Do the steps in this order.** Until the key is set, the receiver ignores the signature headers. So attaching the policy first changes nothing, and turning on the check last means no mail arrives unsigned once checking is on.

### The quick way: `scripts/sendgrid-signing.sh`

The script does steps 1–4 below in that order. It asks for your API key at a hidden prompt, reuses a policy that's already attached instead of creating another, and never prints the Parse setting's `url`.

On the receiver's host, from the repo folder:

```bash
scripts/sendgrid-signing.sh enable inbound.example.com --apply
```

With `--apply`, it also writes `SENDGRID_INBOUND_VERIFICATION_KEY` to `.env`, recreates the container, and waits until the log says verification is on. If the receiver doesn't confirm it, the script takes the key back out so mail keeps arriving. Without `--apply` (for example, on a laptop), it attaches the policy and prints the `.env` line for you to add on the host.

Then send a real email (step 5) and run:

```bash
scripts/sendgrid-signing.sh check       # counts of recorded and rejected requests, with reasons; no email content
```

`scripts/sendgrid-signing.sh status inbound.example.com` shows what's attached, and `disable` undoes it (see [Rolling back](#rolling-back)). Set `SENDGRID_API_BASE=https://api.eu.sendgrid.com` for an EU-region account.

### Step by step with curl

The same thing, by hand. Run these from any machine, in one terminal session. Typing the API key at a prompt keeps it out of your shell history, and saving it as a header file keeps it out of curl's arguments, where other users of the machine could see it with `ps`. The key and the responses go in a private temporary folder (mode `0700`), because the Parse setting's `url` contains your Basic Auth password. If your account is in SendGrid's EU region, use `https://api.eu.sendgrid.com` instead of `https://api.sendgrid.com`.

```bash
WORK=$(mktemp -d)                                       # private folder for the key and responses
read -rs KEY && printf 'Authorization: Bearer %s\n' "$KEY" > "$WORK/auth"; unset KEY   # paste the key, press Enter
PARSE_HOST=inbound.example.com                          # your Receiving Domain from Step 4
```

**1. Create a security policy that only signs.**

```bash
curl -sS --fail-with-body -o "$WORK/policy.json" \
  -X POST "https://api.sendgrid.com/v3/user/webhooks/security/policies" \
  --header @"$WORK/auth" \
  --header "Content-Type: application/json" \
  --data '{"name": "owlery-inbound-parse", "signature": {"enabled": true}}' \
  && jq -e '{id: .policy.id, public_key: .policy.signature.public_key} | select(.id and .public_key)' "$WORK/policy.json" \
  || { echo "Policy not created:"; cat "$WORK/policy.json"; }
```

It prints the policy ID and the public key. The public key isn't secret; you'll paste it into `.env` in step 4. If it prints `Policy not created`, read the error and stop. Run step 1 only once: each run creates another policy.

**2. Look at your current Parse setting.**

```bash
curl -sS --fail-with-body -o "$WORK/parse-setting.json" \
  "https://api.sendgrid.com/v3/user/webhooks/parse/settings/$PARSE_HOST" \
  --header @"$WORK/auth" \
  && jq '{hostname, spam_check, send_raw, security_policy}' "$WORK/parse-setting.json" \
  || { echo "Parse setting not found:"; jq '.errors // "no error details"' "$WORK/parse-setting.json"; }
```

`send_raw` should be `false`. The output leaves out `url` because it contains your Basic Auth password.

**3. Attach the policy.** This sends back your existing `url`, `spam_check`, and `send_raw` values unchanged, along with the policy ID, the way SendGrid's example does. Building the request from the saved files keeps the password out of your shell history. The `jq -e` check stops it if either file is missing a value or `send_raw` isn't `false`.

```bash
jq -en --slurpfile s "$WORK/parse-setting.json" --slurpfile p "$WORK/policy.json" '
  ($s[0] | select(.url and .send_raw == false)) as $setting
  | ($p[0].policy.id | select(.)) as $id
  | {url: $setting.url, spam_check: $setting.spam_check, send_raw: false, security_policy: $id}' \
  > "$WORK/patch.json" \
  && curl -sS --fail-with-body -o "$WORK/patched.json" \
       -X PATCH "https://api.sendgrid.com/v3/user/webhooks/parse/settings/$PARSE_HOST" \
       --header @"$WORK/auth" \
       --header "Content-Type: application/json" \
       --data @"$WORK/patch.json" \
  && jq '{hostname, send_raw, security_policy}' "$WORK/patched.json" \
  || { echo "Not attached:"; jq '.errors // "check the output of steps 1 and 2"' "$WORK/patched.json" 2>/dev/null; }
```

The output should show `security_policy` set to the policy ID from step 1. From now on, SendGrid adds the `X-Twilio-Email-Event-Webhook-Signature` and `X-Twilio-Email-Event-Webhook-Timestamp` headers to each request.

When you're done with the API, delete the saved key and responses:

```bash
rm -rf "$WORK"; unset WORK
```

**4. Set the key on the receiver and restart it.** In `.env` on the host, add the `public_key` value from step 1 on one line:

```bash
SENDGRID_INBOUND_VERIFICATION_KEY=<public_key from step 1>
```

Then recreate the container so it reads the new value. A plain `restart` doesn't reload `.env`.

```bash
docker compose up -d --force-recreate api
docker compose logs --tail 20 api
```

If the key is malformed, the server refuses to start and the log says so. If the log still shows `SENDGRID_INBOUND_VERIFICATION_KEY not set`, the new `.env` wasn't picked up.

**5. Prove it with a real email.** Send one from an allowlisted address, as in [Step 6](#6-send-a-real-email), then:

```bash
docker compose exec -T -u bun api bun src/cli.ts tail
docker compose logs --since 10m api | grep "signature check failed"
```

The new email should be in `tail`, and `grep` should print nothing. **This test is the proof that signing works for this receiver.** SendGrid's docs show signing with `send_raw: true`, and this receiver uses parsed mode (`send_raw: false`); the docs don't say outright that parsed mode is signed the same way. If the email is missing and the log shows `signature check failed`, roll back right away (below); SendGrid doesn't document retrying a 401, so treat any mail rejected this way as lost. The log's `reason` tells you why:

- `missing`: the request had no signature headers. The policy isn't attached; check step 3.
- `bad signature`: the key in `.env` doesn't match the policy, or something between SendGrid and the receiver changed the body.
- `stale timestamp`: the host's clock is more than `SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS` (5 minutes by default) off. Fix the clock.

A `Bad Request` with `signed body isn't multipart/form-data` in the log means the request was signed but wasn't in the parsed format. Check that `send_raw` is still `false`.

### Rolling back

Undo it in the reverse order, so no mail is rejected along the way. On the receiver's host, the script does both steps:

```bash
scripts/sendgrid-signing.sh disable inbound.example.com --apply
```

By hand:

1. Remove (or comment out) `SENDGRID_INBOUND_VERIFICATION_KEY` in `.env`, then run `docker compose up -d --force-recreate api`. The receiver goes back to checking Basic Auth only, and ignores any signature headers. This alone is a complete rollback.
2. Optionally, detach the policy from the Parse setting:

   ```bash
   WORK=$(mktemp -d)
   read -rs KEY && printf 'Authorization: Bearer %s\n' "$KEY" > "$WORK/auth"; unset KEY   # paste the key, press Enter
   PARSE_HOST=inbound.example.com
   SETTINGS="https://api.sendgrid.com/v3/user/webhooks/parse/settings/$PARSE_HOST"

   # Resend the current url, spam_check, and send_raw with security_policy set to null.
   # On failure this prints only SendGrid's error, never the saved setting (its url has the password).
   curl -sS --fail-with-body -o "$WORK/parse-setting.json" "$SETTINGS" \
     --header @"$WORK/auth" \
     && jq -e 'select(.url) | {url, spam_check, send_raw, security_policy: null}' \
          "$WORK/parse-setting.json" > "$WORK/patch.json" \
     && curl -sS --fail-with-body -o "$WORK/patch-response.json" -X PATCH "$SETTINGS" \
          --header @"$WORK/auth" \
          --header "Content-Type: application/json" \
          --data @"$WORK/patch.json" \
     || { echo "Detach failed:"; jq '.errors // "no error details"' "$WORK/patch-response.json" "$WORK/parse-setting.json" 2>/dev/null; }

   # Check the result.
   curl -sS --fail-with-body "$SETTINGS" --header @"$WORK/auth" \
     | jq '{hostname, spam_check, send_raw, security_policy}'

   rm -rf "$WORK"; unset WORK SETTINGS
   ```

   SendGrid doesn't document how to detach a policy. Sending `null` is our best guess, so the last command checks it: `security_policy` should now be `null` or gone, and `spam_check` and `send_raw` should be unchanged. If the policy is still attached, leaving it is harmless once step 1 is done, because the receiver ignores the headers.

## 6. Send a real email

Send an email from an address on your allowlist to `anything@inbound.example.com`. Mail from any other domain is dropped on purpose. Then check that it arrived:

```bash
docker compose exec -T -u bun api bun src/cli.ts tail
docker compose exec -T -u bun api bun src/cli.ts show <id>
docker compose exec -T -u bun api ls /data/inbound-parse
```

To copy an attachment out to the host, use `docker compose cp api:/data/inbound-parse/<folder>/<file> .`

## 7. Deleting old email data

Inbound email contains personal data: sender addresses, subjects, and message bodies. The `purge` command clears those columns (and any ID returned by a forward), deletes the email's attachment folder, and marks the row `purged`. The row itself stays as a record that the email arrived.

```bash
docker compose exec -T -u bun api bun src/cli.ts purge --older-than 30
```

Run it inside the running container, like the other commands, so only one process ever writes to the database. Schedule it daily. [`SETUP-MAC-MINI.md`](SETUP-MAC-MINI.md) (Part 11) has a launchd example for macOS.

## Forwarding to a Twilio Function

The receiver can forward each saved email to a second service. It was built for Twilio Functions: Twilio Serverless can't parse `multipart/form-data` and doesn't expose the raw request body, so SendGrid can't POST to a Function directly. This receiver parses the multipart request and forwards the email as `application/x-www-form-urlencoded` with a Bearer token.

To turn it on, set both of these:

```bash
TWILIO_FUNCTION_INBOUND_URL=https://your-service-1234.twil.io/api/inbound-email
TWILIO_FUNCTION_INBOUND_TOKEN=<long random string; the Function checks this token>
```

After an email is saved, the receiver POSTs `from`, `to`, `subject`, `text`, and `envelope` to that URL with `Authorization: Bearer <token>`. The request times out after 5 seconds. The result goes on the email's row:

- On success, `action_taken` is `twilio_function_forwarded` and the row's status becomes `acted`.
- On failure, `action_taken` is `twilio_function_forward_failed:<status>` and the status stays `received`.
- `action_ref` holds the `key` or `id` from the Function's JSON response. `purge` clears it along with the rest of the personal data.

A failed forward never fails the response to SendGrid, and the receiver doesn't retry it.

**The Function has to be public (`.js`), not protected (`.protected.js`).** Protected Functions require a Twilio request signature, and this receiver sends a Bearer token instead, so every forward to a protected Function would be rejected.

## Gotchas

- **Without signed webhooks, Basic Auth is the only check that a request really came from SendGrid.** Anyone who learns the URL and password can post. [Turn on signed webhooks](#5-turn-on-signed-webhooks), and still use a long random password and rotate it if it leaks.
- **Signed requests can be replayed within the timestamp window.** A captured signed request is accepted again for up to `SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS` (5 minutes by default). SendGrid doesn't specify a window; 5 minutes is our choice. Keep the host's clock synced, or real mail is rejected as `stale timestamp`.
- **Size limit:** SendGrid rejects messages over 30 MB. The receiver answers requests over `INBOUND_MAX_BODY_BYTES` (32 MB by default) with a 413. If the request declares a larger `Content-Length`, it's refused before any of the body is read. A chunked request without one is read and counted until it crosses the limit, then refused, so at most the limit is ever buffered. Anything under the limit is read fully into memory.
- **Long filenames:** attachment names are cleaned and shortened to 100 characters, and prefixed with their position (`1-photo.png`).
- **Several recipients:** `to` is stored exactly as SendGrid sends it, so it can list several addresses separated by commas.
- **The allowlist checks the domain in the `From` header.** It stops casual mail, not someone deliberately faking a sender address.
