/**
 * Nova — Workboard CLI (`nova workboard …`)
 *
 *   nova workboard list
 *   nova workboard describe <board>
 *   nova workboard create <name> --purpose '<text>' --fields '<json>' --stages '<json>'
 *   nova workboard card add <board> --stage <key> --fields '{…}'
 *   nova workboard card add-many <board> --stage <key> --file cards.json
 *   nova workboard card move <card-id> --to <stage>
 *   nova workboard card update <card-id> --fields '{…}'
 *   nova workboard query <board> [--stage <key>]
 *
 * Agents call these mid-task via the bash tool. Card writes are local and reversible, so they
 * are prepare-phase safe; consequential work stays behind the approval gate.
 */

import { getDb, type DatabaseType, type Workboard, type WorkboardCard } from "./db.ts";
import { addCards, createBoard, deriveTitle, moveCard } from "./workboard-service.ts";
import { validateCardFields, type FieldDef, type StageDef } from "./workboards.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Positional args: everything that isn't a `--flag` or a flag's value. */
function positionalArgs(argv: string[]): string[] {
  return argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
}

/** Names the shape of a parsed JSON value for error messages ("an object", "a number", …). */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** Scan visible boards for the one holding `cardId`. */
function findCardAndBoard(db: DatabaseType, userId: string, cardId: string): { board: Workboard; card: WorkboardCard } | null {
  for (const board of db.listWorkboardsVisible(userId)) {
    const card = db.getWorkboardCard(board.scope, userId, cardId);
    if (card && card.boardId === board.id) return { board, card };
  }
  return null;
}

/** Parse `--fields '<json>'` into an object, collecting errors rather than throwing. */
export function parseCardArgs(argv: string[]): { fields: Record<string, unknown>; errors: string[] } {
  const raw = flag(argv, "fields");
  if (!raw) return { fields: {}, errors: [] };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { fields: {}, errors: ["--fields must be a JSON object"] };
    }
    return { fields: parsed as Record<string, unknown>, errors: [] };
  } catch {
    return { fields: {}, errors: ["--fields is not valid JSON"] };
  }
}

function fail(errors: string[]): number {
  for (const e of errors) console.error(`  ${e}`);
  return 1;
}

function runList(): number {
  const db = getDb();
  const boards = db.listWorkboardsVisible(adminId(db));
  if (!boards.length) { console.log("  No workboards yet. Ask Nova in chat to create one."); return 0; }
  for (const b of boards) {
    const cards = db.listWorkboardCards(b.scope, b.userId, b.id).length;
    console.log(`  ${b.name} (${b.scope}) — ${b.stages.length} stages, ${cards} cards${b.reactive ? ", reactive" : ""}`);
  }
  return 0;
}

function runDescribe(name: string): number {
  const db = getDb();
  const board = db.findWorkboard(adminId(db), name);
  if (!board) { console.error(`  No workboard named "${name}"`); return 1; }
  console.log(`  ${board.name} (${board.scope})${board.purpose ? ` — ${board.purpose}` : ""}`);
  console.log("  fields:");
  for (const f of board.fields) {
    const bits = [f.type, f.required ? "required" : "", f.options?.length ? `[${f.options.join("|")}]` : ""].filter(Boolean);
    console.log(`    ${f.key} (${bits.join(", ")})`);
  }
  console.log("  stages:");
  for (const s of board.stages) console.log(`    ${s.key} — ${s.label}${s.onEnter ? " (on_enter armed)" : ""}`);
  return 0;
}

function runCreate(name: string, argv: string[]): number {
  const db = getDb();
  const userId = adminId(db);
  const errors: string[] = [];
  let fields: FieldDef[] = [];
  let stages: StageDef[] = [];
  try {
    const parsed = JSON.parse(flag(argv, "fields") ?? "[]");
    if (!Array.isArray(parsed)) errors.push(`--fields must be a JSON array of field definitions, got ${describeShape(parsed)}`);
    else fields = parsed;
  } catch {
    errors.push("--fields is not valid JSON");
  }
  try {
    const parsed = JSON.parse(flag(argv, "stages") ?? "[]");
    if (!Array.isArray(parsed)) errors.push(`--stages must be a JSON array of stage definitions, got ${describeShape(parsed)}`);
    else stages = parsed;
  } catch {
    errors.push("--stages is not valid JSON");
  }
  if (errors.length) return fail(errors);
  const r = createBoard(db, userId, { name, purpose: flag(argv, "purpose") ?? null, fields, stages, reactive: argv.includes("--reactive") });
  if (!r.ok) return fail(r.errors);
  console.log(`  ✓ Created workboard "${r.value.name}" with ${r.value.stages.length} stages`);
  return 0;
}

