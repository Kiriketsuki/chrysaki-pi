import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { StateStore } from "../runtime/store.ts";
import type { RateLimitWindow, UiSnapshot } from "../runtime/types.ts";
import { columns, fit, formatCount } from "./layout.ts";

export type FooterMode = "compact" | "rich";
export function footerMode(width: number): FooterMode { return width < 100 ? "compact" : "rich"; }

function bar(percent: number, cells = 8): string {
  const filled = Math.max(0, Math.min(cells, Math.round(percent / 100 * cells)));
  return "◆".repeat(filled) + "◇".repeat(cells - filled);
}
function resetIn(epoch?: number): string {
  if (!epoch) return "";
  const seconds = Math.max(0, epoch - Math.floor(Date.now() / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
function rate(theme: Theme, label: string, window?: RateLimitWindow): string {
  if (!window) return theme.fg("dim", `${label} unavailable`);
  const role = window.usedPercent >= 75 ? "error" : window.usedPercent >= 50 ? "warning" : "success";
  const reset = resetIn(window.resetsAt);
  return theme.fg(role, `${label} ${bar(window.usedPercent)} ${window.usedPercent.toFixed(0)}%${reset ? ` (${reset})` : ""}`);
}
function repositoryStats(state: UiSnapshot): { added: number; deleted: number } {
  return state.git.files.reduce((total, file) => ({ added: total.added + file.added, deleted: total.deleted + file.deleted }), { added: 0, deleted: 0 });
}

function deckGrid(theme: Theme, cells: readonly string[], width: number): string {
  const gutter = 2;
  const separators = cells.length - 1;
  const innerWidth = Math.max(cells.length, width - gutter * 2 - separators * 3);
  const base = Math.floor(innerWidth / cells.length);
  const remainder = innerWidth - base * cells.length;
  const rendered = cells.map((cell, index) => {
    // Give spare columns to the left first: equal stops with a subtle left bias.
    const cellWidth = base + (index < remainder ? 1 : 0);
    const fitted = fit(cell, cellWidth);
    return fitted + " ".repeat(Math.max(0, cellWidth - visibleWidth(fitted)));
  });
  return fit(`${" ".repeat(gutter)}${rendered.join(theme.fg("borderMuted", " ─ "))}${" ".repeat(gutter)}`, width);
}

export class ChrysakiFooter {
  private cache = new Map<number, string[]>();
  private unsubscribe: () => void;

  constructor(private store: StateStore<UiSnapshot>, private theme: Theme, invalidateView: () => void) {
    this.unsubscribe = store.subscribe((state) => state, () => { this.invalidate(); invalidateView(); });
  }

  render(width: number): string[] {
    const cached = this.cache.get(width);
    if (cached) return cached;
    const state = this.store.get();
    const branch = state.git.available ? state.git.branch ?? "HEAD" : "no-git";
    const changes = state.git.files.length;
    const promoted = state.rail.promotedCount ? ` ↑${state.rail.promoted ?? "context"}` : "";
    let result: string[];
    if (footerMode(width) === "compact") {
      const context = state.contextWindow ? `${state.contextPercent.toFixed(0)}%` : "—";
      result = [fit(`${this.theme.fg("accent", "⬢")} ${fit(state.model, Math.max(8, width - 30))} ${this.theme.fg("muted", `· ${state.thinkingLevel} · ctx ${context} ·  ${branch}${changes ? ` ±${changes}` : ""}${promoted}`)}`, width)];
    } else if (width < 140) {
      const context = `${formatCount(state.contextTokens)}/${formatCount(state.contextWindow)} ${state.contextPercent.toFixed(0)}%`;
      result = [
        columns(`${this.theme.fg("accent", "⬢ CHRYSAKI")}  ${this.theme.fg("text", state.model)} · ${state.thinkingLevel}`, this.theme.fg("muted", `ctx ${context} · $${state.usage.costUsd.toFixed(3)}`), width),
        columns(this.theme.fg("muted", `↓${formatCount(state.usage.input)} ↑${formatCount(state.usage.output)} cache ${formatCount(state.usage.cacheRead + state.usage.cacheWrite)}`), this.theme.fg("muted", ` ${branch}${changes ? ` ±${changes}` : ""}${promoted}`), width),
      ].map((line) => fit(line, width));
    } else {
      const repo = repositoryStats(state);
      const cwd = state.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") || state.cwd;
      const contextRole = state.contextPercent >= 85 ? "error" : state.contextPercent >= 60 ? "warning" : "success";
      const context = `${bar(state.contextPercent)} ${state.contextPercent.toFixed(0)}% (${formatCount(state.contextTokens)}/${formatCount(state.contextWindow)})`;
      result = [
        deckGrid(this.theme, [
          this.theme.fg("accent", "◆ CHRYSAKI"),
          `${this.theme.bold(state.model)}  ${this.theme.fg("muted", state.thinkingLevel)}`,
          this.theme.fg("accent", cwd),
          this.theme.fg("muted", `${state.provider} · pi`),
        ], width),
        deckGrid(this.theme, [
          rate(this.theme, "▰ 5h", state.rateLimits.fiveHour),
          rate(this.theme, "▱ 7d", state.rateLimits.sevenDay),
          this.theme.fg("warning", `$ ${state.usage.costUsd.toFixed(3)}`),
          "",
        ], width),
        deckGrid(this.theme, [
          this.theme.fg(contextRole, `▰ ctx  ${context}`),
          this.theme.fg("muted", `↓ input   ${formatCount(state.usage.input)}`),
          this.theme.fg("muted", `↑ output  ${formatCount(state.usage.output)}`),
          this.theme.fg("muted", `⧈ cache   ${formatCount(state.usage.cacheRead + state.usage.cacheWrite)}`),
        ], width),
        deckGrid(this.theme, [
          this.theme.fg("muted", `⎇ ${branch}${state.git.ahead ? ` ↑${state.git.ahead}` : ""}${state.git.behind ? ` ↓${state.git.behind}` : ""}`),
          this.theme.fg("muted", `⊙ ${state.git.commit ?? "—"}`),
          `${this.theme.fg("success", `+${repo.added}`)}  ${this.theme.fg("error", `-${repo.deleted}`)}`,
          `◆ ${changes} files${promoted}`,
        ], width),
      ];
    }
    this.cache.set(width, result);
    return result;
  }

  invalidate(): void { this.cache.clear(); }
  dispose(): void { this.unsubscribe(); this.cache.clear(); }
}
