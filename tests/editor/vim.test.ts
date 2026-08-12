import assert from "node:assert/strict";
import test from "node:test";
import { VimEngine, type VimResult } from "../../extensions/editor/vim-core.ts";

function run(engine: VimEngine, keys: string[], text: string, cursor = 0): VimResult {
  let result: VimResult = { handled: true, text, cursor, mode: engine.mode, hint: engine.hint };
  for (const key of keys) result = engine.handle(key, result.text, result.cursor);
  return result;
}

test("sessions start in Insert and ciw follows practical Vim semantics", () => {
  const engine = new VimEngine(); assert.equal(engine.mode, "insert");
  const result = run(engine, ["escape", "c", "i", "w"], "hello world", 1);
  assert.equal(result.text, " world"); assert.equal(result.cursor, 0); assert.equal(result.mode, "insert");
});

test("counts, delete, paste, and undo preserve a register", () => {
  const engine = new VimEngine("normal");
  const deleted = run(engine, ["2", "x"], "abcd", 1);
  assert.equal(deleted.text, "ad");
  const pasted = run(engine, ["p"], deleted.text, deleted.cursor);
  assert.match(pasted.text, /b/);
  const undone = run(engine, ["u"], pasted.text, pasted.cursor);
  assert.equal(undone.text, deleted.text);
});

test("gg and G provide practical document motions", () => {
  const engine = new VimEngine("normal");
  const bottom = run(engine, ["G"], "one\ntwo", 0); assert.equal(bottom.cursor, 7);
  const top = run(engine, ["g", "g"], bottom.text, bottom.cursor); assert.equal(top.cursor, 0);
});

test("Visual mode exposes a selection and applies operators only to it", () => {
  const engine = new VimEngine("normal");
  const selected = run(engine, ["v", "l", "l"], "abcdef", 1);
  assert.deepEqual(selected.selection, [1, 4]);
  const deleted = run(engine, ["d"], selected.text, selected.cursor);
  assert.equal(deleted.text, "aef"); assert.equal(deleted.mode, "normal");
});

test("search, next match, and unsupported sequences are safe", () => {
  const engine = new VimEngine("normal");
  const found = run(engine, ["/", "b", "e", "t", "a", "enter"], "alpha beta beta", 0);
  assert.equal(found.cursor, 6);
  const next = run(engine, ["n"], found.text, found.cursor); assert.equal(next.cursor, 11);
  const unsupported = run(engine, ["q"], next.text, next.cursor);
  assert.equal(unsupported.text, next.text); assert.match(unsupported.hint, /Unsupported/);
});

test("control sequences are not claimed by the Vim engine adapter contract", () => {
  const engine = new VimEngine("normal");
  const result = engine.handle("ctrl+c", "safe", 0);
  assert.equal(result.text, "safe");
});
