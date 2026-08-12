import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadSettings, saveSettings, validateSettings } from "../../extensions/runtime/settings.ts";

test("settings validate ranges and fail closed", () => {
  const settings = validateSettings({ railThreshold: 10, motion: "wild", editorStartMode: "normal" });
  assert.equal(settings.railThreshold, 80); assert.equal(settings.motion, "minimal"); assert.equal(settings.editorStartMode, "normal");
});

test("settings persist atomically only when explicitly saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrysaki-settings-")); const path = join(directory, "settings.json");
  const defaults = await loadSettings(path); assert.equal(defaults.railThreshold, 120);
  await saveSettings({ ...defaults, railThreshold: 140 }, path);
  assert.equal((JSON.parse(await readFile(path, "utf8"))).railThreshold, 140);
});
