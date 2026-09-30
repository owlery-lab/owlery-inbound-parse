CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbound_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body_text TEXT,
  sender_domain TEXT,
  num_attachments INTEGER NOT NULL DEFAULT 0,
  attachments_dir TEXT,
  action_taken TEXT,
  action_ref TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  purged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbound_emails_received_at ON inbound_emails(received_at);
CREATE INDEX IF NOT EXISTS idx_inbound_emails_status ON inbound_emails(status);
