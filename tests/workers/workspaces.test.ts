import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createWorkerId } from "../../extensions/workers/types.ts";
import { WorkspaceError, WorkspaceManager } from "../../extensions/workers/workspaces.ts";

const exec = promisify(execFile);

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "chrysaki-repo-"));
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "tests@example.invalid"]);
  await exec("git", ["-C", root, "config", "user.name", "Tests"]);
  await writeFile(join(root, "tracked.txt"), "parent\n");
  await exec("git", ["-C", root, "add", "tracked.txt"]); await exec("git", ["-C", root, "commit", "-qm", "initial"]);
  return root;
}

test("read leases share the source checkout and defer write protection to Bubblewrap", async () => {
  const source = await repository(); const managed = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root: managed });
  const lease = await manager.create({ jobId: createWorkerId(), sourcePath: source, mode: "read" });
  assert.equal(lease.kind, "readonly-bind"); assert.equal(lease.workspacePath, source); assert.equal(lease.cleanupEligible, true);
  const loaded = await manager.load(lease.owningJobId); assert.deepEqual(loaded, lease);
  const cleanup = await manager.cleanup(lease.owningJobId); assert.equal(cleanup.removed, true);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "parent\n");
  manager.dispose();
});

test("write leases use detached Git worktrees and preserve parent isolation", async () => {
  const source = await repository(); const managed = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root: managed });
  const jobId = createWorkerId(); const lease = await manager.create({ jobId, sourcePath: source, mode: "write" });
  assert.equal(lease.kind, "git-worktree"); assert.notEqual(lease.workspacePath, source);
  assert.equal(await readFile(join(lease.workspacePath, "tracked.txt"), "utf8"), "parent\n");
  await writeFile(join(lease.workspacePath, "tracked.txt"), "worker\n");
  const dirty = await manager.inspectDirty(lease); assert.equal(dirty.dirty, true); assert.equal(dirty.cleanupEligible, false);
  const retained = await manager.cleanup(jobId); assert.deepEqual(retained, { removed: false, retained: true, dirty: true, reason: "Workspace contains unintegrated changes" });
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "parent\n");
  assert.equal((await stat(lease.workspacePath)).isDirectory(), true);
  const forced = await manager.cleanup(jobId, { force: true }); assert.equal(forced.removed, true);
  await assert.rejects(() => stat(lease.workspacePath), { code: "ENOENT" });
  manager.dispose();
});

test("committed but unintegrated worktree revisions are retained", async () => {
  const source = await repository(); const managed = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root: managed });
  const lease = await manager.create({ jobId: createWorkerId(), sourcePath: source, mode: "write" });
  await writeFile(join(lease.workspacePath, "tracked.txt"), "committed worker change\n");
  await exec("git", ["-C", lease.workspacePath, "add", "tracked.txt"]); await exec("git", ["-C", lease.workspacePath, "commit", "-qm", "worker change"]);
  const inspected = await manager.inspectDirty(lease); assert.equal(inspected.dirty, true);
  assert.equal((await manager.cleanup(lease.owningJobId)).retained, true);
  await manager.cleanup(lease.owningJobId, { force: true }); manager.dispose();
});

test("clean Git worktrees are removed with their ownership records", async () => {
  const source = await repository(); const managed = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root: managed });
  const lease = await manager.create({ jobId: createWorkerId(), sourcePath: source, mode: "write" });
  const result = await manager.cleanup(lease.owningJobId); assert.deepEqual(result, { removed: true, retained: false, dirty: false });
  const worktrees = (await exec("git", ["-C", source, "worktree", "list", "--porcelain"])).stdout;
  assert.equal(worktrees.includes(lease.workspacePath), false);
  manager.dispose();
});

test("non-Git writes fail closed unless copied workspaces are explicitly enabled", async () => {
  const source = await mkdtemp(join(tmpdir(), "chrysaki-nongit-")); await writeFile(join(source, "input.txt"), "source\n");
  const deniedRoot = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const denied = new WorkspaceManager({ root: deniedRoot });
  await assert.rejects(() => denied.create({ jobId: createWorkerId(), sourcePath: source, mode: "write" }), /explicitly enabled/); denied.dispose();
  const root = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root, allowCopiedNonGitWrites: true });
  const lease = await manager.create({ jobId: createWorkerId(), sourcePath: source, mode: "write" });
  assert.equal(lease.kind, "copy"); assert.equal(lease.dirty, true); assert.equal(lease.cleanupEligible, false);
  await writeFile(join(lease.workspacePath, "input.txt"), "worker\n");
  assert.equal((await manager.cleanup(lease.owningJobId)).retained, true);
  assert.equal(await readFile(join(source, "input.txt"), "utf8"), "source\n");
  assert.equal((await manager.cleanup(lease.owningJobId, { force: true })).removed, true); manager.dispose();
});

test("tampered ownership records cannot redirect cleanup", async () => {
  const source = await repository(); const root = await mkdtemp(join(tmpdir(), "chrysaki-workspaces-")); const manager = new WorkspaceManager({ root });
  const lease = await manager.create({ jobId: createWorkerId(), sourcePath: source, mode: "write" });
  const record = join(root, lease.owningJobId, "lease.json"); const value = JSON.parse(await readFile(record, "utf8")); value.workspacePath = source; await writeFile(record, JSON.stringify(value));
  await assert.rejects(() => manager.cleanup(lease.owningJobId, { force: true }), /ownership path/);
  assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "parent\n");
  // Restore the record so the test leaves no registered worktree behind.
  await writeFile(record, JSON.stringify(lease)); await manager.cleanup(lease.owningJobId, { force: true }); manager.dispose();
});
