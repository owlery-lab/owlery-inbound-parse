import { z } from "zod";
import { existsSync, openSync, fchmodSync, closeSync, readFileSync, fstatSync, constants } from "node:fs";
import { parse as parseDotenv } from "dotenv";

if (existsSync(".env")) {
  let fd: number;
  try {
    fd = openSync(".env", constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    throw new Error(`SECURITY: Failed to open .env (possibly a symlink): ${(err as Error).message}`);
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("SECURITY: .env is not a regular file.");
    }

    if ((stat.mode & 0o077) !== 0) {
      try {
        fchmodSync(fd, 0o600);
      } catch (err) {
        if (process.env.NODE_ENV === "test") {
          // Silently ignore EPERM in read-only test environments
        } else {
          throw new Error(`SECURITY: Cannot secure .env permissions: ${(err as Error).message}`);
        }
      }
    }

    const content = readFileSync(fd, "utf-8");
    const parsed = parseDotenv(content);

    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } finally {
    closeSync(fd);
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DB_PATH: z.string().default("./data/owlery-inbound.db"),
  SENDGRID_INBOUND_BASIC_AUTH_USER: z.string().min(1).optional(),
  SENDGRID_INBOUND_BASIC_AUTH_PASS: z.string().min(1).optional(),
  SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS: z.string()
    .transform((s) => s.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Invalid domain")))
    .default(""),
  INBOUND_ATTACHMENTS_DIR: z.string().default("./data/inbound-parse"),
  // SendGrid rejects messages over 30 MB, so 32 MB leaves room for multipart
  // overhead while stopping oversized requests before they're read into memory.
  INBOUND_MAX_BODY_BYTES: z.coerce.number().int().positive().default(32 * 1024 * 1024),
  // SendGrid's public key from the Parse security policy. When set, every
  // request needs a valid signature. Empty counts as unset.
  SENDGRID_INBOUND_VERIFICATION_KEY: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().optional()
  ),
  // SendGrid doesn't publish a replay window; 5 minutes is our own choice.
  SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  TWILIO_FUNCTION_INBOUND_URL: z.string().url().optional(),
  TWILIO_FUNCTION_INBOUND_TOKEN: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export const config = envSchema.parse(process.env);
