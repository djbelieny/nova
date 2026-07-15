import { test, expect, beforeEach, afterEach } from "bun:test";
import { planSandboxAuth, shareAuthEnabled } from "../src/sandbox/auth.ts";
import { DockerBackend } from "../src/sandbox/docker.ts";

const saved = process.env.NOVA_SANDBOX_SHARE_AUTH;
beforeEach(() => { delete process.env.NOVA_SANDBOX_SHARE_AUTH; });
afterEach(() => {
  if (saved === undefined) delete process.env.NOVA_SANDBOX_SHARE_AUTH;
  else process.env.NOVA_SANDBOX_SHARE_AUTH = saved;
});

test("share-auth is on by default, off only when explicitly disabled", () => {
  expect(shareAuthEnabled()).toBe(true);
  process.env.NOVA_SANDBOX_SHARE_AUTH = "false";
  expect(shareAuthEnabled()).toBe(false);
});

test("subscription mode does NOT forward plain API keys (avoids per-token billing)", () => {
  const plan = planSandboxAuth("claude");
  expect(plan.envPassthrough).not.toContain("ANTHROPIC_API_KEY");
  expect(plan.envPassthrough).toContain("CLAUDE_CODE_OAUTH_TOKEN");
});

test("strict-isolation mode forwards API keys and mounts no host credentials", () => {
  process.env.NOVA_SANDBOX_SHARE_AUTH = "false";
  const plan = planSandboxAuth("gemini");
  expect(plan.envPassthrough).toContain("GEMINI_API_KEY");
  expect(plan.credentialMounts).toEqual([]);
  expect(plan.workspaceSymlinks).toEqual([]);
});

test("credential mounts are read-only and target the top-level /nova-auth dir", () => {
  for (const mount of planSandboxAuth("codex").credentialMounts) {
    expect(mount.endsWith(":ro")).toBe(true);
    expect(mount).toContain(":/nova-auth/codex/");
    expect(mount).not.toContain("/workspace/"); // never nested
  }
});

test("claude points at creds via CLAUDE_CONFIG_DIR when creds are mounted", () => {
  const plan = planSandboxAuth("claude");
  if (plan.credentialMounts.length > 0) {
    expect(plan.envSet.CLAUDE_CONFIG_DIR).toBe("/nova-auth/claude");
  } else {
    expect(plan.envSet).toEqual({});
    expect(plan.warning).toContain("claude");
  }
});

test("gemini resolves its HOME-based dir via a workspace symlink when creds mounted", () => {
  const plan = planSandboxAuth("gemini");
  if (plan.credentialMounts.length > 0) {
    expect(plan.workspaceSymlinks).toContainEqual({ link: ".gemini", target: "/nova-auth/gemini" });
  }
});

test("docker backend emits credential mounts read-only and envSet as -e NAME=VALUE", () => {
  const backend = new DockerBackend("img");
  const { argv } = backend.wrapCommand(["claude", "-p", "x"], {
    cwd: "/tmp/ws",
    credentialMounts: [`${process.env.HOME}/.claude/.credentials.json:/nova-auth/claude/.credentials.json:ro`],
    envSet: { CLAUDE_CONFIG_DIR: "/nova-auth/claude" },
  });
  const joined = argv.join(" ");
  expect(joined).toContain(":/nova-auth/claude/.credentials.json:ro");
  expect(joined).toContain("-e CLAUDE_CONFIG_DIR=/nova-auth/claude");
});

test("credential mount without :ro suffix is forced read-only", () => {
  const backend = new DockerBackend("img");
  const { argv } = backend.wrapCommand(["x"], { cwd: "/tmp/ws", credentialMounts: ["/h/a:/nova-auth/codex/auth.json"] });
  expect(argv.join(" ")).toContain("-v /h/a:/nova-auth/codex/auth.json:ro");
});
