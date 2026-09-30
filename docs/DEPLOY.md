# Deploying owlery-inbound-parse

This guide works on any host that can run Docker or Bun and has a public HTTPS URL.

> **Setting up on a Mac Mini?** Use [`SETUP-MAC-MINI.md`](SETUP-MAC-MINI.md) instead. It's the tested step-by-step version and lists every problem we hit on the first deployment.

## What you get

- A public HTTPS endpoint at `/sendgrid/inbound` that receives SendGrid Inbound Parse POSTs.
- Parsing of the `from`, `to`, `subject`, `text`, `html`, and `attachmentN` fields.
- Basic Auth on the endpoint and a sender-domain allowlist, to limit who can post.
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

If you use Docker, leave `DB_PATH` and `INBOUND_ATTACHMENTS_DIR` unset. The image already points both at `/data`, which is where `./data` on the host is mounted.

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

## 5. Send a real email

Send an email from an address on your allowlist to `anything@inbound.example.com`. Mail from any other domain is dropped on purpose. Then check that it arrived:

```bash
docker compose exec -T api bun src/cli.ts tail
docker compose exec -T api bun src/cli.ts show <id>
ls data/inbound-parse/
```

## 6. Deleting old email data

Inbound email contains personal data: sender addresses, subjects, and message bodies. The `purge` command clears those columns (and any ID returned by a forward), deletes the email's attachment folder, and marks the row `purged`. The row itself stays as a record that the email arrived.

```bash
docker compose --profile cron run --rm inbound-purge    # purges emails older than 30 days
```

Schedule it daily. [`SETUP-MAC-MINI.md`](SETUP-MAC-MINI.md) (Part 10) has a launchd example for macOS.

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

- **Basic Auth is the only check that a request really came from SendGrid.** Anyone who learns the URL and password can post. Use a long random password and rotate it if it leaks. Checking SendGrid's signed Inbound Parse webhooks would be stronger; that isn't implemented yet.
- **Size limit:** SendGrid rejects messages over 30 MB. The receiver rejects requests over `INBOUND_MAX_BODY_BYTES` (32 MB by default) with a 413 before reading them, and reads anything smaller fully into memory.
- **Long filenames:** attachment names are cleaned and shortened to 100 characters, and prefixed with their position (`1-photo.png`).
- **Several recipients:** `to` is stored exactly as SendGrid sends it, so it can list several addresses separated by commas.
- **The allowlist checks the domain in the `From` header.** It stops casual mail, not someone deliberately faking a sender address.
