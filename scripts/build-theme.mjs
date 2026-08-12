import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = JSON.parse(await readFile(path.join(root, "node_modules/@kiriketsuki/chrysaki-core/dist/chrysaki.json"), "utf8"));
const vars = core.tokens;
const colors = {
  accent: "emerald-light", border: "blue-light", borderAccent: "teal-light", borderMuted: "border",
  success: "emerald-light", error: "error-light", warning: "blonde", muted: "text-secondary", dim: "text-muted", text: "text-primary", thinkingText: "text-secondary",
  selectedBg: "raised", scrollbarThumb: "elevated", userMessageBg: "surface", userMessageText: "text-primary",
  customMessageBg: "amethyst-dim", customMessageText: "text-primary", customMessageLabel: "amethyst-light",
  toolPendingBg: "surface", toolSuccessBg: "emerald-dim", toolErrorBg: "error-dim", toolTitle: "text-primary", toolOutput: "text-secondary",
  mdHeading: "blonde", mdLink: "cerulean", mdLinkUrl: "text-muted", mdCode: "teal-light", mdCodeBlock: "text-primary",
  mdCodeBlockBorder: "border", mdQuote: "text-secondary", mdQuoteBorder: "amethyst-light", mdHr: "border", mdListBullet: "emerald-light",
  toolDiffAdded: "emerald-light", toolDiffRemoved: "error-light", toolDiffContext: "text-muted",
  syntaxComment: "text-muted", syntaxKeyword: "cerulean", syntaxFunction: "blonde-light", syntaxVariable: "text-primary",
  syntaxString: "emerald-light", syntaxNumber: "topaz", syntaxType: "teal-light", syntaxOperator: "amethyst-light", syntaxPunctuation: "text-secondary",
  thinkingOff: "border", thinkingMinimal: "slate", thinkingLow: "blue-light", thinkingMedium: "teal-light", thinkingHigh: "amethyst-light",
  thinkingXhigh: "rhodolite", thinkingMax: "error-light", bashMode: "blonde"
};
for (const [role, token] of Object.entries(colors)) {
  if (!(token in vars)) throw new Error(`Pi role ${role} references missing core token ${token}`);
}
const theme = {
  $schema: "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  name: "chrysaki",
  vars,
  colors,
  export: { pageBg: "abyss", cardBg: "surface", infoBg: "blue-dim" }
};
await mkdir(path.join(root, "themes"), { recursive: true });
await writeFile(path.join(root, "themes/chrysaki.json"), `${JSON.stringify(theme, null, 2)}\n`);
console.log(`Generated Pi theme from chrysaki-core v${core.version}.`);
