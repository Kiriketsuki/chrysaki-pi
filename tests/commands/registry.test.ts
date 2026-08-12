import assert from "node:assert/strict";
import test from "node:test";
import { CommandRegistry, filterCommands, helpLines, type CommandDefinition } from "../../extensions/commands/registry.ts";

const commands: CommandDefinition<{ git: boolean }>[] = [
  { id: "view.rail", label: "Show Rail", category: "View", description: "Open context rail", handler: () => {} },
  { id: "git.refresh", label: "Refresh Git", category: "Git", description: "Refresh repository", keyHint: "g", available: (ctx) => ctx.git, handler: () => {} },
  { id: "help.commands", label: "Command Help", category: "Help", description: "Show all commands", handler: () => {} },
];

test("fuzzy filtering preserves registry order without a query and ranks matches deterministically", () => {
  assert.deepEqual(filterCommands(commands, "").map((item) => item.id), commands.map((item) => item.id));
  assert.deepEqual(filterCommands(commands, "r").map((item) => item.id), ["git.refresh", "view.rail"]);
  assert.deepEqual(filterCommands(commands, "rg").map((item) => item.id), ["git.refresh"]);
});

test("registry controls availability, execution, and generated help", async () => {
  const registry = new CommandRegistry<{ git: boolean }>(); commands.forEach((command) => registry.register(command));
  assert.deepEqual(registry.list({ git: false }).map((item) => item.id), ["view.rail", "help.commands"]);
  assert.equal(await registry.execute("git.refresh", { git: false }), false);
  assert.equal(await registry.execute("git.refresh", { git: true }), true);
  assert.ok(helpLines(registry.list({ git: true })).some((line) => line.includes("[g]")));
  assert.throws(() => registry.register(commands[0]!), /duplicate command/);
});
