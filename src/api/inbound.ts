import { Hono, type Context } from "hono";
import { parseBody } from "hono/utils/body";
import { logger } from "@/shared/logger.js";
import { config, type Config } from "@/shared/config.js";
import { basicAuth } from "@/shared/webhook-auth.js";
import {
  parseVerificationKey,
  verifySendGridSignature,
  signedMultipartContentType,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "@/shared/sendgrid-signature.js";
import { recordInboundEmail, forwardToTwilioFunction, recordAction, type InboundAttachment } from "@/routines/inbound.js";

function extractDomain(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const trimmed = addr.slice(at + 1).trim().toLowerCase();
  const angleClosed = trimmed.replace(/>$/, "");
  return angleClosed || null;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function tooLarge(c: Context, maxBytes: number): Response {
  logger.warn("Inbound request rejected: body too large", { maxBytes });
  return c.text("Payload Too Large", 413);
}

class BodyTooLarge extends Error {}

/**
 * Swaps the request body for one that errors with BodyTooLarge as soon as more
 * than maxBytes have been read, whatever Content-Length says. Nothing is read
 * here, so a request that fails Basic Auth is never buffered.
 */
function limitBody(c: Context, maxBytes: number): void {
  const body = c.req.raw.body;
  if (!body) return;
  let seen = 0;
  const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) controller.error(new BodyTooLarge());
      else controller.enqueue(chunk);
    },
  }));
  c.req.raw = new Request(c.req.raw, { body: counted, duplex: "half" });
}

export type InboundOptions = Pick<
  Config,
  | "NODE_ENV"
  | "SENDGRID_INBOUND_BASIC_AUTH_USER"
  | "SENDGRID_INBOUND_BASIC_AUTH_PASS"
  | "SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS"
  | "SENDGRID_INBOUND_VERIFICATION_KEY"
  | "SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS"
  | "INBOUND_MAX_BODY_BYTES"
>;

/**
 * Builds the `/sendgrid/inbound` route. Checks run in this order: size limit,
 * Basic Auth, signature, parse, allowlist. Options default to `config`; tests
 * override them.
 */
