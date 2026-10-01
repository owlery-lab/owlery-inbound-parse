import { describe, test, expect, beforeAll, afterAll, afterEach, spyOn } from "bun:test";
import "../setup.js";
import { generateKeyPairSync, createSign, type KeyObject } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInbound } from "@/api/inbound.js";
import { migrate, closeDb } from "@/core/db/index.js";
import { getInboundEmail } from "@/routines/inbound.js";
import { config } from "@/shared/config.js";
import { logger } from "@/shared/logger.js";
import { parseVerificationKey, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@/shared/sendgrid-signature.js";

// A key pair made for this test run, standing in for SendGrid's.
const sendgrid = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeyBase64 = (k: KeyObject) => k.export({ type: "spki", format: "der" }).toString("base64");
const SENDGRID_KEY = publicKeyBase64(sendgrid.publicKey);

beforeAll(() => {
  migrate();
});

afterAll(() => {
  closeDb();
  const dir = resolve(process.cwd(), config.INBOUND_ATTACHMENTS_DIR);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

const warnSpy = spyOn(logger, "warn");
afterEach(() => warnSpy.mockClear());

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Encodes a FormData as a real multipart body, the way SendGrid would send it. */
async function encode(form: FormData): Promise<{ bytes: Uint8Array; contentType: string }> {
  const req = new Request("http://localhost/", { method: "POST", body: form });
  // Read the header first: Bun derives it from the FormData body, and drops it once the body is read.
  const contentType = req.headers.get("content-type")!;
  return { bytes: new Uint8Array(await req.arrayBuffer()), contentType };
}

function sign(privateKey: KeyObject, timestamp: string, bytes: Uint8Array): string {
  return createSign("sha256").update(timestamp).update(bytes).sign(privateKey).toString("base64");
}

function request(bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body: bytes,
  });
}

function emailForm(extra?: (f: FormData) => void): FormData {
  const form = new FormData();
  form.set("from", "alice@example.com");
  form.set("to", "owlery@example.com");
  form.set("subject", "signed hello");
  form.set("text", "signed body");
  extra?.(form);
  return form;
}

function rejectionReasons(): unknown[] {
  return warnSpy.mock.calls
    .filter(([msg]) => msg === "Inbound request rejected: signature check failed")
    .map(([, ctx]) => (ctx as { reason?: unknown }).reason);
}

describe("signed Inbound Parse requests", () => {
  const signed = createInbound({ SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY });

  test("accepts a valid signature over a multipart body with an attachment", async () => {
    const attachment = new Uint8Array([0, 1, 2, 3, 255, 13, 10, 45, 45]);
    const { bytes, contentType } = await encode(
      emailForm((f) => f.set("attachment1", new File([attachment], "photo.png", { type: "image/png" })))
    );
    const ts = nowSeconds();

    const res = await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes),
      [TIMESTAMP_HEADER]: ts,
    }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; num_attachments: number };
    expect(body.num_attachments).toBe(1);
    const row = getInboundEmail(body.id);
    expect(row?.subject).toBe("signed hello");
    const saved = new Uint8Array(await Bun.file(`${row?.attachments_dir}/1-photo.png`).arrayBuffer());
    expect(saved).toEqual(attachment);
  });

  test("accepts the key as a PEM block, including one with \\n escapes", async () => {
    const pem = sendgrid.publicKey.export({ type: "spki", format: "pem" }).toString();
    for (const key of [pem, pem.trim().replace(/\n/g, "\\n")]) {
      const app = createInbound({ SENDGRID_INBOUND_VERIFICATION_KEY: key });
      const { bytes, contentType } = await encode(emailForm());
      const ts = nowSeconds();
      const res = await app.fetch(request(bytes, contentType, {
        [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes),
        [TIMESTAMP_HEADER]: ts,
      }));
      expect(res.status).toBe(200);
    }
  });

  test("rejects a tampered body", async () => {
    const { bytes, contentType } = await encode(emailForm());
    const ts = nowSeconds();
    const signature = sign(sendgrid.privateKey, ts, bytes);

    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(bytes).replace("signed body", "forged body")
    );
    expect(tampered.byteLength).toBe(bytes.byteLength);

    const res = await signed.fetch(request(tampered, contentType, {
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: ts,
    }));
    expect(res.status).toBe(401);
    expect(rejectionReasons()).toEqual(["bad signature"]);
  });

  test("rejects a signature made with a different key", async () => {
    const { bytes, contentType } = await encode(emailForm());
    const ts = nowSeconds();
    const res = await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: sign(other.privateKey, ts, bytes),
      [TIMESTAMP_HEADER]: ts,
    }));
    expect(res.status).toBe(401);
    expect(rejectionReasons()).toEqual(["bad signature"]);
  });

  test("rejects a signature whose timestamp header was changed", async () => {
    const { bytes, contentType } = await encode(emailForm());
    const ts = nowSeconds();
    const res = await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes),
      [TIMESTAMP_HEADER]: String(Number(ts) + 1),
    }));
    expect(res.status).toBe(401);
    expect(rejectionReasons()).toEqual(["bad signature"]);
  });

  test("rejects garbage in the signature header", async () => {
    const { bytes, contentType } = await encode(emailForm());
    const res = await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: "not base64 at all!",
      [TIMESTAMP_HEADER]: nowSeconds(),
    }));
    expect(res.status).toBe(401);
    expect(rejectionReasons()).toEqual(["bad signature"]);
  });

  test("rejects missing headers", async () => {
    const { bytes, contentType } = await encode(emailForm());
    const ts = nowSeconds();
    const signature = sign(sendgrid.privateKey, ts, bytes);

    const cases: Record<string, string>[] = [
      {},
      { [TIMESTAMP_HEADER]: ts },
      { [SIGNATURE_HEADER]: signature },
    ];
    for (const headers of cases) {
      const res = await signed.fetch(request(bytes, contentType, headers));
      expect(res.status).toBe(401);
    }
    expect(rejectionReasons()).toEqual(["missing", "missing", "missing"]);
  });

  test("rejects a validly signed request with a stale or future timestamp", async () => {
    const tolerance = config.SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS;
    const { bytes, contentType } = await encode(emailForm());
    for (const offset of [-(tolerance + 60), tolerance + 60]) {
      const ts = String(Math.floor(Date.now() / 1000) + offset);
      const res = await signed.fetch(request(bytes, contentType, {
        [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes),
        [TIMESTAMP_HEADER]: ts,
      }));
      expect(res.status).toBe(401);
    }
    expect(rejectionReasons()).toEqual(["stale timestamp", "stale timestamp"]);
  });

  test("the replay window is configurable", async () => {
    const strict = createInbound({
      SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY,
      SENDGRID_INBOUND_SIGNATURE_TOLERANCE_SECONDS: 10,
    });
    const { bytes, contentType } = await encode(emailForm());
    const ts = String(Math.floor(Date.now() / 1000) - 60);
    const headers = { [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes), [TIMESTAMP_HEADER]: ts };

    expect((await strict.fetch(request(bytes, contentType, headers))).status).toBe(401);
    expect((await signed.fetch(request(bytes, contentType, headers))).status).toBe(200);
  });

  test("never logs email content when rejecting", async () => {
    const { bytes, contentType } = await encode(emailForm());
    await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: sign(other.privateKey, nowSeconds(), bytes),
      [TIMESTAMP_HEADER]: nowSeconds(),
    }));
    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).toContain("bad signature");
    for (const secret of ["alice@example.com", "owlery@example.com", "signed hello", "signed body"]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("checks the signature before the allowlist", async () => {
    const { bytes, contentType } = await encode(emailForm((f) => f.set("from", "stranger@example.org")));
    const unsigned = await signed.fetch(request(bytes, contentType));
    expect(unsigned.status).toBe(401);

    const ts = nowSeconds();
    const ok = await signed.fetch(request(bytes, contentType, {
      [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes),
      [TIMESTAMP_HEADER]: ts,
    }));
    expect(ok.status).toBe(202);
  });

  test("checks the signature before parsing", async () => {
    const garbage = new TextEncoder().encode("this is not multipart");
    const contentType = "multipart/form-data; boundary=nothing-here";
    const unsigned = await signed.fetch(request(garbage, contentType));
    expect(unsigned.status).toBe(401);

    const ts = nowSeconds();
    const res = await signed.fetch(request(garbage, contentType, {
      [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, garbage),
      [TIMESTAMP_HEADER]: ts,
    }));
    expect(res.status).toBe(400);
  });

  test("checks Basic Auth before the signature, and the size limit before both", async () => {
    const guarded = createInbound({
      SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY,
      SENDGRID_INBOUND_BASIC_AUTH_USER: "inbound",
      SENDGRID_INBOUND_BASIC_AUTH_PASS: "test-password",
    });
    const { bytes, contentType } = await encode(emailForm());
    const ts = nowSeconds();
    const sigHeaders = { [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes), [TIMESTAMP_HEADER]: ts };
    const auth = { authorization: "Basic " + Buffer.from("inbound:test-password").toString("base64") };

    const noAuth = await guarded.fetch(request(bytes, contentType, sigHeaders));
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get("www-authenticate")).toContain("Basic");
    expect(rejectionReasons()).toEqual([]);

    const authNoSig = await guarded.fetch(request(bytes, contentType, auth));
    expect(authNoSig.status).toBe(401);
    expect(authNoSig.headers.get("www-authenticate")).toBeNull();
    expect(rejectionReasons()).toEqual(["missing"]);

    const both = await guarded.fetch(request(bytes, contentType, { ...auth, ...sigHeaders }));
    expect(both.status).toBe(200);

    const tooBig = new Uint8Array(config.INBOUND_MAX_BODY_BYTES + 1);
    const big = await guarded.fetch(request(tooBig, "application/octet-stream", {
      "content-length": String(tooBig.byteLength),
    }));
    expect(big.status).toBe(413);
  });

  function oversizedStream(): { stream: ReadableStream<Uint8Array>; sent: () => number } {
    const chunk = new Uint8Array(16 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Keeps going well past the limit, so only the receiver can stop it.
        if (sent > config.INBOUND_MAX_BODY_BYTES * 4) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    return { stream, sent: () => sent };
  }

  test("enforces the size limit on a chunked body before reading it for verification", async () => {
    const { stream } = oversizedStream();
    const res = await signed.fetch(new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      duplex: "half",
    }));
    expect(res.status).toBe(413);
  });

  test("an unauthenticated chunked body is refused without being read", async () => {
    const guarded = createInbound({
      SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY,
      SENDGRID_INBOUND_BASIC_AUTH_USER: "inbound",
      SENDGRID_INBOUND_BASIC_AUTH_PASS: "test-password",
    });
    const { stream, sent } = oversizedStream();
    const res = await guarded.fetch(new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      duplex: "half",
    }));
    expect(res.status).toBe(401);
    expect(sent()).toBeLessThan(config.INBOUND_MAX_BODY_BYTES);
  });

  test("an authenticated chunked body over the limit gets a 413", async () => {
    const guarded = createInbound({
      SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY,
      SENDGRID_INBOUND_BASIC_AUTH_USER: "inbound",
      SENDGRID_INBOUND_BASIC_AUTH_PASS: "test-password",
    });
    const { stream } = oversizedStream();
    const res = await guarded.fetch(new Request("http://localhost/", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        authorization: "Basic " + Buffer.from("inbound:test-password").toString("base64"),
      },
      body: stream,
      duplex: "half",
    }));
    expect(res.status).toBe(413);
  });

  test("parses with the boundary from the signed body, not the Content-Type header", async () => {
    // The signed body hides a second, fake set of fields inside the text field,
    // framed by another boundary. Pointing the header at that boundary must not
    // make the fake fields parse.
    const fake = "--evil\r\nContent-Disposition: form-data; name=\"from\"\r\n\r\nmallory@example.org\r\n--evil--";
    const { bytes, contentType } = await encode(emailForm((f) => f.set("text", fake)));
    const ts = nowSeconds();
    const headers = { [SIGNATURE_HEADER]: sign(sendgrid.privateKey, ts, bytes), [TIMESTAMP_HEADER]: ts };

    const swapped = await signed.fetch(request(bytes, "multipart/form-data; boundary=evil", headers));
    expect(swapped.status).toBe(200);
    const row = getInboundEmail(((await swapped.json()) as { id: number }).id);
    expect(row?.from_addr).toBe("alice@example.com");

    const urlencoded = await signed.fetch(request(bytes, "application/x-www-form-urlencoded", headers));
    expect(urlencoded.status).toBe(400);

    // The original header still works.
    expect((await signed.fetch(request(bytes, contentType, headers))).status).toBe(200);
  });
});

