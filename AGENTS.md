# AGENTS.md

Notes for AI coding agents (and humans) working in this repo. Read [`README.md`](README.md) first for what the project does.

## What this is

A single-purpose HTTP service. It receives SendGrid Inbound Parse webhooks, saves each email to SQLite (attachments go to disk), and can forward the parsed email to one downstream URL. Keep it small: new behavior usually belongs in the downstream service, not here.

## Stack

- **Runtime:** [Bun](https://bun.sh) 1.3+, running TypeScript directly. There's no build step.
- **HTTP:** [Hono](https://hono.dev).
- **Database:** `bun:sqlite`.
- **Config validation:** Zod.
- **CLI:** Commander.
- **Tests:** `bun:test`.
- **Deploy:** Docker (`oven/bun:1.3-alpine`).

## Layout

| Path | Purpose |
|---|---|
| `src/api/server.ts` | Entry point. Mounts routes, runs migrations, starts `Bun.serve`. |
| `src/api/inbound.ts` | `POST /sendgrid/inbound`: size limit, Basic Auth, signature, parsing, allowlist, save, optional forward. `createInbound(overrides)` builds the route; the default export uses `config`. |
| `src/routines/inbound.ts` | Database and filesystem work: record, list, show, purge, forward. |
| `src/shared/config.ts` | Loads `.env` with safety checks, then validates env vars with Zod. |
| `src/shared/webhook-auth.ts` | Basic Auth middleware with a constant-time comparison. |
| `src/shared/sendgrid-signature.ts` | Parses SendGrid's verification key and checks the ECDSA P-256 signature and timestamp window, using `node:crypto`. |
| `src/shared/logger.ts` | JSON logger. Set to `error` level under tests. |
| `src/core/db/index.ts` | SQLite connection, permission checks, and migration runner. |
| `src/core/db/migrations/` | Numbered SQL migrations. |
| `src/cli.ts` | `tail`, `show`, and `purge` commands. |
| `scripts/sendgrid-signing.sh` | Turns signed webhooks on or off through the SendGrid API, optionally sets the key in `.env` and recreates the container, and summarizes the logs. Bash 3.2 compatible (macOS). Waits for the `SendGrid signature verification enabled` and `SENDGRID_INBOUND_VERIFICATION_KEY not set` startup lines, so keep those messages in step with it. Never prints the Parse setting's `url`, which has the Basic Auth password. |
| `tests/` | Mirrors `src/`. `tests/setup.ts` sets test env vars. |
| `docs/` | `SETUP-MAC-MINI.md` (step by step) and `DEPLOY.md` (any host). |

## Commands

```bash
bun install
bun test
bun run typecheck
bun run dev                     # http://localhost:3000
docker compose up -d --build    # production-like run
```

Run `bun test` and `bun run typecheck` before you finish any change. The Docker build also runs the typecheck.

## Conventions

- **Imports:** use the `@/` alias for `src/` (for example `@/shared/logger.js`). Include the `.js` extension.
- **`server.ts` must not have a default export.** If the default export has a `fetch` method, Bun starts a second server on the same port. Export `{ app }` instead.
- **Migrations:** add a new numbered file in `src/core/db/migrations/`, **and** add its filename to the `migrationFiles` array in `src/core/db/index.ts`. The runner doesn't find files on its own.
- **Personal data:** any new column that holds email content, or anything that could identify a person (like `action_ref`), must also be cleared by `purgeInboundEmails` in `src/routines/inbound.ts`.
- **Attachments:** name files through `safeAttachmentName`. If saving fails partway, `recordInboundEmail` removes the attachment folder, so nothing is left on disk without a row.
- **Forwarding:** the forwarder never throws. It returns an outcome, and the handler records it on the row. Only a successful forward sets the status to `acted`. Keep it bounded by `FORWARD_TIMEOUT_MS`, and don't let a failed forward change the response SendGrid gets.
- **Check order on `/sendgrid/inbound`:** size limit, Basic Auth, signature, parse, allowlist. Keep it that way: the size limit comes first so no one can make the server buffer a huge body, and the signature comes before parsing so nothing is parsed or trusted until it's proven to come from SendGrid.
- **Verify raw bytes before parsing.** SendGrid signs the exact request bytes: `SHA-256(timestamp + raw body)`, with no separator. Read them once with `c.req.arrayBuffer()`, verify them, and only then parse those same bytes. Don't re-serialize, decode, or trim the body before verifying, and never log email content on a failed check, only the reason and the byte count.
- **Don't trust unsigned headers to interpret signed bytes.** The signature doesn't cover `Content-Type`, and its multipart boundary decides which bytes become which field. When a key is set, the route takes the boundary from the signed body's first line (`signedMultipartContentType`) and rejects anything that isn't `multipart/form-data`.
- **The size limit counts bytes as they're read.** `limitBody` wraps the request stream before Basic Auth runs but doesn't read it, so an unauthenticated request is never buffered, and a body without `Content-Length` still can't go past `INBOUND_MAX_BODY_BYTES`.
- **Tests:** HTTP tests call `inbound.fetch(new Request(...))` with `FormData`. Use `createInbound({...})` to override settings, such as the verification key, without touching `process.env`. Signature tests generate their own P-256 key pair and sign real multipart bytes. The forwarder takes an injected `fetch` for tests. Tests must not use the network.

## Guardrails

- **Never commit secrets or real data.** `.env`, `data/`, and databases are gitignored. Keep them that way.
- **Don't log email content.** Log IDs, counts, and sender domains. Don't log addresses, subjects, bodies, or attachments.
- **Treat every email field and attachment as untrusted.** Don't render, run, or pass it into prompts without isolating it.
- **Don't weaken these safety checks:** the `.env` symlink and permission checks in `config.ts`, the database directory symlink checks and `0700`/`0600` permissions in `core/db/index.ts`, the 503 when credentials are missing in production, the constant-time credential comparison, the signature check when `SENDGRID_INBOUND_VERIFICATION_KEY` is set (including failing at startup on a malformed key), and the request-size limit (`INBOUND_MAX_BODY_BYTES`, enforced both by the route and by `Bun.serve`).
- **The receiver in Docker runs as `bun`, not root.** `scripts/docker-entrypoint.sh` fixes ownership of `/data` (a fixed path, on purpose) and then switches users. Any new container command should go through that entrypoint.
- **Only one process may open the live database.** Run CLI commands inside the running container with `docker compose exec -T -u bun api bun src/cli.ts ...`. Never open `/data/owlery-inbound.db` from a second container, from the host, or with the `sqlite3` tool while the server is running, and never delete its `-wal` or `-shm` files. Doing any of these once made the server keep writing to deleted files, so emails it reported as saved were lost.
- **Keep `/data` on a Docker named volume** (`owlery-data` in `docker-compose.yml`). Don't switch it back to a folder shared from the host. SQLite's file locking doesn't work reliably across Docker Desktop's macOS and Windows folder sharing.

## Known limitations

- Signature checks are optional. Without `SENDGRID_INBOUND_VERIFICATION_KEY`, only Basic Auth checks that a request came from SendGrid.
- A signed request replayed within the timestamp window (`SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS`, 5 minutes by default) is accepted again. SendGrid doesn't specify a window, so ours is a choice, not a SendGrid requirement.
- SendGrid's docs show signing with `send_raw: true`. They don't say outright that parsed mode, which this receiver uses, is signed the same way. The real-email test in `docs/DEPLOY.md` is the proof.
- `to` is stored exactly as SendGrid sends it, which may list several addresses separated by commas. If the field appears more than once, only the first copy is kept.
- A request up to `INBOUND_MAX_BODY_BYTES` (32 MB by default) is read into memory in full.
- The forwarder doesn't retry.
