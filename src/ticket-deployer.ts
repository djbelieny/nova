// src/ticket-deployer.ts
import { gitc } from "./ticket-fixer.ts";

async function sh(cwd: string, command: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bash", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, output: (out + err).trim().slice(-2000) };
}

export async function deployFix(opts: {
  project: { local_path: string; default_branch: string; deploy_command: string; rollback_command: string };
  branchName: string; dryRun?: boolean; pushRemote?: boolean;
}): Promise<{ ok: boolean; log: string[]; rolledBack: boolean }> {
  const { project, branchName } = opts;
  const log: string[] = [];

  const checkout = await gitc(project.local_path, ["checkout", project.default_branch]);
  if (checkout.code !== 0) { log.push(`checkout failed: ${checkout.stderr.slice(0,300)}`); return { ok: false, log, rolledBack: false }; }
  const merge = await gitc(project.local_path, ["merge", "--no-ff", "-m", `merge ${branchName}`, branchName]);
  if (merge.code !== 0) { log.push(`merge failed: ${merge.stderr.slice(0,300)}`); return { ok: false, log, rolledBack: false }; }
  log.push(`merged ${branchName} → ${project.default_branch}`);

  if (opts.dryRun) {
    if (opts.pushRemote) log.push(`DRY-RUN push: git push origin ${project.default_branch}`);
    log.push(`DRY-RUN deploy: ${project.deploy_command}`);
    return { ok: true, log, rolledBack: false };
  }

  if (opts.pushRemote) {
    const push = await gitc(project.local_path, ["push", "origin", project.default_branch]);
    log.push(push.code === 0 ? "pushed" : `push failed: ${push.stderr.slice(0,300)}`);
    if (push.code !== 0) return { ok: false, log, rolledBack: false };
  }

  const deploy = await sh(project.local_path, project.deploy_command);
  if (deploy.code === 0) {
    log.push("deploy ok");
    if (deploy.output) log.push(deploy.output);
    return { ok: true, log, rolledBack: false };
  }

  log.push(`deploy failed (exit ${deploy.code}) — rolling back`);
  if (deploy.output) log.push(deploy.output);
  const rb = await sh(project.local_path, project.rollback_command);
  log.push(rb.code === 0 ? "rollback ok" : `rollback FAILED (exit ${rb.code})`);
  if (rb.output) log.push(rb.output);
  return { ok: false, log, rolledBack: true };
}
