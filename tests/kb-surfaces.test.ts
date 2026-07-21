// tests/kb-surfaces.test.ts — pure surface logic (no DB, no model)
import { test, expect } from "bun:test";
import { parseKbArgs } from "../src/cli-kb.ts";
import { parseKbCaption } from "../src/knowledge.ts";
import { scopeForPath } from "../services/kb-watch.ts";
import { resolveCommand } from "../src/cli.ts";
import { sourceTypeFromName, mimeFromSourceType } from "../src/text-chunk.ts";

test("parseKbArgs defaults to personal scope", () => {
  const f = parseKbArgs(["report.pdf"]);
  expect(f.scope).toBe("personal");
  expect(f.positional).toEqual(["report.pdf"]);
});

test("parseKbArgs reads --scope and --agent (agent implies agent scope)", () => {
  expect(parseKbArgs(["x.md", "--scope", "team"]).scope).toBe("team");
  const a = parseKbArgs(["x.md", "--agent", "lex"]);
  expect(a.scope).toBe("agent");
  expect(a.agent).toBe("lex");
  expect(parseKbArgs(["--all"]).all).toBe(true);
});

test("parseKbCaption detects intent + scope", () => {
  expect(parseKbCaption("just analyze this").wants).toBe(false);
  expect(parseKbCaption("add to knowledge").wants).toBe(true);
  expect(parseKbCaption("remember this file please").wants).toBe(true);
  expect(parseKbCaption("add to team knowledge").scope).toBe("team");
  const agent = parseKbCaption("add to knowledge for lex's pack");
  expect(agent.scope).toBe("agent");
  expect(agent.agentSlug).toBe("lex");
  const agent2 = parseKbCaption("learn this doc, agent: aura");
  expect(agent2.scope).toBe("agent");
  expect(agent2.agentSlug).toBe("aura");
});

test("scopeForPath maps folders to scopes", () => {
  expect(scopeForPath("notes.md").scope).toBe("personal");
  expect(scopeForPath("team/handbook.pdf").scope).toBe("team");
  const a = scopeForPath("agents/lex/contract.pdf");
  expect(a.scope).toBe("agent");
  expect(a.agentSlug).toBe("lex");
});

test("resolveCommand routes `nova kb ...` to cli-kb.ts", () => {
  const r = resolveCommand(["kb", "add", "file.pdf", "--scope", "team"]);
  expect(r.kind).toBe("run");
  if (r.kind === "run") {
    expect(r.file).toBe("src/cli-kb.ts");
    expect(r.args).toEqual(["add", "file.pdf", "--scope", "team"]);
  }
});

test("sourceTypeFromName + mimeFromSourceType round-trip", () => {
  expect(sourceTypeFromName("a.pdf")).toBe("pdf");
  expect(sourceTypeFromName("a.docx")).toBe("docx");
  expect(sourceTypeFromName("a.md")).toBe("md");
  expect(sourceTypeFromName("https://x.com/y")).toBe("url");
  expect(mimeFromSourceType("pdf")).toContain("pdf");
  expect(mimeFromSourceType("docx")).toContain("word");
});
