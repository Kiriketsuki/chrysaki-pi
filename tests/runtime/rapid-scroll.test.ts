import assert from "node:assert/strict";
import test from "node:test";
import { installRapidScroll, parseSgrMouse } from "../../extensions/runtime/rapid-scroll.ts";

test("rapid scroll parses SGR middle-button events", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<1;20;8M"), { button: 1, x: 19, y: 7, release: false });
  assert.deepEqual(parseSgrMouse("\x1b[<33;20;12M"), { button: 33, x: 19, y: 11, release: false });
  assert.equal(parseSgrMouse("plain text"), undefined);
});

test("rapid scroll capability-checks regular mode and restores fullscreen hooks", async () => {
  const regular: any = { mode: "regular", requestRender() {} };
  assert.doesNotThrow(() => installRapidScroll(regular)());

  const movements: number[] = [];
  const forwarded: string[] = [];
  const original = (data: string) => { forwarded.push(data); return undefined; };
  const fullscreen: any = {
    mode: "fullscreen",
    handleViewportInput: original,
    scrollBy: (lines: number) => movements.push(lines),
    requestRender() {},
  };
  const dispose = installRapidScroll(fullscreen);
  const wheelUp = "\x1b[<64;10;5M";
  const wheelDown = "\x1b[<65;10;5M";
  fullscreen.handleViewportInput(wheelUp);
  fullscreen.handleViewportInput(wheelDown);
  assert.deepEqual(forwarded, [wheelUp, wheelDown]);

  fullscreen.handleViewportInput("\x1b[<1;10;5M");
  fullscreen.handleViewportInput("\x1b[<33;10;1M");
  await new Promise((resolve) => setTimeout(resolve, 45));
  fullscreen.handleViewportInput("\x1b[<33;10;13M");
  await new Promise((resolve) => setTimeout(resolve, 45));
  // Some terminals use generic button 3 for mouse-up rather than middle
  // button 1. It must still stop the timer so wheel input is not fought.
  fullscreen.handleViewportInput("\x1b[<3;10;13m");
  const movementCount = movements.length;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.ok(movements.some((lines) => lines < 0));
  assert.ok(movements.some((lines) => lines > 0));
  assert.equal(movements.length, movementCount);
  dispose();
  assert.notEqual(fullscreen.handleViewportInput, undefined);
});
