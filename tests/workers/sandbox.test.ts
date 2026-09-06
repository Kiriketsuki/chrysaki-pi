import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SandboxManager } from "../../extensions/workers/sandbox.ts";
import { createWorkerId } from "../../extensions/workers/types.ts";
import { WorkspaceManager } from "../../extensions/workers/workspaces.ts";

const exec = promisify(execFile);

async function gitRepository() {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-sandbox-repo-")); await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "tests@example.invalid"]); await exec("git", ["-C", root, "config", "user.name", "Tests"]);
  await writeFile(join(root, "tracked.txt"), "parent\n"); await exec("git", ["-C", root, "add", "."]); await exec("git", ["-C", root, "commit", "-qm", "initial"]); return root;
}

async function profileFixture(mode: "read" | "write") {
  const source = await gitRepository(); const workspaceRoot = await mkdtemp(join(tmpdir(), "chrysaki-sandbox-workspaces-"));
  const workspaces = new WorkspaceManager({ root: workspaceRoot }); const jobId = createWorkerId(); const lease = await workspaces.create({ jobId, sourcePath: source, mode });
  const jobsRoot = await mkdtemp(join(tmpdir(), "chrysaki-sandbox-jobs-")); const mailbox = join(jobsRoot, jobId); await mkdir(mailbox, { mode: 0o700 });
  const auth = join(jobsRoot, "auth-token"); await writeFile(auth, "secret", { mode: 0o600 });
  const sandbox = new SandboxManager(); const profile = await sandbox.createProfile({ jobId, lease, mailboxPath: mailbox, cwd: source, authReadOnlyPaths: [{ hostPath: auth, guestPath: "/home/worker/.provider/auth.json" }], environment: { TEST_VALUE: "safe value" } });
  return { source, workspaces, lease, mailbox, auth, sandbox, profile };
}

test("sandbox profile exposes only explicit writable mounts and an ephemeral private home", async () => {
  const fixture = await profileFixture("read"); const { profile } = fixture;
  assert.equal(profile.active, true); assert.equal(profile.guestCwd, "/workspace");
  assert.equal(profile.mounts.find((mount) => mount.guestPath === "/workspace")?.writable, false);
  assert.equal(profile.mounts.find((mount) => mount.guestPath === "/mailbox")?.writable, true);
  assert.equal(profile.baseArgs.some((arg, index) => arg === "--ro-bind" && profile.baseArgs[index + 1] === "/"), false);
  assert.equal(profile.baseArgs.includes("--new-session"), false, "interactive workers must retain their dedicated tmux controlling TTY");
  assert.equal((await stat(profile.homePath)).mode & 0o777, 0o700);
  assert.equal(profile.authPaths.length, 1); assert.notEqual(profile.authPaths[0].hostPath, fixture.auth); assert.equal(profile.authPaths[0].guestPath, "/home/worker/.provider/auth.json");
  assert.equal(await readFile(profile.authPaths[0].hostPath, "utf8"), "secret");
  const argv = fixture.sandbox.buildArgv(profile, ["/bin/true"]); assert.equal(argv[0], "bwrap"); assert.equal(argv.at(-1), "/bin/true");
  await fixture.workspaces.cleanup(fixture.lease.owningJobId); fixture.workspaces.dispose(); fixture.sandbox.dispose();
});

test("Bubblewrap read profiles prevent source writes while allowing mailbox writes", async (t) => {
  const fixture = await profileFixture("read"); const readiness = await fixture.sandbox.preflight();
  if (!readiness.usable) { t.skip(`Bubblewrap unavailable: ${readiness.reason}`); return; }
  const argv = fixture.sandbox.buildArgv(fixture.profile, ["/bin/sh", "-c", "printf ok > /mailbox/proof.txt; if printf denied > /workspace/forbidden.txt 2>/dev/null; then exit 17; fi; if printf denied > /home/worker/.provider/auth.json 2>/dev/null; then exit 18; fi; if printf denied > /mailbox/runtime/home/.provider/auth.json 2>/dev/null; then exit 19; fi"]);
  await exec(argv[0], [...argv.slice(1)]);
  assert.equal(await readFile(join(fixture.mailbox, "proof.txt"), "utf8"), "ok");
  await assert.rejects(() => stat(join(fixture.source, "forbidden.txt")), { code: "ENOENT" });
  await fixture.workspaces.cleanup(fixture.lease.owningJobId); fixture.workspaces.dispose(); fixture.sandbox.dispose();
});

