export interface InboundEmail {
  id: number;
  received_at: string;
  from_addr: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  sender_domain: string | null;
  num_attachments: number;
  attachments_dir: string | null;
  action_taken: string | null;
  action_ref: string | null;
  status: "received" | "acted" | "purge_ready" | "purged" | "rejected";
  purged_at: string | null;
}
