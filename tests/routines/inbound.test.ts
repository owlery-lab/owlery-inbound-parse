import { describe, test, expect } from "bun:test";
import "../setup.js";
import { forwardToTwilioFunction } from "@/routines/inbound.js";

describe("forwardToTwilioFunction", () => {
  test("posts url-encoded body with Bearer token, extracts ref from JSON response", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const mockFetch = (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return new Response(JSON.stringify({ ok: true, key: "p15551230000", count: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const outcome = await forwardToTwilioFunction(
      "https://svc.twil.io/api/inbound-email",
      "s3cret",
      { from: "alice@example.com", to: null, subject: "hello", text: "hey", envelope: null },
      mockFetch
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(outcome.ref).toBe("p15551230000");
    expect(captured.url).toBe("https://svc.twil.io/api/inbound-email");
    expect(captured.init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Bearer s3cret",
    });
    const body = String(captured.init?.body ?? "");
    const params = new URLSearchParams(body);
    expect(params.get("from")).toBe("alice@example.com");
    expect(params.get("subject")).toBe("hello");
    expect(params.get("text")).toBe("hey");
    expect(params.has("to")).toBe(false);
  });

  test("returns non-ok outcome for HTTP failure, still surfaces status", async () => {
    const mockFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const outcome = await forwardToTwilioFunction("https://x", "t", { from: "a@b.com", to: null, subject: "s", text: null, envelope: null }, mockFetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(401);
    expect(outcome.ref).toBe(null);
  });

  test("returns network-error outcome when fetch rejects", async () => {
    const mockFetch = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const outcome = await forwardToTwilioFunction("https://x", "t", { from: "a@b.com", to: null, subject: "s", text: null, envelope: null }, mockFetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(null);
    expect(outcome.error).toContain("ECONNREFUSED");
  });

  test("propagates timeout when headers arrive but response body stalls", async () => {
    const mockFetch = ((_url: string, init?: RequestInit) => {
      // Headers land quickly...
      const stream = new ReadableStream({
        start(controller) {
          // ...but the body never emits data or closes, until aborted.
          const signal = init?.signal;
          if (signal) {
            const onAbort = () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort);
          }
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;

    const outcome = await forwardToTwilioFunction("https://x", "t", { from: "a@b.com", to: null, subject: "s", text: null, envelope: null }, mockFetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/^timeout_after_\d+ms$/);
  }, 10_000);

  test("aborts with a timeout error when the downstream stalls past the deadline", async () => {
    const mockFetch = ((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            return reject(err);
          }
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }) as unknown as typeof fetch;

    const outcome = await forwardToTwilioFunction("https://x", "t", { from: "a@b.com", to: null, subject: "s", text: null, envelope: null }, mockFetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/^timeout_after_\d+ms$/);
  }, 10_000);
});
