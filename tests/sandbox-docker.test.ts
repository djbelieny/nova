import { test, expect } from "bun:test";
import { DockerBackend, validateBind } from "../src/sandbox/docker.ts";
import { homedir } from "os";

test("wrapCommand builds hardened docker run argv", () => {
  const backend = new DockerBackend("nova-sandbox:test");
  const { argv, cwd } = backend.wrapCommand(["claude", "-p", "hi"], { cwd: "/tmp/ws" });
  expect(argv.slice(0, 2)).toEqual(["docker", "run"]);
  expect(argv).toContain("--rm");
  expect(argv.join(" ")).toContain("--network none");
  expect(argv).toContain("--read-only");
  expect(argv.join(" ")).toContain("--cap-drop ALL");
  expect(argv.join(" ")).toContain("--security-opt no-new-privileges");
  expect(argv.join(" ")).toContain("-v /tmp/ws:/workspace:rw");
  expect(argv.join(" ")).toContain("-w /workspace");
  const imageIdx = argv.indexOf("nova-sandbox:test");
  expect(argv.slice(imageIdx + 1)).toEqual(["claude", "-p", "hi"]);
  expect(cwd).toBe("/tmp/ws");
});

test("network bridge and ro workspace are honored", () => {
  const backend = new DockerBackend("img");
  const { argv } = backend.wrapCommand(["x"], { cwd: "/tmp/ws", network: "bridge", workspaceAccess: "ro" });
  expect(argv.join(" ")).toContain("--network bridge");
  expect(argv.join(" ")).toContain("-v /tmp/ws:/workspace:ro");
});

test("credential-root binds are blocked, symlinks resolved", () => {
  const home = homedir();
  expect(() => validateBind(`${home}/.ssh:/keys:ro`)).toThrow(/blocked/i);
  expect(() => validateBind(`${home}/.aws:/aws:rw`)).toThrow(/blocked/i);
  expect(() => validateBind(`${home}/projects/x:/x:ro`)).not.toThrow();
});

test("workspace cwd bind is validated against credential roots", () => {
  const backend = new DockerBackend("img");
  const home = homedir();
  expect(() => backend.wrapCommand(["x"], { cwd: `${home}/.ssh` })).toThrow(/blocked/i);
});

test("extraBinds are validated and appended", () => {
  const backend = new DockerBackend("img");
  const home = homedir();
  expect(() => backend.wrapCommand(["x"], { cwd: "/t", extraBinds: [`${home}/.ssh:/k:ro`] })).toThrow(/blocked/i);
  const { argv } = backend.wrapCommand(["x"], { cwd: "/t", extraBinds: ["/data/in:/in:ro"] });
  expect(argv.join(" ")).toContain("-v /data/in:/in:ro");
});
