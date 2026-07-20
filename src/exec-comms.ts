/**
 * Executive Communication Layer — Supabase REST API
 *
 * Shared communication backbone for inter-node executive board communication.
 * Uses raw fetch against PostgREST (no Supabase JS client) to keep deps minimal.
 *
 * Usage: import { ExecComms } from "./exec-comms.ts";
 *        const comms = new ExecComms("ceo");
 */

import { resolveBoardConfig } from "./board-config.ts";

// ============================================================
// Types
// ============================================================

export interface ExecMessage {
  id: string;
  created_at: string;
  from_role: string;
  to_role: string | null;
  type: string;
  subject: string | null;
  content: string;
  read_by: string[];
  metadata: Record<string, any>;
  board_session_id: string | null;
}

export interface BoardSession {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  question: string;
  status: string;
  board_members: string[];
  options: any[];
  chosen_option: string | null;
  decision_rationale: string | null;
  consensus: string | null;
  follow_up_of: string | null;
  cost_usd: number;
  metadata: Record<string, any>;
}

export interface BoardContribution {
  id: string;
  created_at: string;
  session_id: string;
  role: string;
  contribution: string;
  is_critique: boolean;
  metadata: Record<string, any>;
}

export interface Delegation {
  id: string;
  created_at: string;
  updated_at: string;
  requesting_role: string;
  assigned_agent: string | null;
  assigned_by: string;
  task_description: string;
  status: string;
  result: string | null;
  artifacts: any[];
  node_id: string | null;
  user_id: string;
  metadata: Record<string, any>;
}

export interface Decision {
  id?: string;
  user_id: string;
  question: string;
  chosen_option: string;
  rationale?: string;
  confidence?: number;
  outcome?: string;
  outcome_notes?: string;
  board_session_id?: string;
  contributing_roles?: string[];
  cost_usd?: number;
}

export interface NodeStatus {
  node_id: string;
  role: string;
  last_seen: string;
  status: string;
  active_tasks: number;
  metadata?: Record<string, any>;
}

export interface ExecRosterEntry {
  role: string;
  bot_username: string;
  exec_name: string;
  status: string;
}

export interface Project {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  title: string;
  description: string | null;
  status: string;
  board_session_id: string | null;
  work_items: any[];
  progress_pct: number;
  next_milestone: string | null;
  completion_criteria: string | null;
  metadata: Record<string, any>;
}

// ============================================================
// ExecComms
// ============================================================

export class ExecComms {
  private url: string;
  private key: string;
  private role: string;

  constructor(
    nodeRole: string,
    // Board backend URL/key. Defaults resolve BOARD_DB_URL/BOARD_DB_KEY, falling
    // back to the legacy SUPABASE_* env names. Exec nodes are trusted server-side
    // processes; board tables have RLS enabled with no policies, so the key must
    // map to a role that bypasses RLS (self-host: nova_board JWT; Supabase: service role).
    boardUrl = resolveBoardConfig().url!,
    boardKey = resolveBoardConfig().key!,
  ) {
    this.url = boardUrl.replace(/\/$/, "");
    this.key = boardKey;
    this.role = nodeRole;
  }

  // --- helpers ---

