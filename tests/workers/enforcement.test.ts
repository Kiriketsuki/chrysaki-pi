import assert from "node:assert/strict";
import test from "node:test";
import { assertInteractiveModelArgv, assertNoHeadlessModelShell, findHeadlessModelArgv, findHeadlessModelShell, HeadlessInvocationError, modelShellBlockReason } from "../../extensions/workers/enforcement.ts";

const prohibited: Array<[string[], string]> = [
  [["pi", "-p", "task"], "Pi"],
  [["/usr/local/bin/pi", "--mode", "json", "task"], "Pi"],
  [["pi", "--mode=rpc"], "Pi"],
  [["claude", "--print", "task"], "Claude"],
  [["claude", "-p", "task"], "Claude"],
  [["claude", "--output-format=stream-json"], "Claude"],
  [["codex", "exec", "task"], "Codex"],
  [["codex", "--model", "gpt-5", "review"], "Codex"],
  [["codex", "--json"], "Codex"],
];

for (const [argv, provider] of prohibited) test(`final argv rejects ${argv.join(" ")}`, () => {
  assert.match(findHeadlessModelArgv(argv)?.reason ?? "", new RegExp(provider));
  assert.throws(() => assertInteractiveModelArgv(argv), HeadlessInvocationError);
});

test("interactive adapter argv remains allowed and provider identity is enforced", () => {
  assert.doesNotThrow(() => assertInteractiveModelArgv(["pi", "--mode", "tui"], "pi"));
  assert.doesNotThrow(() => assertInteractiveModelArgv(["claude", "--dangerously-skip-permissions"], "claude"));
  assert.doesNotThrow(() => assertInteractiveModelArgv(["codex", "--full-auto"], "codex"));
  assert.doesNotThrow(() => assertInteractiveModelArgv(["/opt/pi/dist/cli.js", "--mode", "tui"], "pi", "/opt/pi/dist/cli.js"));
  assert.throws(() => assertInteractiveModelArgv(["/opt/other/cli.js"], "pi", "/opt/pi/dist/cli.js"), /different executable/);
  assert.throws(() => assertInteractiveModelArgv(["claude"], "pi"), /different executable/);
  assert.throws(() => assertInteractiveModelArgv([]), /argv array/);
});

const shellCommands = [
  "pi -p 'do work'",
  "env TOKEN=x /usr/bin/claude --print task",
  "env -u TOKEN pi -p task",
  "command codex exec task",
  "printf ready && pi --mode=json task",
  "echo ok | claude -p task",
  "bash -c 'codex --model gpt-5 review'",
  "p''i --mode rpc",
  "timeout 10s claude --output-format json",
  "xargs codex exec",
  "find . -exec claude --print task ;",
  "echo `pi -p task`",
  "eval 'codex exec task'",
];
for (const command of shellCommands) test(`model-issued shell enforcement blocks ${command}`, () => {
  assert.ok(findHeadlessModelShell(command));
  assert.throws(() => assertNoHeadlessModelShell(command), /worker_run/);
  assert.match(modelShellBlockReason(command) ?? "", /worker_run/);
});

test("shell enforcement does not block interactive CLIs, documentation searches, or telemetry helpers", () => {
  const allowed = [
    "pi --mode tui",
    "claude --dangerously-skip-permissions",
    "codex --full-auto",
    "echo 'pi -p task'",
    "rg 'codex exec' docs",
    "node scripts/codex-rate-limits.mjs",
    "git commit -m 'document claude --print'",
  ];
  for (const command of allowed) assert.equal(findHeadlessModelShell(command), undefined, command);
  assert.equal(modelShellBlockReason(42), undefined);
});
