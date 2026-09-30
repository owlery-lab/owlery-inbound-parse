import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import "../setup.js";
import { rmSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import inbound from "@/api/inbound.js";
import { migrate, closeDb, getDb } from "@/core/db/index.js";
import { listInboundEmails, getInboundEmail, purgeInboundEmails } from "@/routines/inbound.js";
import { config } from "@/shared/config.js";

beforeAll(() => {
  migrate();
});

afterAll(() => {
  closeDb();
  const dir = resolve(process.cwd(), config.INBOUND_ATTACHMENTS_DIR);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function multipartRequest(form: FormData): Request {
  return new Request("http://localhost/", { method: "POST", body: form });
}

describe("POST /sendgrid/inbound", () => {
  test("records a plain-text email from an allowlisted sender", async () => {
    const before = listInboundEmails(5).length;

    const form = new FormData();
    form.set("from", "alice@example.com");
    form.set("to", "owlery@example.com");
    form.set("subject", "hello from the booth");
    form.set("text", "keep it up!");

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; num_attachments: number };
    expect(body.ok).toBe(true);
    expect(body.num_attachments).toBe(0);

    const after = listInboundEmails(5);
    expect(after.length).toBe(before + 1);
    const row = getInboundEmail(body.id);
    expect(row?.from_addr).toBe("alice@example.com");
    expect(row?.sender_domain).toBe("example.com");
    expect(row?.subject).toBe("hello from the booth");
    expect(row?.body_text).toBe("keep it up!");
    expect(row?.status).toBe("received");
  });

  test("rejects a sender whose domain is not allowlisted (soft-reject, HTTP 202)", async () => {
    const form = new FormData();
    form.set("from", "stranger@example.org");
    form.set("subject", "buy stuff");
    form.set("text", "no");

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("sender_domain_not_allowed");
  });

  test("captures attachments and writes them to disk", async () => {
    const form = new FormData();
    form.set("from", "alice@example.com");
    form.set("subject", "with a file");
    form.set("text", "see attached");
    form.set("attachment1", new File([new Uint8Array([1, 2, 3, 4])], "photo.png", { type: "image/png" }));

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; num_attachments: number };
    expect(body.num_attachments).toBe(1);

    const row = getInboundEmail(body.id);
    expect(row?.num_attachments).toBe(1);
    expect(row?.attachments_dir).toMatch(/inbound-parse/);
    expect(existsSync(`${row?.attachments_dir}/1-photo.png`)).toBe(true);
  });

  test("preserves both attachments when filenames collide", async () => {
    const form = new FormData();
    form.set("from", "alice@example.com");
    form.set("subject", "two files, same name");
    form.set("text", "attached");
    form.append("attachment1", new File([new Uint8Array([1])], "photo.png"));
    form.append("attachment2", new File([new Uint8Array([2, 2])], "photo.png"));

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; num_attachments: number };
    expect(body.num_attachments).toBe(2);

    const row = getInboundEmail(body.id);
    expect(existsSync(`${row?.attachments_dir}/1-photo.png`)).toBe(true);
    expect(existsSync(`${row?.attachments_dir}/2-photo.png`)).toBe(true);
  });

  test("falls back to html when text is absent", async () => {
    const form = new FormData();
    form.set("from", "alice@example.com");
    form.set("subject", "html only");
    form.set("html", "<p>hi</p>");

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    const row = getInboundEmail(body.id);
    expect(row?.body_text).toBe("<p>hi</p>");
  });

  test("forwards to Twilio Function and records action when configured", async () => {
    process.env.TWILIO_FUNCTION_INBOUND_URL = "https://svc.twil.io/api/inbound-email";
    process.env.TWILIO_FUNCTION_INBOUND_TOKEN = "fwd-token";
    const originalFetch = globalThis.fetch;
    const captured: { url?: string | URL | Request; init?: RequestInit } = {};
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ ok: true, key: "p15551230000" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    try {
      const form = new FormData();
      form.set("from", "alice@example.com");
      form.set("subject", "hello again");
      form.set("text", "cheers");
      const res = await inbound.fetch(multipartRequest(form));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number };

      expect(captured.url).toBe("https://svc.twil.io/api/inbound-email");
      const authHeader = (captured.init?.headers as Record<string, string> | undefined)?.["authorization"];
      expect(authHeader).toBe("Bearer fwd-token");

      const row = getInboundEmail(body.id);
      expect(row?.action_taken).toBe("twilio_function_forwarded");
      expect(row?.action_ref).toBe("p15551230000");
      expect(row?.status).toBe("acted");

      // Purging clears action_ref too, since it can identify a person.
      // Backdate the row so it's older than the purge cutoff.
      getDb().run("UPDATE inbound_emails SET received_at = datetime('now', '-2 days') WHERE id = ?", [body.id]);
      purgeInboundEmails(1);
      const purged = getInboundEmail(body.id);
      expect(purged?.status).toBe("purged");
      expect(purged?.action_ref).toBeNull();
      expect(purged?.from_addr).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TWILIO_FUNCTION_INBOUND_URL;
      delete process.env.TWILIO_FUNCTION_INBOUND_TOKEN;
    }
  });

  test("a failed forward is recorded but leaves the status as received", async () => {
    process.env.TWILIO_FUNCTION_INBOUND_URL = "https://svc.twil.io/api/inbound-email";
    process.env.TWILIO_FUNCTION_INBOUND_TOKEN = "fwd-token";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    try {
      const form = new FormData();
      form.set("from", "alice@example.com");
      form.set("subject", "downstream is down");
      form.set("text", "hi");
      const res = await inbound.fetch(multipartRequest(form));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: number };

      const row = getInboundEmail(body.id);
      expect(row?.action_taken).toBe("twilio_function_forward_failed:500");
      expect(row?.status).toBe("received");
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.TWILIO_FUNCTION_INBOUND_URL;
      delete process.env.TWILIO_FUNCTION_INBOUND_TOKEN;
    }
  });

  test("shortens a very long attachment filename instead of failing", async () => {
    const longName = `${"a".repeat(400)}.png`;
    const form = new FormData();
    form.set("from", "alice@example.com");
    form.set("subject", "long filename");
    form.set("text", "attached");
    form.set("attachment1", new File([new Uint8Array([7])], longName));

    const res = await inbound.fetch(multipartRequest(form));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    const row = getInboundEmail(body.id);
    const files = readdirSync(row!.attachments_dir!);
    expect(files.length).toBe(1);
    expect(files[0]!.length).toBeLessThanOrEqual(110);
    expect(files[0]!.endsWith(".png")).toBe(true);
  });

  test("rejects a request body over the size limit with 413", async () => {
    const tooBig = new Uint8Array(config.INBOUND_MAX_BODY_BYTES + 1024);
    const res = await inbound.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "content-length": String(tooBig.byteLength) },
        body: tooBig,
      })
    );
    expect(res.status).toBe(413);
  });
});
