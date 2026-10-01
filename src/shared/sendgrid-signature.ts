import { createPublicKey, createVerify, type KeyObject } from "node:crypto";

// SendGrid uses the Event Webhook's header names for signed Inbound Parse requests.
export const SIGNATURE_HEADER = "X-Twilio-Email-Event-Webhook-Signature";
export const TIMESTAMP_HEADER = "X-Twilio-Email-Event-Webhook-Timestamp";

export type SignatureFailure = "missing" | "bad signature" | "stale timestamp";
export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PEM_PUBLIC_KEY = "-----BEGIN PUBLIC KEY-----";

/**
 * Parses SendGrid's verification key. SendGrid shows it as base64 SPKI DER; a
 * PEM "PUBLIC KEY" block also works, including one with literal `\n` escapes
 * (handy in a one-line .env). Throws unless it's an ECDSA P-256 public key.
 */
export function parseVerificationKey(value: string): KeyObject {
  const trimmed = value.trim().replace(/\\n/g, "\n");
  let key: KeyObject;
  try {
    if (trimmed.startsWith(PEM_PUBLIC_KEY)) {
      key = createPublicKey({ key: trimmed, format: "pem" });
    } else if (trimmed.startsWith("-----")) {
      // Refuse private keys and certificates instead of deriving a public key from them.
      throw new Error("unsupported PEM block");
    } else {
      const compact = trimmed.replace(/\s+/g, "");
      if (!BASE64.test(compact)) throw new Error("not base64");
      key = createPublicKey({ key: Buffer.from(compact, "base64"), format: "der", type: "spki" });
    }
  } catch {
    throw new Error("SENDGRID_INBOUND_VERIFICATION_KEY is not a valid public key (expected base64 SPKI DER or a PEM PUBLIC KEY block)");
  }

  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("SENDGRID_INBOUND_VERIFICATION_KEY must be an ECDSA P-256 public key");
  }
  return key;
}

export interface SignatureCheck {
  key: KeyObject;
  signature: string | undefined;
  timestamp: string | undefined;
  /** The raw request body, exactly as received. */
  body: Uint8Array;
  toleranceSeconds: number;
  nowMs?: number;
}

/**
 * Checks a signed SendGrid request: an ECDSA P-256 signature (base64 DER) over
 * SHA-256 of the timestamp header's bytes followed by the raw body, with no
 * separator. The signature is checked before the timestamp, so "stale
 * timestamp" only ever describes a request SendGrid really signed.
 */
export function verifySendGridSignature(check: SignatureCheck): SignatureResult {
  const { signature, timestamp } = check;
  if (!signature || !timestamp) return { ok: false, reason: "missing" };
  if (!BASE64.test(signature)) return { ok: false, reason: "bad signature" };

  let valid = false;
  try {
    valid = createVerify("sha256")
      .update(Buffer.from(timestamp, "utf-8"))
      .update(check.body)
      .verify({ key: check.key, dsaEncoding: "der" }, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad signature" };

  // Unix seconds. Checked in both directions, so a clock running ahead fails too.
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: "stale timestamp" };
  const skewSeconds = Math.abs((check.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (skewSeconds > check.toleranceSeconds) return { ok: false, reason: "stale timestamp" };

  return { ok: true };
}

// RFC 2046 boundary: 1-70 characters from this set, not ending in a space.
const BOUNDARY = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;

/**
 * The signature covers the body but not the Content-Type header, and the
 * header's boundary decides how the body splits into fields. So instead of
 * trusting the header, take the boundary from the body's first line, which is
 * signed. Returns a Content-Type to parse the body with, or null if the header
 * isn't multipart/form-data or the body doesn't start with a boundary line.
 */
export function signedMultipartContentType(contentType: string | undefined, body: Uint8Array): string | null {
  if (contentType?.split(";")[0]?.trim().toLowerCase() !== "multipart/form-data") return null;
  const head = new TextDecoder().decode(body.subarray(0, 80));
  const end = head.indexOf("\r\n");
  if (!head.startsWith("--") || end < 0) return null;
  const boundary = head.slice(2, end);
  if (!BOUNDARY.test(boundary)) return null;
  return `multipart/form-data; boundary="${boundary}"`;
}
