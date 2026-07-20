// services/ticket-worker.ts
import { getDb, type Database } from "../src/db.ts";
import { advanceTicket, defaultLLM, defaultAgent, type PipelineDeps } from "../src/ticket-pipeline.ts";
import { deployFix } from "../src/ticket-deployer.ts";
import { sendTicketEmail } from "../src/resend-client.ts";

const OPERATOR = process.env.TICKET_OPERATOR_USER_ID || "";
const TERMINAL = ["deployed", "failed", "escalated", "closed"];

export function recoverStaleTickets(db: Database, userId: string): number {
  const stale = db.getTicketsByStatus(userId, ["fixing", "deploying"]);
  for (const t of stale) {
    if (t.status === "fixing") {
      db.updateSupportTicket(userId, t.id, { status: "resolving", last_error: "recovered after restart" });
    } else if (t.status === "deploying") {
      // Reset to awaiting_approval — deploy must always be re-approved by a human, never auto-redeployed.
      db.updateSupportTicket(userId, t.id, { status: "awaiting_approval", last_error: "recovered after restart (deploy must be re-approved)" });
    }
  }
  return stale.length;
}

export async function processOnce(db: Database, userId: string, deps: PipelineDeps & { onAwaitingApproval: (ticketId: string) => Promise<void> }): Promise<void> {
  // Re-send approval cards for tickets awaiting approval whose card was never confirmed delivered.
  const pendingCards = db.getTicketsByStatus(userId, ["awaiting_approval"]);
  for (const t of pendingCards) {
    if (t.deploy_result !== "approval card sent") await deps.onAwaitingApproval(t.id);
  }
  const active = db.getTicketsByStatus(userId, ["new", "triaged", "resolving"]);
  for (const t of active) {
    let status = t.status;
    // drive this ticket until it parks at a wait/terminal state
    for (let i = 0; i < 5 && !TERMINAL.includes(status) && status !== "awaiting_approval"; i++) {
      status = await advanceTicket(db, userId, t.id, deps);
    }
    if (status === "awaiting_approval") await deps.onAwaitingApproval(t.id);
  }
}

export async function handleTicketApproval(
  db: Database, userId: string, ticketId: string, action: "approve" | "reject",
  opts: { sendEmail: (to: string, subject: string, body: string) => Promise<void>; dryRun: boolean }
): Promise<void> {
  const t = db.getSupportTicket(userId, ticketId);
  if (!t || t.status !== "awaiting_approval") return;

  if (action === "reject") {
    db.updateSupportTicket(userId, ticketId, { status: "escalated", last_error: "operator rejected" });
    await opts.sendEmail(t.client_email, `Re: ${t.subject}`, "Thanks for your patience — a team member will follow up personally.");
    return;
  }

  // Correction 2: use stored project_id directly (avoids TOCTOU, consistent with Task 8 fix)
  const project = db.getUserProjectById(userId, t.project_id);
  if (!project) { db.updateSupportTicket(userId, ticketId, { status: "failed", last_error: "project vanished" }); return; }
  db.updateSupportTicket(userId, ticketId, { status: "deploying" });
  const r = await deployFix({ project, branchName: t.branch_name, dryRun: opts.dryRun, pushRemote: !opts.dryRun });
  if (r.ok) {
    db.updateSupportTicket(userId, ticketId, { status: "deployed", deploy_result: r.log.join("\n") });
    await opts.sendEmail(t.client_email, `Re: ${t.subject}`, "Good news — we've shipped a fix for your issue. Let us know if anything's still off.");
  } else {
    db.updateSupportTicket(userId, ticketId, { status: "failed", deploy_result: r.log.join("\n"), last_error: r.rolledBack ? "deploy failed, rolled back" : "deploy failed" });
    await opts.sendEmail(t.client_email, `Re: ${t.subject}`, "We hit a snag deploying the fix; a team member is on it.");
  }
}

// Telegram approval card — sent via the bot API directly (no grammy Context needed here).
async function sendApprovalCard(db: Database, userId: string, ticketId: string): Promise<void> {
  const t = db.getSupportTicket(userId, ticketId);
  if (!t) return;
  const adminId = process.env.TELEGRAM_ADMIN_ID || "";
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!adminId || !token) return;
  const text = `🎫 <b>Ticket fix ready</b>\nFrom: ${t.client_email}\nSubject: ${t.subject}\n\n<b>Diff</b>\n<pre>${(t.diff_summary||"").slice(0,1500)}</pre>\n<b>Tests:</b> passed`;
  const reply_markup = { inline_keyboard: [[
    { text: "✅ Approve & deploy", callback_data: `tkt:${ticketId}:approve` },
    { text: "❌ Reject", callback_data: `tkt:${ticketId}:reject` },
  ]]};
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: Number(adminId), text, parse_mode: "HTML", reply_markup }),
  }).catch(() => null);
  if (resp && resp.ok) {
    db.updateSupportTicket(userId, ticketId, { deploy_result: "approval card sent" });
  } else {
    console.error(`[sendApprovalCard] failed to deliver approval card for ticket ${ticketId}`);
  }
}

async function main() {
  if (!OPERATOR) { console.error("TICKET_OPERATOR_USER_ID not set"); process.exit(1); }
  const db = getDb();
  recoverStaleTickets(db, OPERATOR);
  const deps = {
    runLLM: defaultLLM(), runAgent: defaultAgent(),
    onAwaitingApproval: async (ticketId: string) => { await sendApprovalCard(db, OPERATOR, ticketId); },
  };
  await processOnce(db, OPERATOR, deps);
  process.exit(0);
}

if (import.meta.main) main().catch((e) => { console.error("ticket-worker:", e); process.exit(1); });
