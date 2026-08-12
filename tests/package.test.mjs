import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const theme = JSON.parse(await readFile(new URL("../themes/chrysaki.json", import.meta.url), "utf8"));
const required = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg",
  "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
  "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator",
  "syntaxPunctuation", "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode"
];

test("Pi manifest discovers the complete interface package", () => {
  assert.deepEqual(packageJson.pi.themes, ["./themes"]);
  assert.deepEqual(packageJson.pi.extensions, ["./extensions/index.ts"]);
  assert.deepEqual(packageJson.pi.prompts, ["./prompts"]);
  assert.equal(packageJson.version, "1.2.3");
  assert.match(packageJson.pi.image, /\/v1\.2\.3\/docs\/chrysaki-pi-interface\.png$/);
  assert.ok(packageJson.files.includes("scripts/codex-rate-limits.mjs"));
  assert.match(packageJson.dependencies["@kiriketsuki/chrysaki-core"], /#v1\.0\.0$/);
  for (const dependency of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]) {
    assert.equal(packageJson.peerDependencies[dependency], "*");
  }
  assert.equal(theme.name, "chrysaki");
});

test("all required Pi roles resolve to core variables", () => {
  for (const role of required) {
    assert.ok(role in theme.colors, `missing Pi role ${role}`);
    const value = theme.colors[role];
    assert.ok(value === "" || value in theme.vars || /^#[0-9a-f]{6}$/i.test(value), `unresolved ${role}: ${value}`);
  }
});

test("semantic states remain distinct in 256-colour approximation", () => {
  const ansi = (hex) => {
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    const cube = rgb.map((channel) => Math.round(channel / 255 * 5));
    return 16 + 36 * cube[0] + 6 * cube[1] + cube[2];
  };
  const roles = ["success", "warning", "error"].map((role) => ansi(theme.vars[theme.colors[role]]));
  assert.equal(new Set(roles).size, roles.length);
});
