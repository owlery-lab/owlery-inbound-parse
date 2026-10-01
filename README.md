# owlery-inbound-parse

Receive email at your own domain and turn each message into a database row your code can act on.

This is a small, self-hosted receiver for [SendGrid Inbound Parse](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook). When someone emails `anything@inbound.example.com`, SendGrid parses the message and POSTs it here. The receiver checks that the request is authorized, saves the email and its attachments, and can forward the email to another service, such as a Twilio Function.

It was built to run on a Mac Mini (named "the Owlery") behind Tailscale Funnel, but it runs anywhere Docker or [Bun](https://bun.sh) runs.

## How it works

```
Sender ──email──▶ SendGrid ──HTTPS POST──▶ owlery-inbound-parse ──optional──▶ Twilio Function
                  (MX record              (Basic Auth, signature,             (or any HTTPS
                   points here)            allowlist, SQLite +                 endpoint)
                                           attachments)
```

1. Your subdomain's MX record points at SendGrid (`mx.sendgrid.net`).
2. SendGrid parses each incoming email and POSTs it as `multipart/form-data` to `/sendgrid/inbound`.
3. The receiver checks the Basic Auth credentials in the URL, then SendGrid's signature on the raw request (if you've turned that on), then the sender's domain.
4. It saves one row to the `inbound_emails` table and writes any attachments to `/data/inbound-parse/<uuid>/` (in the `owlery-data` Docker volume).
5. If forwarding is configured, it sends the email on as `application/x-www-form-urlencoded`. Twilio Serverless can't parse multipart, so this receiver does it and passes the result along.

## Quickstart

You need Docker. Run these steps locally; they don't need SendGrid or a public URL yet.

```bash
git clone https://github.com/owlery-lab/owlery-inbound-parse.git
cd owlery-inbound-parse
cp .env.example .env && chmod 600 .env
# Edit .env: set SENDGRID_INBOUND_BASIC_AUTH_PASS to a long random string,
# and SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS to the domain(s) you'll send from.

docker compose up -d --build
curl http://localhost:3000/health
# → {"status":"ok","service":"owlery-inbound-parse"}
```

Send it a fake email:

```bash
set -a; source .env; set +a
curl -u "inbound:$SENDGRID_INBOUND_BASIC_AUTH_PASS" \
  -F 'from=you@example.com' -F 'subject=hello' -F 'text=first message' \
  http://localhost:3000/sendgrid/inbound
docker compose exec -T -u bun api bun src/cli.ts tail
```

