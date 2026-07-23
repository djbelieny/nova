import { test, expect } from "bun:test";
import { parseCardArgs } from "../src/cli-workboard.ts";

test("parseCardArgs reads a --fields JSON blob", () => {
  const r = parseCardArgs(["--fields", '{"company":"Acme","score":80}']);
  expect(r.errors).toEqual([]);
  expect(r.fields).toEqual({ company: "Acme", score: 80 });
});

test("parseCardArgs reports malformed JSON instead of throwing", () => {
  const r = parseCardArgs(["--fields", "{not json"]);
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("--fields");
});

test("parseCardArgs returns empty fields when the flag is absent", () => {
  const r = parseCardArgs(["--stage", "new"]);
  expect(r.fields).toEqual({});
  expect(r.errors).toEqual([]);
});
