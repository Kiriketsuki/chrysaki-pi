import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { StateStore } from "../../extensions/runtime/store.ts";
import { initialSnapshot, type GitSnapshot } from "../../extensions/runtime/types.ts";
import { CommandDeck } from "../../extensions/views/command-deck.ts";
import { ChrysakiFooter, footerMode } from "../../extensions/views/footer.ts";
import { renderGitModule } from "../../extensions/views/git-module.ts";
import { promoteModule, RailComponent, railVisible } from "../../extensions/views/rail.ts";

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

test("command deck uses an opaque Chrysaki frame and stays width-bounded", () => {
  const deckTheme: any = {
    fg: (_role: string, text: string) => text,
    bg: (role: string, text: string) => `[${role}]${text}[/${role}]`,
    bold: (text: string) => text,
  };
  const deck = new CommandDeck<any>({ requestRender() {} } as any, deckTheme, [{
    id: "git.focus", label: "Focus Git Panel", category: "Git", description: "Focus the floating panel", handler() {},
  }], () => {});
  const lines = deck.render(60);
  assert.ok(lines[0]?.includes("COMMAND PALETTE"));
  assert.ok(lines.some((line) => line.includes("toolPendingBg")));
  assert.ok(lines.every((line) => visibleWidth(line.replace(/\[(?:\/)?\w+\]/g, "")) <= 60));
});

test("focused rail remounts after move and resize input", () => {
  const store = new StateStore(initialSnapshot());
  const layout = { offsetX: 0, offsetY: 0, width: 30, height: 72 };
  let remounts = 0;
  const tui: any = { terminal: { rows: 40 }, requestRender() {} };
  const rail = new RailComponent(store, theme, tui, layout, () => {}, () => { remounts++; });
  rail.handleInput("\x1b[1;3D");
  rail.handleInput("\x1b[1;4C");
  assert.equal(layout.offsetX, -2); assert.equal(layout.width, 32); assert.equal(remounts, 2);
  rail.dispose();
});

test("mini Git module uses Chrysaki graph glyphs, sharp borders, and bounded width", () => {
  const lines = renderGitModule(git, 42, 20, theme);
  assert.ok(lines[0]?.startsWith("┌")); assert.ok(lines.at(-1)?.startsWith("└"));
  assert.ok(lines.some((line) => line.includes("●"))); assert.ok(lines.some((line) => line.includes("┆")));
  assert.ok(lines.every((line) => visibleWidth(line) <= 42));
});
