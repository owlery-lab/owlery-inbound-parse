process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.SENDGRID_INBOUND_ALLOWED_SENDER_DOMAINS ??= "example.com";
process.env.INBOUND_ATTACHMENTS_DIR ??= "./data/test-inbound-parse";
// Small limit so the size-limit test doesn't need a 32 MB body.
process.env.INBOUND_MAX_BODY_BYTES ??= "65536";
