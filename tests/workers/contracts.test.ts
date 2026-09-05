import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, createWorkerLaunchContract, digestValue, taskDigest } from "../../extensions/workers/contracts.ts";
import { validateWorkerConfig } from "../../extensions/workers/config.ts";
import { WORKER_SCHEMA_VERSION, type WorkerJob } from "../../extensions/workers/types.ts";

const id = "wrk_12345678-1234-4123-8123-123456789abc";
const runId = "run_12345678-1234-4123-8123-123456789abc";

test("canonical digests are deterministic across object insertion order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  assert.equal(digestValue({ z: 1, a: 2 }), digestValue({ a: 2, z: 1 }));
  assert.notEqual(taskDigest({ task: "one" }), taskDigest({ task: "two" }));
});

test("launch contracts bind task, identity, authority, routing, workspace, and timing", () => {
  const config = validateWorkerConfig({}); const timestamp = "2026-03-20T10:00:00.000Z";
  const job: WorkerJob = { schemaVersion: WORKER_SCHEMA_VERSION, id, request: { task: "review", capabilities: ["code"], access: "read", allowFallback: true, cwd: "/repo", metadata: {} }, state: "starting", createdAt: timestamp, updatedAt: timestamp, ownerId: "owner", runId, parentSessionId: "/session", childIndex: 0, depth: 0, mailboxPath: `/jobs/${id}` };
  const input = { job, adapterId: "pi" as const, executablePath: "/bin/pi", model: "test", ceiling: config.capabilityCeiling, workspace: { mode: "read" as const, sourcePath: "/repo", workspacePath: "/repo", owningJobId: id, kind: "readonly-bind" as const, dirty: false, cleanupEligible: true, createdAt: timestamp }, sandbox: { active: true as const, binary: "bwrap", guestCwd: "/workspace" }, timeoutMs: 1000, retentionMs: 2000, attempts: [{ adapterId: "pi" as const, eligible: true, executablePath: "/bin/pi" }], policySources: { concurrency: "global" as const, timeoutMs: "global" as const, retentionMs: "global" as const, routingOrder: "global" as const, allowFallback: "global" as const } };
  const first = createWorkerLaunchContract(input); const second = createWorkerLaunchContract(input);
  assert.equal(first.digest, second.digest); assert.equal(first.identity.runId, runId); assert.equal(first.authority.access, "read"); assert.equal(first.routing.attempts[0].adapterId, "pi");
});