test("Bubblewrap preserves the resolver file through /etc symlinks without exposing /run", async (t) => {
  const fixture = await profileFixture("read");
  t.after(async () => { await fixture.workspaces.cleanup(fixture.lease.owningJobId); fixture.workspaces.dispose(); fixture.sandbox.dispose(); });
  const readiness = await fixture.sandbox.preflight();
  if (!readiness.usable) { t.skip(`Bubblewrap unavailable: ${readiness.reason}`); return; }
  let resolver: string;
  try { resolver = await realpath("/etc/resolv.conf"); }
  catch { t.skip("Host has no resolver file"); return; }
  // Do not query an external service: verify that the actual confined process
  // can read exactly the host resolver configuration through its normal path.
  const argv = fixture.sandbox.buildArgv(fixture.profile, ["/bin/cat", "/etc/resolv.conf"]);
  const result = await exec(argv[0], [...argv.slice(1)]);
  assert.equal(result.stdout, await readFile(resolver, "utf8"));
  assert.equal(fixture.profile.baseArgs.some((arg, index) => ["--bind", "--ro-bind"].includes(arg) && fixture.profile.baseArgs[index + 1] === "/run"), false);
  if (resolver.startsWith("/run/")) {
    assert.ok(fixture.profile.baseArgs.some((arg, index) => arg === "--ro-bind" && fixture.profile.baseArgs[index + 1] === resolver && fixture.profile.baseArgs[index + 2] === resolver));
  }
});

test("Bubblewrap write profiles modify only the dedicated worktree", async (t) => {
  const fixture = await profileFixture("write"); const readiness = await fixture.sandbox.preflight();
  if (!readiness.usable) { t.skip(`Bubblewrap unavailable: ${readiness.reason}`); return; }
  const argv = fixture.sandbox.buildArgv(fixture.profile, ["/bin/sh", "-c", "printf worker > /workspace/tracked.txt; git status --short > /mailbox/git-status.txt; printf result > /mailbox/result.md"]);
  await exec(argv[0], [...argv.slice(1)]);
  assert.match(await readFile(join(fixture.mailbox, "git-status.txt"), "utf8"), /tracked\.txt/);
  assert.equal(await readFile(join(fixture.lease.workspacePath, "tracked.txt"), "utf8"), "worker");
  assert.equal(await readFile(join(fixture.source, "tracked.txt"), "utf8"), "parent\n");
  assert.equal((await fixture.workspaces.cleanup(fixture.lease.owningJobId)).retained, true);
  await fixture.workspaces.cleanup(fixture.lease.owningJobId, { force: true }); fixture.workspaces.dispose(); fixture.sandbox.dispose();
});

test("sandbox creation fails closed on ownership, cwd, and environment mismatches", async () => {
  const fixture = await profileFixture("read");
  await assert.rejects(() => fixture.sandbox.createProfile({ jobId: createWorkerId(), lease: fixture.lease, mailboxPath: fixture.mailbox, cwd: fixture.source }), /ownership/);
  await assert.rejects(() => fixture.sandbox.createProfile({ jobId: fixture.lease.owningJobId, lease: fixture.lease, mailboxPath: fixture.mailbox, cwd: "/" }), /outside/);
  await assert.rejects(() => fixture.sandbox.createProfile({ jobId: fixture.lease.owningJobId, lease: fixture.lease, mailboxPath: fixture.mailbox, cwd: fixture.source, environment: { "BAD-NAME": "x" } }), /environment/);
  await fixture.workspaces.cleanup(fixture.lease.owningJobId); fixture.workspaces.dispose(); fixture.sandbox.dispose();
});
