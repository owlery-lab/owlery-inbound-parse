import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "@/shared/logger.js";
import { config } from "@/shared/config.js";
import { basicAuth } from "@/shared/webhook-auth.js";
import { recordInboundEmail, forwardToTwilioFunction, recordAction, type InboundAttachment } from "@/routines/inbound.js";

const inbound = new Hono();

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

if (config.SENDGRID_INBOUND_BASIC_AUTH_USER && config.SENDGRID_INBOUND_BASIC_AUTH_PASS) {
  inbound.use("*", basicAuth({
    user: config.SENDGRID_INBOUND_BASIC_AUTH_USER,
    pass: config.SENDGRID_INBOUND_BASIC_AUTH_PASS,
  }));
} else if (config.NODE_ENV === "production") {
  logger.error("SendGrid Inbound Parse credentials missing in production; refusing all requests");
  inbound.use("*", async (c) => c.text("Service Unavailable: webhook not configured", 503));
} else {
  logger.warn("SendGrid Inbound Parse route mounted WITHOUT basic-auth (development mode; set SENDGRID_INBOUND_BASIC_AUTH_USER/PASS to enable)");
}

// Runs after auth, so unauthenticated callers can't make the server buffer a large body.
inbound.use("*", bodyLimit({
  maxSize: config.INBOUND_MAX_BODY_BYTES,
  onError: (c) => {
    logger.warn("Inbound request rejected: body too large", { maxBytes: config.INBOUND_MAX_BODY_BYTES });
    return c.text("Payload Too Large", 413);
  },
}));

inbound.post("/", async (c) => {
  let body: Record<string, string | File | (string | File)[]>;
  try {
    body = await c.req.parseBody({ all: true });
  } catch (err) {
    logger.warn("Failed to parse inbound multipart body", { err: (err as Error).message });
    return c.text("Bad Request", 400);
  }

  const from = firstString(body.from);
  const to = firstString(body.to);
  const subject = firstString(body.subject);
  const text = firstString(body.text);
  const html = firstString(body.html);

  const senderDomain = extractDomain(from);
  const allowed = config.SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS;

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

export default inbound;