describe("when SENDGRID_INBOUND_VERIFICATION_KEY is unset", () => {
  test("accepts unsigned requests as before", async () => {
    const unsigned = createInbound({ SENDGRID_INBOUND_VERIFICATION_KEY: undefined });
    const { bytes, contentType } = await encode(emailForm());
    const res = await unsigned.fetch(request(bytes, contentType));
    expect(res.status).toBe(200);
  });

  test("logs one startup warning in production, none otherwise", () => {
    createInbound({
      NODE_ENV: "production",
      SENDGRID_INBOUND_VERIFICATION_KEY: undefined,
      SENDGRID_INBOUND_BASIC_AUTH_USER: "inbound",
      SENDGRID_INBOUND_BASIC_AUTH_PASS: "test-password",
    });
    const prodWarnings = warnSpy.mock.calls.filter(([msg]) => String(msg).includes("SENDGRID_INBOUND_VERIFICATION_KEY"));
    expect(prodWarnings.length).toBe(1);

    warnSpy.mockClear();
    createInbound({ NODE_ENV: "development", SENDGRID_INBOUND_VERIFICATION_KEY: undefined });
    createInbound({ NODE_ENV: "production", SENDGRID_INBOUND_VERIFICATION_KEY: SENDGRID_KEY,
      SENDGRID_INBOUND_BASIC_AUTH_USER: "inbound", SENDGRID_INBOUND_BASIC_AUTH_PASS: "test-password" });
    expect(warnSpy.mock.calls.filter(([msg]) => String(msg).includes("SENDGRID_INBOUND_VERIFICATION_KEY")).length).toBe(0);
  });
});

describe("parseVerificationKey", () => {
  test("rejects malformed, non-P-256, and private keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const bad = [
      "not-a-key",
      "AAAA",
      publicKeyBase64(rsa.publicKey),
      publicKeyBase64(p384.publicKey),
      sendgrid.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ];
    for (const value of bad) {
      expect(() => parseVerificationKey(value)).toThrow(/SENDGRID_INBOUND_VERIFICATION_KEY/);
    }
  });

  test("a malformed key fails at startup instead of turning checks off", () => {
    expect(() => createInbound({ SENDGRID_INBOUND_VERIFICATION_KEY: "not-a-key" })).toThrow();
  });
});
