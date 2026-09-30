import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { logger } from "@/shared/logger.js";

export interface BasicAuthCredentials {
  user: string;
  pass: string;
}

function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | null {
  if (!header) return null;
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    return null;
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

// Hashing both sides first gives equal-length inputs, so the comparison takes
// the same time whatever the lengths are.
function safeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf-8").digest();
  const digestB = createHash("sha256").update(b, "utf-8").digest();
  return timingSafeEqual(digestA, digestB);
}

/** Hono middleware enforcing HTTP Basic Auth against the given expected credentials. Constant-time comparison. */
export function basicAuth(expected: BasicAuthCredentials): MiddlewareHandler {
  return async (c, next) => {
    const provided = parseBasicAuthHeader(c.req.header("authorization"));

    // Check both fields every time so a wrong username takes as long as a wrong password.
    const userOk = safeEqual(provided?.user ?? "", expected.user);
    const passOk = safeEqual(provided?.pass ?? "", expected.pass);

    if (!provided || !userOk || !passOk) {
      logger.warn("Webhook auth rejected", { path: c.req.path });
      return c.text("Unauthorized", 401, {
        "WWW-Authenticate": 'Basic realm="owlery-inbound-parse"',
      });
    }

    await next();
  };
}
