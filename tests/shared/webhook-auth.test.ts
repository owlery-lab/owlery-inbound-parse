import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { basicAuth } from "@/shared/webhook-auth.js";

function makeApp() {
  const app = new Hono();
  app.use("*", basicAuth({ user: "inbound", pass: "s3cret" }));
  app.post("/", (c) => c.text("ok"));
  return app;
}

function authHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("basicAuth middleware", () => {
  test("accepts a matching credential pair", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: authHeader("inbound", "s3cret") },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("rejects a wrong password with 401 + WWW-Authenticate", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: authHeader("inbound", "wrong") },
      })
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  test("rejects a wrong user", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: authHeader("other", "s3cret") },
      })
    );
    expect(res.status).toBe(401);
  });

  test("rejects a missing header", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", { method: "POST" })
    );
    expect(res.status).toBe(401);
  });

  test("rejects a malformed header (no colon)", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from("nocolon").toString("base64") },
      })
    );
    expect(res.status).toBe(401);
  });

  test("rejects credentials that differ only in length", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: authHeader("inbound", "s3cret-plus-more") },
      })
    );
    expect(res.status).toBe(401);
  });

  test("rejects a non-Basic scheme", async () => {
    const res = await makeApp().fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: { authorization: "Bearer whatever" },
      })
    );
    expect(res.status).toBe(401);
  });
});
