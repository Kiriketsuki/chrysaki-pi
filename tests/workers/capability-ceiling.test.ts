import assert from "node:assert/strict";
import test from "node:test";
import { WORKER_CEILING_ENV, WORKER_DEPTH_ENV, WORKER_PARENT_RUN_ENV, parseInheritedWorkerContext, rootWorkerCapabilityCeiling, tightenWorkerCapabilityCeiling } from "../../extensions/workers/capability-ceiling.ts";
import { validateWorkerConfig } from "../../extensions/workers/config.ts";

test("capability ceilings only intersect adapters and capabilities and minimize authority", () => {
  const config = validateWorkerConfig({ maxActiveWorkers: 10, maxSpawnsPerRun: 20, maxSpawnsPerSession: 30 });
  const root = rootWorkerCapabilityCeiling(config, { allowedAdapters: ["pi", "claude"], maxAccess: "read", allowedCapabilities: ["read", "code"], maxDepth: 3, maxActiveWorkers: 8 });
  const child = tightenWorkerCapabilityCeiling(root, { allowedAdapters: ["pi", "codex"], maxAccess: "write", allowedCapabilities: ["code", "images"], maxDepth: 10, maxActiveWorkers: 50, maxSpawnsPerRun: 2 });
  assert.deepEqual(child.allowedAdapters, ["pi"]); assert.equal(child.maxAccess, "read"); assert.deepEqual(child.allowedCapabilities, ["code"]);
  assert.equal(child.maxDepth, 3); assert.equal(child.maxActiveWorkers, 8); assert.equal(child.maxSpawnsPerRun, 2);
});

test("inherited capability context is strict and preserves parent identity", () => {
  const config = validateWorkerConfig({ capabilityCeiling: { allowedAdapters: ["pi"], maxDepth: 2 } });
  const environment = { [WORKER_CEILING_ENV]: JSON.stringify(config.capabilityCeiling), [WORKER_DEPTH_ENV]: "1", [WORKER_PARENT_RUN_ENV]: "run_12345678-1234-4123-8123-123456789abc" };
  const parsed = parseInheritedWorkerContext(environment);
  assert.deepEqual(parsed.ceiling, config.capabilityCeiling); assert.equal(parsed.depth, 1); assert.equal(parsed.parentRunId, environment[WORKER_PARENT_RUN_ENV]);
  assert.throws(() => parseInheritedWorkerContext({ [WORKER_CEILING_ENV]: "{}" }), /Invalid inherited/);
});
