#!/usr/bin/env bun
import { Command } from "commander";
import { listInboundEmails, getInboundEmail, purgeInboundEmails } from "@/routines/inbound.js";
import { logger } from "@/shared/logger.js";

const program = new Command();
program
  .name("owlery-inbound")
  .description("Inspect and purge emails saved by owlery-inbound-parse")
  .version("0.1.0");

program
  .command("tail")
  .description("List the most recent inbound emails")
  .option("-n, --limit <n>", "How many rows to show", (v) => Number.parseInt(v, 10), 20)
  .action((options: { limit: number }) => {
    try {
      const rows = listInboundEmails(options.limit);

      console.log("\n📨 Inbound Emails");
      if (rows.length === 0) {
        console.log("  (none yet — waiting on your first Inbound Parse POST)\n");
        return;
      }

      for (const row of rows) {
        const status = `[${row.status.toUpperCase()}]`;
        const from = row.from_addr ?? "<purged>";
        const subj = row.subject ?? "<purged>";
        const att = row.num_attachments > 0 ? ` | 📎${row.num_attachments}` : "";
        console.log(`  ${status} ID: ${row.id} | ${row.received_at} | ${from} | ${subj}${att}`);
      }
      console.log();
    } catch (err) {
      logger.error("inbound tail failed", err as Error);
      console.error("Failed:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("show")
  .argument("<id>", "Inbound email ID")
  .description("Show the full contents of one inbound email")
  .action((idArg: string) => {
    try {
      const id = Number.parseInt(idArg, 10);
      const row = getInboundEmail(id);
      if (!row) {
        console.error(`No inbound email with id ${id}`);
        process.exit(1);
      }

      console.log(`\n📨 Inbound Email #${row.id}`);
      console.log(`  Received:        ${row.received_at}`);
      console.log(`  Status:          ${row.status.toUpperCase()}`);
      console.log(`  From:            ${row.from_addr ?? "<purged>"}`);
      console.log(`  To:              ${row.to_addr ?? "<purged>"}`);
      console.log(`  Sender Domain:   ${row.sender_domain ?? "<purged>"}`);
      console.log(`  Subject:         ${row.subject ?? "<purged>"}`);
      console.log(`  Attachments:     ${row.num_attachments}`);
      if (row.attachments_dir) console.log(`  Attachments Dir: ${row.attachments_dir}`);
      if (row.action_taken) console.log(`  Action Taken:    ${row.action_taken}`);
      if (row.action_ref) console.log(`  Action Ref:      ${row.action_ref}`);
      console.log();
      if (row.body_text) {
        console.log("--- body ---");
        console.log(row.body_text);
        console.log();
      }
    } catch (err) {
      logger.error("inbound show failed", err as Error);
      console.error("Failed:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("purge")
  .description("Clear personal data and delete attachments for emails older than N days")
  .option("--older-than <days>", "Purge rows older than N days", (v) => Number.parseInt(v, 10), 30)
  .action((options: { olderThan: number }) => {
    try {
      const result = purgeInboundEmails(options.olderThan);
      console.log("\n🧹 Inbound Purge Complete");
      console.log(`  Rows Scrubbed:           ${result.rowsPurged}`);
      console.log(`  Attachment Dirs Removed: ${result.attachmentDirsRemoved}`);
      console.log("\n  Tip: run this daily with cron or launchd so old email data doesn't pile up.\n");
    } catch (err) {
      logger.error("inbound purge failed", err as Error);
      console.error("Failed:", (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
