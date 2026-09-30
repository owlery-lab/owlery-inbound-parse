import { Hono } from "hono";
import { logger } from "@/shared/logger.js";
import { config } from "@/shared/config.js";
import { migrate } from "@/core/db/index.js";
import inbound from "@/api/inbound.js";

const app = new Hono();

app.route("/sendgrid/inbound", inbound);
app.get("/health", (c) => c.json({ status: "ok", service: "owlery-inbound-parse" }));

if (import.meta.main) {
  logger.info("Starting owlery-inbound-parse API", { port: config.PORT });
  migrate();
  // Second size check, at the server level, in case a request skips the route's limit.
  const server = Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
    maxRequestBodySize: config.INBOUND_MAX_BODY_BYTES,
  });
  console.log(`🦉 owlery-inbound-parse listening on http://localhost:${server.port}`);
}

// NOTE: intentionally not `export default app` — Bun's auto-serve would then
// try to bind a second listener on the same port when running this file
// directly. Consumers who need the Hono instance should `import { app }`.
export { app };
