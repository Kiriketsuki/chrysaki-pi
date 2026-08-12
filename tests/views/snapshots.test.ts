import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { StateStore } from "../../extensions/runtime/store.ts";
import { initialSnapshot, type UiSnapshot } from "../../extensions/runtime/types.ts";
import { ChrysakiFooter } from "../../extensions/views/footer.ts";

const expected = JSON.parse(await readFile(new URL("../snapshots/responsive.json", import.meta.url), "utf8"));
const theme: any = { fg: (_role: string, text: string) => text, bold: (text: string) => text };

test("responsive narrow, standard, and wide snapshots remain stable", () => {
  const base = initialSnapshot();
  const store = new StateStore<UiSnapshot>({ ...base, model: "GPT-5", thinkingLevel: "high", contextTokens: 41_000, contextWindow: 100_000, contextPercent: 41, git: { available: true, branch: "main", commit: "abc", ahead: 1, behind: 0, files: [{ path: "a.ts", indexStatus: " ", worktreeStatus: "M", added: 1, deleted: 0 }], graph: [], collectedAt: 1 }, rail: { ...base.rail, promoted: "git" as const, promotedCount: 1 } });
  const footer = new ChrysakiFooter(store, theme, () => {});
  assert.deepEqual({ narrow: footer.render(60), standard: footer.render(100), wide: footer.render(160) }, expected);
  footer.dispose();
});
