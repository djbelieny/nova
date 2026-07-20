// tests/cli-dispatch.test.ts
import { test, expect } from "bun:test";
import { resolveCommand } from "../src/cli.ts";

test("no args / help flags → help", () => {
  for (const a of [[], ["help"], ["--help"], ["-h"]]) {
    expect(resolveCommand(a).kind).toBe("help");
  }
});

test("version flags → version", () => {
  for (const a of [["version"], ["--version"], ["-v"]]) {
    expect(resolveCommand(a).kind).toBe("version");
  }
});

test("start/connect/doctor map to their entry files", () => {
  const start = resolveCommand(["start"]);
  expect(start).toMatchObject({ kind: "run", file: "src/relay.ts" });
  const connect = resolveCommand(["connect", "--url", "https://x"]);
  expect(connect).toMatchObject({ kind: "run", file: "src/connect/index.tsx", args: ["--url", "https://x"] });
  expect(resolveCommand(["doctor"])).toMatchObject({ kind: "run", file: "src/doctor.ts" });
});

test("chat injects the CLI-channel env", () => {
  const r = resolveCommand(["chat"]);
  expect(r).toMatchObject({ kind: "run", file: "src/relay.ts" });
  expect((r as any).env).toEqual({ NOVA_CHANNELS: "cli", NOVA_CLI: "1" });
});

test("dev uses the --watch bun flag", () => {
  expect((resolveCommand(["dev"]) as any).bunFlags).toEqual(["--watch"]);
});

test("providers/invite prepend the cli-manage group and pass args through", () => {
  expect(resolveCommand(["providers", "add"])).toMatchObject({
    kind: "run", file: "src/cli-manage.ts", args: ["providers", "add"],
  });
  expect(resolveCommand(["invite", "admin"])).toMatchObject({
    kind: "run", file: "src/cli-manage.ts", args: ["invite", "admin"],
  });
});

test("setup is an alias for init", () => {
  expect(resolveCommand(["setup"])).toMatchObject({ kind: "run", file: "src/setup-wizard.ts" });
});

test("update is its own kind", () => {
  expect(resolveCommand(["update"]).kind).toBe("update");
});

test("unknown command surfaces the name", () => {
  expect(resolveCommand(["frobnicate"])).toEqual({ kind: "unknown", cmd: "frobnicate" });
});