  private headers(prefer?: string): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (prefer) h["Prefer"] = prefer;
    return h;
  }

  private async query<T = any>(table: string, params: string): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${table}?${params}`, { headers: this.headers() });
    if (!res.ok) { console.error(`[ExecComms] GET ${table} failed:`, await res.text()); return []; }
    return res.json();
  }

  private async insert<T = any>(table: string, data: Record<string, any>, prefer = "return=representation"): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: "POST", headers: this.headers(prefer), body: JSON.stringify(data),
    });
    if (!res.ok) { console.error(`[ExecComms] INSERT ${table} failed:`, await res.text()); return []; }
    return res.json();
  }

  private async update(table: string, data: Record<string, any>, match: string): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${table}?${match}`, {
      method: "PATCH", headers: this.headers("return=minimal"), body: JSON.stringify(data),
    });
    if (!res.ok) console.error(`[ExecComms] PATCH ${table} failed:`, await res.text());
  }

  // --- messaging ---

  async sendBrief(toRole: string | null, subject: string, content: string): Promise<void> {
    await this.insert("exec_messages", { from_role: this.role, to_role: toRole, type: "brief", subject, content, read_by: [], metadata: {} });
  }

  async sendAlert(toRole: string | null, subject: string, content: string): Promise<void> {
    await this.insert("exec_messages", { from_role: this.role, to_role: toRole, type: "alert", subject, content, read_by: [], metadata: {} });
  }

  async pollMessages(since: Date): Promise<ExecMessage[]> {
    const iso = since.toISOString();
    return this.query<ExecMessage>("exec_messages",
      `or=(to_role.eq.${this.role},to_role.is.null)&created_at=gt.${iso}&read_by=not.cs.{${this.role}}&order=created_at.asc`);
  }

  async markRead(messageId: string): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/rpc/array_append_read_by`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ msg_id: messageId, reader: this.role }),
    });
    if (!res.ok) {
      // Fallback: fetch then patch
      const rows = await this.query<ExecMessage>("exec_messages", `id=eq.${messageId}`);
      if (rows[0]) {
        const readBy = rows[0].read_by.includes(this.role) ? rows[0].read_by : [...rows[0].read_by, this.role];
        await this.update("exec_messages", { read_by: readBy }, `id=eq.${messageId}`);
      }
    }
  }

  // --- board meetings ---

  async conveneBoard(question: string, members: string[], userId: string): Promise<string> {
    const rows = await this.insert<BoardSession>("board_sessions", {
      user_id: userId, question, status: "convened", board_members: members, options: [], cost_usd: 0, metadata: {},
    });
    return rows[0]?.id ?? "";
  }

  async submitContribution(sessionId: string, contribution: string, isCritique = false): Promise<void> {
    await this.insert("board_contributions", { session_id: sessionId, role: this.role, contribution, is_critique: isCritique, metadata: {} });
  }

  async getContributions(sessionId: string): Promise<BoardContribution[]> {
    return this.query<BoardContribution>("board_contributions", `session_id=eq.${sessionId}&order=created_at.asc`);
  }

  async getSession(sessionId: string): Promise<BoardSession | null> {
    const rows = await this.query<BoardSession>("board_sessions", `id=eq.${sessionId}`);
    return rows[0] ?? null;
  }

  async updateSession(sessionId: string, data: Partial<BoardSession>): Promise<void> {
    await this.update("board_sessions", { ...data, updated_at: new Date().toISOString() }, `id=eq.${sessionId}`);
  }

  async getPendingSessions(): Promise<BoardSession[]> {
    return this.query<BoardSession>("board_sessions",
      `board_members=cs.{${this.role}}&status=in.(convened,analyzing)&order=created_at.asc`);
  }

  // --- delegations ---

  async requestDelegation(task: string, userId: string, agent?: string): Promise<string> {
    const rows = await this.insert<Delegation>("delegations", {
      requesting_role: this.role, assigned_agent: agent ?? null, assigned_by: this.role,
      task_description: task, status: "pending", artifacts: [], user_id: userId, metadata: {},
    });
    return rows[0]?.id ?? "";
  }

  async pollDelegations(): Promise<Delegation[]> {
    return this.query<Delegation>("delegations", `status=eq.pending&order=created_at.asc`);
  }

  async claimDelegation(id: string): Promise<void> {
    await this.update("delegations", { status: "in_progress", node_id: this.role, updated_at: new Date().toISOString() }, `id=eq.${id}`);
  }

  async completeDelegation(id: string, result: string, artifacts: any[] = []): Promise<void> {
    await this.update("delegations", { status: "completed", result, artifacts, updated_at: new Date().toISOString() }, `id=eq.${id}`);
  }

  async failDelegation(id: string, error: string): Promise<void> {
    await this.update("delegations", { status: "failed", result: error, updated_at: new Date().toISOString() }, `id=eq.${id}`);
  }

  async getDelegationResult(id: string): Promise<Delegation | null> {
    const rows = await this.query<Delegation>("delegations", `id=eq.${id}`);
    return rows[0] ?? null;
  }

  async getDelegationsByProject(projectId: string): Promise<Delegation[]> {
    // Delegations embed projectId in task_description as "[Project: <id>]"
    return this.query<Delegation>(
      "delegations",
      `task_description=like.*[Project: ${projectId}]*&order=created_at.asc`,
    );
  }

  /** Poll pending delegations assigned to specific agent slugs (for relay-side execution). */
  async pollAgentDelegations(agentSlugs: string[]): Promise<Delegation[]> {
    if (agentSlugs.length === 0) return [];
    const slugList = agentSlugs.join(",");
    return this.query<Delegation>(
      "delegations",
      `status=eq.pending&assigned_agent=in.(${slugList})&order=created_at.asc&limit=5`,
    );
  }

  // --- decisions ---

  async recordDecision(decision: Decision): Promise<string> {
    const rows = await this.insert<Decision & { id: string }>("decisions", decision);
    const id = rows[0]?.id ?? "";
    if (id) {
      await this.insert("decision_log", {
        decision_id: id, event_type: "decision_made", role: this.role,
        data: { question: decision.question, chosen: decision.chosen_option, user_id: decision.user_id },
      }, "return=minimal");
    }
    return id;
  }

  async getRecentDecisions(userId: string, limit = 10): Promise<Decision[]> {
    return this.query<Decision>("decisions", `user_id=eq.${userId}&order=created_at.desc&limit=${limit}`);
  }

  async updateOutcome(decisionId: string, outcome: string, notes?: string): Promise<void> {
    await this.update("decisions", { outcome, outcome_notes: notes ?? null }, `id=eq.${decisionId}`);
    await this.insert("decision_log", {
      decision_id: decisionId, event_type: "outcome_recorded", role: this.role,
      data: { outcome, notes },
    }, "return=minimal");
  }

  async checkStalling(userId: string): Promise<boolean> {
    const rows = await this.query<BoardSession>("board_sessions", `user_id=eq.${userId}&order=created_at.desc&limit=2`);
    if (rows.length < 2) return false;
    return rows[0].question.trim().toLowerCase() === rows[1].question.trim().toLowerCase();
  }

  // --- heartbeat ---

  async heartbeat(activeTasks: number): Promise<void> {
    await this.insert("exec_heartbeats", {
      node_id: this.role, role: this.role, status: "online",
      active_tasks: activeTasks, last_seen: new Date().toISOString(),
    }, "resolution=merge-duplicates,return=minimal");
  }

  async getNodeStatuses(): Promise<NodeStatus[]> {
    return this.query<NodeStatus>("exec_heartbeats", `order=last_seen.desc`);
  }

  async registerNode(vpsHost?: string, opts?: { botUsername?: string; execName?: string }): Promise<void> {
    const metadata: Record<string, any> = {};
    if (opts?.botUsername) metadata.bot_username = opts.botUsername;
    if (opts?.execName) metadata.exec_name = opts.execName;
    await this.insert("exec_nodes", {
      id: this.role, role: this.role, status: "online",
      vps_host: vpsHost ?? null, last_heartbeat: new Date().toISOString(),
      metadata,
    }, "resolution=merge-duplicates,return=minimal");
  }

  async deregisterNode(): Promise<void> {
    await this.update("exec_nodes", { status: "offline", last_heartbeat: new Date().toISOString() }, `id=eq.${this.role}`);
  }

  async getExecRoster(): Promise<ExecRosterEntry[]> {
    const rows = await this.query<{ id: string; role: string; status: string; metadata: Record<string, any> }>(
      "exec_nodes", `select=id,role,status,metadata&order=role.asc`,
    );
    return rows.map((r) => ({
      role: r.role,
      bot_username: r.metadata?.bot_username || "",
      exec_name: r.metadata?.exec_name || r.role.toUpperCase(),
      status: r.status,
    }));
  }

  // --- projects ---

  async createProject(project: Partial<Project> & { user_id: string; title: string }): Promise<string> {
    const rows = await this.insert<Project>("projects", {
      status: "active", work_items: [], progress_pct: 0, metadata: {}, ...project,
    });
    return rows[0]?.id ?? "";
  }

  async getActiveProjects(userId?: string): Promise<Project[]> {
    const filter = userId ? `user_id=eq.${userId}&status=eq.active` : `status=eq.active`;
    return this.query<Project>("projects", `${filter}&order=updated_at.desc`);
  }

  async updateProject(id: string, data: Partial<Project>): Promise<void> {
    await this.update("projects", { ...data, updated_at: new Date().toISOString() }, `id=eq.${id}`);
  }

  // --- proactive runs (dedup tracking) ---

  async hasProactiveRun(role: string, source: string, sourceId: string): Promise<boolean> {
    const rows = await this.query("proactive_runs",
      `role=eq.${role}&source=eq.${source}&source_id=eq.${sourceId}&limit=1`);
    return rows.length > 0;
  }

  async recordProactiveRun(
    role: string, source: string, sourceId: string,
    outputType?: string, outputRef?: string, behaviorName?: string,
  ): Promise<void> {
    await this.insert("proactive_runs", {
      role, source, source_id: sourceId,
      output_type: outputType ?? null, output_ref: outputRef ?? null,
      behavior_name: behaviorName ?? null,
    }, "return=minimal");
  }
}
