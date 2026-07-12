import { test, expect } from "bun:test";
import { resolveProject } from "../src/ticket-repo-resolver.ts";
import { getDb } from "../src/db.ts";

const U = "33333333-3333-4333-8333-333333333333";

test("matched sender resolves to its project", () => {
  const db = getDb();
  db.upsertUserProjectForTest(U, { name: "acme", client_match: "@acme.com", test_command: "bun test" });
  const r = resolveProject(db, U, "jane@acme.com");
  expect(r.project?.name).toBe("acme");
  expect(r.escalate).toBe(false);
});

test("unknown sender escalates, never resolves", () => {
  const db = getDb();
  const r = resolveProject(db, U, "stranger@unknown.com");
  expect(r.project).toBeNull();
  expect(r.escalate).toBe(true);
});