export function createInbound(overrides: Partial<InboundOptions> = {}): Hono {
  const opts: InboundOptions = { ...config, ...overrides };
  const inbound = new Hono();

  // Throws at startup on a malformed key, so a typo can't quietly turn checks off.
  const verificationKey = opts.SENDGRID_INBOUND_VERIFICATION_KEY
    ? parseVerificationKey(opts.SENDGRID_INBOUND_VERIFICATION_KEY)
    : null;
  if (!verificationKey && opts.NODE_ENV === "production") {
    logger.warn("SENDGRID_INBOUND_VERIFICATION_KEY not set; SendGrid request signatures are NOT verified (Basic Auth only)");
  }

  // 1. Size limit. A declared Content-Length over the limit is refused before
  // anything else. Every other body is counted as it's read, and nothing reads
  // it until Basic Auth has passed.
  inbound.use("*", async (c, next) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > opts.INBOUND_MAX_BODY_BYTES) {
      return tooLarge(c, opts.INBOUND_MAX_BODY_BYTES);
    }
    limitBody(c, opts.INBOUND_MAX_BODY_BYTES);
    await next();
  });

  // 2. Basic Auth.
  if (opts.SENDGRID_INBOUND_BASIC_AUTH_USER && opts.SENDGRID_INBOUND_BASIC_AUTH_PASS) {
    inbound.use("*", basicAuth({
      user: opts.SENDGRID_INBOUND_BASIC_AUTH_USER,
      pass: opts.SENDGRID_INBOUND_BASIC_AUTH_PASS,
    }));
  } else if (opts.NODE_ENV === "production") {
    logger.error("SendGrid Inbound Parse credentials missing in production; refusing all requests");
    inbound.use("*", async (c) => c.text("Service Unavailable: webhook not configured", 503));
  } else {
    logger.warn("SendGrid Inbound Parse route mounted WITHOUT basic-auth (development mode; set SENDGRID_INBOUND_BASIC_AUTH_USER/PASS to enable)");
  }

  inbound.post("/", async (c) => {
    // 3. Signature. Read the exact raw bytes once, verify them, and parse those
    // same bytes below. Nothing is parsed or trusted before this check.
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await c.req.arrayBuffer());
    } catch (err) {
      if (err instanceof BodyTooLarge) return tooLarge(c, opts.INBOUND_MAX_BODY_BYTES);
      logger.warn("Failed to read inbound request body", { err: (err as Error).message });
      return c.text("Bad Request", 400);
    }

    if (verificationKey) {
      const result = verifySendGridSignature({
        key: verificationKey,
        signature: c.req.header(SIGNATURE_HEADER),
        timestamp: c.req.header(TIMESTAMP_HEADER),
        body: raw,
        toleranceSeconds: opts.SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS,
      });
      if (!result.ok) {
        logger.warn("Inbound request rejected: signature check failed", { reason: result.reason, bytes: raw.byteLength });
        return c.text("Unauthorized", 401);
      }
    }

    // 4. Parse. Content-Type isn't signed, so when signatures are checked the
    // multipart boundary comes from the signed body instead of the header.
    let contentType = c.req.header("content-type") ?? "";
    if (verificationKey) {
      const signedType = signedMultipartContentType(contentType, raw);
      if (!signedType) {
        logger.warn("Inbound request rejected: signed body isn't multipart/form-data", { bytes: raw.byteLength });
        return c.text("Bad Request", 400);
      }
      contentType = signedType;
    }

    let body: Record<string, string | File | (string | File)[]>;
    try {
      body = await parseBody(
        new Request(c.req.url, { method: "POST", headers: { "content-type": contentType }, body: raw }),
        { all: true }
      );
    } catch (err) {
      logger.warn("Failed to parse inbound multipart body", { err: (err as Error).message });
      return c.text("Bad Request", 400);
    }

    const from = firstString(body.from);
    const to = firstString(body.to);
    const subject = firstString(body.subject);
    const text = firstString(body.text);
    const html = firstString(body.html);

    // 5. Allowlist.
    const senderDomain = extractDomain(from);
    const allowed = opts.SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS;

    if (allowed.length > 0) {
      if (!senderDomain || !allowed.includes(senderDomain)) {
        logger.warn("Inbound email rejected: sender domain not allowlisted", { senderDomain });
        return c.json({ ok: false, reason: "sender_domain_not_allowed" }, 202);
      }
    }

    const attachments: InboundAttachment[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (!key.startsWith("attachment")) continue;
      const files = Array.isArray(value) ? value : [value];
      for (const f of files) {
        if (f instanceof File) {
          attachments.push({ filename: f.name || key, bytes: await f.arrayBuffer() });
        }
      }
    }

    const record = await recordInboundEmail(
      {
        from_addr: from,
        to_addr: to,
        subject,
        body_text: text ?? html,
        sender_domain: senderDomain,
      },
      attachments
    );

    const forwardUrl = process.env.TWILIO_FUNCTION_INBOUND_URL || config.TWILIO_FUNCTION_INBOUND_URL;
    const forwardToken = process.env.TWILIO_FUNCTION_INBOUND_TOKEN || config.TWILIO_FUNCTION_INBOUND_TOKEN;
    if (forwardUrl && forwardToken) {
      const envelope = firstString(body.envelope);
      const outcome = await forwardToTwilioFunction(
        forwardUrl,
        forwardToken,
        { from, to, subject, text: text ?? html, envelope }
      );
      const actionTaken = outcome.ok ? "twilio_function_forwarded" : `twilio_function_forward_failed:${outcome.status ?? "network_error"}`;
      recordAction(record.id, actionTaken, outcome.ref, outcome.ok);
      if (!outcome.ok) {
        logger.warn("Twilio Function forward failed", { id: record.id, status: outcome.status, error: outcome.error });
      }
    }

    return c.json({ ok: true, id: record.id, num_attachments: attachments.length });
  });

  return inbound;
}

const inbound = createInbound();

export default inbound;