function runCardAdd(boardName: string, argv: string[]): number {
  const db = getDb();
  const userId = adminId(db);
  const board = db.findWorkboard(userId, boardName);
  if (!board) return fail([`No workboard named "${boardName}"`]);
  const stage = flag(argv, "stage") ?? board.stages[0]?.key;
  const { fields, errors } = parseCardArgs(argv);
  if (errors.length) return fail(errors);
  const r = addCards(db, userId, board, stage, [{ title: flag(argv, "title"), fields }], "agent");
  if (!r.ok) return fail(r.errors);
  console.log(`  ✓ Added card ${r.value[0].id} to ${board.name}/${stage}`);
  return 0;
}

async function runCardAddMany(boardName: string, argv: string[]): Promise<number> {
  const db = getDb();
  const userId = adminId(db);
  const board = db.findWorkboard(userId, boardName);
  if (!board) return fail([`No workboard named "${boardName}"`]);
  const file = flag(argv, "file");
  if (!file) return fail(["--file <path> is required (a JSON array of { title?, fields })"]);
  let records: any[] = [];
  try {
    records = JSON.parse(await Bun.file(file).text());
    if (!Array.isArray(records)) throw new Error("not an array");
  } catch {
    return fail([`could not read ${file} as a JSON array`]);
  }
  const stage = flag(argv, "stage") ?? board.stages[0]?.key;
  const r = addCards(db, userId, board, stage, records, "agent");
  if (!r.ok) return fail(r.errors);
  console.log(`  ✓ Added ${r.value.length} cards to ${board.name}/${stage}`);
  return 0;
}

function runCardMove(cardId: string, argv: string[]): number {
  const db = getDb();
  const userId = adminId(db);
  const to = flag(argv, "to");
  if (!to) return fail(["--to <stage> is required"]);
  const found = findCardAndBoard(db, userId, cardId);
  if (!found) return fail([`No card ${cardId}`]);
  const r = moveCard(db, userId, found.board, cardId, to, "cli");
  if (!r.ok) return fail(r.errors);
  console.log(`  ✓ Moved ${cardId} → ${to}${r.value.fires ? " (stage action armed)" : ""}`);
  return 0;
}

function runCardUpdate(cardId: string, argv: string[]): number {
  const db = getDb();
  const userId = adminId(db);
  const found = findCardAndBoard(db, userId, cardId);
  if (!found) return fail([`No card ${cardId}`]);
  const { board, card } = found;
  const { fields, errors } = parseCardArgs(argv);
  if (errors.length) return fail(errors);
  const merged = { ...card.fields, ...fields };
  const result = validateCardFields(board.fields, merged);
  if (!result.ok) return fail(result.errors);
  db.updateWorkboardCard(board.scope, userId, cardId, {
    fields: result.values,
    title: deriveTitle(board.fields, result.values, flag(argv, "title")),
  });
  db.insertWorkboardEvent(board.scope, userId, { boardId: board.id, cardId, kind: "updated", actor: "cli", detail: { before: card.fields } });
  console.log(`  ✓ Updated card ${cardId}`);
  return 0;
}

function runQuery(boardName: string, argv: string[]): number {
  const db = getDb();
  const userId = adminId(db);
  const board = db.findWorkboard(userId, boardName);
  if (!board) return fail([`No workboard named "${boardName}"`]);
  const cards = db.listWorkboardCards(board.scope, userId, board.id, { stageKey: flag(argv, "stage") });
  console.log(JSON.stringify(cards.map((c) => ({ id: c.id, stage: c.stageKey, title: c.title, fields: c.fields })), null, 2));
  return 0;
}

export async function runWorkboardCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const positional = positionalArgs(rest);
  switch (sub) {
    case "list": case undefined: return runList();
    case "describe": return positional[0] ? runDescribe(positional[0]) : fail(["Usage: nova workboard describe <board>"]);
    case "create": return positional[0] ? runCreate(positional[0], rest) : fail(["Usage: nova workboard create <name> --fields '<json>' --stages '<json>'"]);
    case "query": return positional[0] ? runQuery(positional[0], rest) : fail(["Usage: nova workboard query <board> [--stage <key>]"]);
    case "card": {
      const [verb, ...cardRest] = rest;
      const cardPositional = positionalArgs(cardRest);
      switch (verb) {
        case "add": return cardPositional[0] ? runCardAdd(cardPositional[0], cardRest) : fail(["Usage: nova workboard card add <board> --stage <key> --fields '{…}'"]);
        case "add-many": return cardPositional[0] ? await runCardAddMany(cardPositional[0], cardRest) : fail(["Usage: nova workboard card add-many <board> --stage <key> --file cards.json"]);
        case "move": return cardPositional[0] ? runCardMove(cardPositional[0], cardRest) : fail(["Usage: nova workboard card move <card-id> --to <stage>"]);
        case "update": return cardPositional[0] ? runCardUpdate(cardPositional[0], cardRest) : fail(["Usage: nova workboard card update <card-id> --fields '{…}'"]);
        default: return fail([`Unknown card verb: ${verb}`, "Usage: nova workboard card add|add-many|move|update"]);
      }
    }
    default:
      return fail([`Unknown subcommand: ${sub}`, "Usage: nova workboard list|describe|create|query|card …"]);
  }
}

if (import.meta.main) {
  runWorkboardCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: any) => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
