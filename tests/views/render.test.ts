import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StateStore } from "../../extensions/runtime/store.ts";
import { initialSnapshot, type GitSnapshot } from "../../extensions/runtime/types.ts";
import { ChrysakiFooter, footerMode } from "../../extensions/views/footer.ts";
import { renderGitModule } from "../../extensions/views/git-module.ts";
import { promoteModule, railVisible } from "../../extensions/views/rail.ts";

const theme: any = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const git: GitSnapshot = { available: true, branch: "feat/interface", commit: "abc123", ahead: 2, behind: 1, files: [{ path: "extensions/a-very-long-file-name.ts", indexStatus: " ", worktreeStatus: "M", added: 12, deleted: 3 }], graph: [{ hash: "abc123", refs: "HEAD", subject: "Build interface" }, { hash: "def456", refs: "", subject: "Foundation" }], collectedAt: 1 };

test("footer selects responsive density and every line fits", () => {
  const store = new StateStore({ ...initialSnapshot(), model: "A very long model display name", git });
  const footer = new ChrysakiFooter(store, theme, () => {});
  assert.equal(footerMode(79), "compact"); assert.equal(footerMode(140), "rich");
  for (const width of [20, 40, 79, 100, 160]) for (const line of footer.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  footer.dispose();
});

test("rail policy preserves manual ownership", () => {
  const base = initialSnapshot().rail;
  assert.equal(railVisible(base, 160), false);
  const promoted = promoteModule(base, "git");
  assert.equal(railVisible(promoted, 119), false); assert.equal(railVisible(promoted, 120), true);
  assert.equal(railVisible({ ...promoted, visibility: "hidden" }, 200), false);
  assert.equal(railVisible({ ...promoted, visibility: "pinned", promotedCount: 0 }, 100), true);
});

test("mini Git module uses Chrysaki graph glyphs, double borders, and bounded width", () => {
  const lines = renderGitModule(git, 42, 20, theme);
  assert.ok(lines[0]?.startsWith("╔")); assert.ok(lines.at(-1)?.startsWith("╚"));
  assert.ok(lines.some((line) => line.includes("●"))); assert.ok(lines.some((line) => line.includes("┆")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
});
