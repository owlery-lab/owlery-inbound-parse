import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb } from "@/core/db/index.js";
import { logger } from "@/shared/logger.js";
import { config } from "@/shared/config.js";
import type { InboundEmail } from "@/shared/types.js";

export interface InboundEmailInput {
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  sender_domain: string | null;
}

export interface InboundAttachment {
  filename: string;
  bytes: ArrayBuffer;
}

function attachmentsRoot(): string {
  const dir = config.INBOUND_ATTACHMENTS_DIR;
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}

// Filesystems cap a single name at 255 bytes. Stay well under that, keeping a
// short extension when there is one.
const MAX_FILENAME_LENGTH = 100;

/** Turns an untrusted attachment filename into a safe, bounded name: only word characters, dots, and dashes, and at most MAX_FILENAME_LENGTH characters. */
export function safeAttachmentName(filename: string): string {
  const cleaned = filename.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "") || "attachment";
  if (cleaned.length <= MAX_FILENAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

/** Persists a parsed inbound email plus attachments. Attachments land under `${INBOUND_ATTACHMENTS_DIR}/<uuid>/`. If anything fails, the attachment folder is removed so no email data is left on disk without a row pointing at it. */
export async function recordInboundEmail(
  input: InboundEmailInput,
  attachments: InboundAttachment[]
): Promise<InboundEmail> {
  const db = getDb();

  let attachmentsDir: string | null = null;
  try {
    if (attachments.length > 0) {
      const root = attachmentsRoot();
      if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
      attachmentsDir = join(root, randomUUID());
      mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });

      const padLen = String(attachments.length).length;
      let i = 0;
      for (const att of attachments) {
        i++;
        const idx = String(i).padStart(padLen, "0");
        await Bun.write(join(attachmentsDir, `${idx}-${safeAttachmentName(att.filename)}`), att.bytes);
      }
    }

    const insert = db.prepare(
      `INSERT INTO inbound_emails
         (from_addr, to_addr, subject, body_text, sender_domain, num_attachments, attachments_dir, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'received')
       RETURNING *`
    );

    const row = insert.get(
      input.from_addr,
      input.to_addr,
      input.subject,
      input.body_text,
      input.sender_domain,
      attachments.length,
      attachmentsDir
    ) as InboundEmail;

    logger.info("Inbound email recorded", { id: row.id, num_attachments: attachments.length });
    return row;
  } catch (err) {
    if (attachmentsDir) rmSync(attachmentsDir, { recursive: true, force: true });
    throw err;
  }
}

export function listInboundEmails(limit = 20): InboundEmail[] {
  const db = getDb();
  const rows = db
    .query<InboundEmail, [number]>(
      "SELECT * FROM inbound_emails ORDER BY received_at DESC LIMIT ?"
    )
    .all(limit);
  return rows;
}

export function getInboundEmail(id: number): InboundEmail | null {
  const db = getDb();
  return db
    .query<InboundEmail, [number]>("SELECT * FROM inbound_emails WHERE id = ?")
    .get(id);
}

export interface PurgeResult {
  rowsPurged: number;
  attachmentDirsRemoved: number;
}

export interface ForwardOutcome {
  ok: boolean;
  status: number | null;
  ref: string | null;
  error?: string;
}

export interface ForwardFields {
  from: string | null;
  to: string | null;
  subject: string | null;
  text: string | null;
  envelope: string | null;
}

const FORWARD_TIMEOUT_MS = 5000;

/** Forwards parsed email fields to a Twilio Function as application/x-www-form-urlencoded with a Bearer token. Returns outcome without throwing — the caller records it as action metadata. Bounded by FORWARD_TIMEOUT_MS covering both request and response-body read so a stalled downstream can't hold the SendGrid webhook open past its retry window. Twilio Serverless does not parse multipart, so this url-encoded proxy is required to reach a Function from SendGrid Inbound Parse. */
export async function forwardToTwilioFunction(
  url: string,
  token: string,
  fields: ForwardFields,
  fetchImpl: typeof fetch = fetch
): Promise<ForwardOutcome> {
  const form = new URLSearchParams();
  if (fields.from) form.set("from", fields.from);
  if (fields.to) form.set("to", fields.to);
  if (fields.subject) form.set("subject", fields.subject);
  if (fields.text) form.set("text", fields.text);
  if (fields.envelope) form.set("envelope", fields.envelope);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${token}`,
      },
      body: form.toString(),
      signal: controller.signal,
    });
    let ref: string | null = null;
    try {
      const body = (await res.json()) as { key?: string; id?: number };
      ref = body.key ?? (body.id != null ? String(body.id) : null);
    } catch (parseErr) {
      if ((parseErr as Error).name === "AbortError") throw parseErr;
      // non-JSON body is acceptable; leave ref null
    }
    return { ok: res.ok, status: res.status, ref };
  } catch (err) {
    const error = err as Error;
    const isAbort = error.name === "AbortError";
    return { ok: false, status: null, ref: null, error: isAbort ? `timeout_after_${FORWARD_TIMEOUT_MS}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Records what happened when the email was forwarded. The status only moves to 'acted' when the forward succeeded; a failed forward keeps 'received' and says why in action_taken. */
export function recordAction(id: number, actionTaken: string, actionRef: string | null, succeeded: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE inbound_emails
       SET action_taken = ?,
           action_ref = ?,
           status = CASE WHEN ? THEN 'acted' ELSE status END
     WHERE id = ?`
  ).run(actionTaken, actionRef, succeeded ? 1 : 0, id);
}

/** Nulls personal-data columns (including action_ref, which can hold an ID returned by the downstream service) and removes attachment directories for emails older than `olderThanDays`. Rows are kept (with status='purged') as an audit trail. */
export function purgeInboundEmails(olderThanDays: number): PurgeResult {
  if (olderThanDays < 0) throw new Error("olderThanDays must be >= 0");

  const db = getDb();
  const rows = db
    .query<InboundEmail, [string]>(
      `SELECT * FROM inbound_emails
       WHERE status != 'purged'
         AND received_at < datetime('now', ?)`
    )
    .all(`-${olderThanDays} days`);

  let dirsRemoved = 0;
  for (const row of rows) {
    if (row.attachments_dir && existsSync(row.attachments_dir)) {
      try {
        rmSync(row.attachments_dir, { recursive: true, force: true });
        dirsRemoved++;
      } catch (err) {
        logger.warn("Failed to remove attachments dir", { id: row.id, dir: row.attachments_dir, err: (err as Error).message });
      }
    }
  }

  const update = db.prepare(
    `UPDATE inbound_emails
       SET from_addr = NULL,
           to_addr = NULL,
           subject = NULL,
           body_text = NULL,
           sender_domain = NULL,
           attachments_dir = NULL,
           action_ref = NULL,
           status = 'purged',
           purged_at = datetime('now')
     WHERE status != 'purged'
       AND received_at < datetime('now', ?)`
  );
  const result = update.run(`-${olderThanDays} days`);

  logger.info("Inbound emails purged", { rows: result.changes, dirsRemoved });
  return { rowsPurged: Number(result.changes), attachmentDirsRemoved: dirsRemoved };
}