To receive real email, you also need an MX record, a public HTTPS URL, and a SendGrid route. See [Deploying](#deploying).

## Deploying

- **[`docs/SETUP-MAC-MINI.md`](docs/SETUP-MAC-MINI.md):** step by step, from a blank Mac Mini to the first real email, including every problem we hit on the first deployment.
- **[`docs/DEPLOY.md`](docs/DEPLOY.md):** a shorter guide for any host: DNS, Tailscale Funnel or Cloudflare Tunnel, SendGrid, and forwarding.

## Configuration

All settings are environment variables, read from `.env`. See [`.env.example`](.env.example) for the full list with comments.

| Variable | Required | What it does |
|---|---|---|
| `SENDGRID_INBOUND_BASIC_AUTH_USER` / `_PASS` | Yes, in production | Credentials SendGrid must send. If they're missing, the route returns 503 in production and accepts anything in development. |
| `SENDGRID_INBOUND_VERIFICATION_KEY` | Recommended | SendGrid's public key from the security policy on your Parse setting. When set, every request needs a valid SendGrid signature as well as Basic Auth. Base64, as SendGrid shows it, or PEM. A malformed key stops the server from starting. When unset, only Basic Auth is checked, and the server logs a warning at startup in production. |
| `SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS` | No | How far the signed timestamp may be from the server's clock, either way. Default 300 (5 minutes). SendGrid doesn't specify a window; this is our choice. |
| `SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS` | Recommended | Comma-separated sender domains to accept, such as `yourcompany.com`. Empty accepts everyone. |
| `TWILIO_FUNCTION_INBOUND_URL` / `_TOKEN` | No | Turns on forwarding to that URL with a Bearer token. |
| `INBOUND_MAX_BODY_BYTES` | No | Largest request accepted, in bytes. Default 32 MB (SendGrid's own limit is 30 MB). |
| `DB_PATH`, `INBOUND_ATTACHMENTS_DIR` | No | Where data is stored. Leave unset with Docker; the image uses `/data`, which is the `owlery-data` volume. |

## Responses

| Situation | HTTP status | Body |
|---|---|---|
| Email saved | 200 | `{"ok":true,"id":<id>,"num_attachments":<n>}` |
| Sender domain not allowed | 202 | `{"ok":false,"reason":"sender_domain_not_allowed"}` |
| Missing or wrong Basic Auth | 401 | `Unauthorized`, with a `WWW-Authenticate` header |
| Signature missing or invalid, or its timestamp outside the window (only when `SENDGRID_INBOUND_VERIFICATION_KEY` is set) | 401 | `Unauthorized`, without `WWW-Authenticate`. The log gives the reason: `missing`, `bad signature`, or `stale timestamp`. |
| Request larger than `INBOUND_MAX_BODY_BYTES` | 413 | `Payload Too Large` |
| Body couldn't be parsed, or (with signatures on) the signed body isn't `multipart/form-data` | 400 | `Bad Request` |
| Credentials not set, in production | 503 | `Service Unavailable: webhook not configured` |

A rejected sender gets a 202, not an error, so SendGrid treats the email as delivered and doesn't retry it.

Checks run in this order: size limit, Basic Auth, signature, parse, allowlist. A request gets the response for the first check it fails, and no field of the email is read until the signature has passed.

## CLI

```bash
bun src/cli.ts tail [-n 20]              # recent emails
bun src/cli.ts show <id>                 # one email, including its body
bun src/cli.ts purge --older-than 30     # clear personal data from emails older than N days
```

With Docker, run them inside the running container, as the `bun` user: `docker compose exec -T -u bun api bun src/cli.ts purge --older-than 30`. Don't start a second container or open the database from the host: SQLite only stays consistent when one process at a time uses it.

Purging clears the sender, recipient, subject, body, and any ID returned by a forward, and deletes the attachment folder. It keeps the row, marked `purged`, as a record that the email arrived.

## Development

```bash
bun install
bun test            # unit and HTTP tests; no network or SendGrid needed
bun run typecheck
bun run dev         # server with reload on http://localhost:3000
```

## Security notes

- **Turn on signed webhooks.** With `SENDGRID_INBOUND_VERIFICATION_KEY` set, the receiver checks SendGrid's ECDSA signature over the exact raw request bytes before it parses anything, so it only accepts requests SendGrid signed. The signature doesn't cover the `Content-Type` header, so the receiver takes the multipart boundary from the signed body instead of the header. Basic Auth stays on as a second layer, so keep using a long random password. Without the key, Basic Auth is the only check, and anyone who learns the URL and password can post. [`docs/DEPLOY.md`](docs/DEPLOY.md#5-turn-on-signed-webhooks) explains how to turn signing on.
- **Replays are limited, not prevented.** A signed request replayed within the timestamp window (5 minutes by default) is accepted again. SendGrid doesn't specify a window, so the 5 minutes is our choice. Keep the server's clock synced: if it drifts past the window, real mail gets rejected.
- **Don't count on a 401 being retried.** SendGrid documents retries for 5xx responses only, so assume an email rejected with a 401 is lost. If the key is wrong, every email is rejected that way, so send a real test email right after you set the key.
- **The sender allowlist trusts the `From` header.** It keeps out casual mail but can be spoofed.
- **Treat everything in an email as untrusted input,** including the body, HTML, and attachments. This receiver stores them and never renders or runs them. Anything downstream should do the same.
- **Inbound email contains personal data.** Schedule `purge`, and keep `.env` and any local `data/` folder out of version control. The provided `.gitignore` already does this.

## License

[MIT](LICENSE) © Elmer Thomas
