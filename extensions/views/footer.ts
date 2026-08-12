import type { Theme } from "@earendil-works/pi-coding-agent";
import type { UiSnapshot } from "../runtime/types.ts";
import type { StateStore } from "../runtime/store.ts";
import { columns, fit, formatCount } from "./layout.ts";

export type FooterMode = "compact" | "rich";
export function footerMode(width: number): FooterMode { return width < 100 ? "compact" : "rich"; }

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
    let line: string;
    if (footerMode(width) === "compact") {
      line = `${this.theme.fg("accent", "⬢")} ${fit(state.model, Math.max(8, width - 24))} ${this.theme.fg("muted", ` ${branch}${changes ? ` ±${changes}` : ""}${promoted}`)}`;
    } else {
      const left = `${this.theme.fg("accent", "⬢ CHRYSAKI")}  ${this.theme.fg("text", state.model)} ${this.theme.fg("muted", `· ${state.thinkingLevel}`)}`;
      const context = `${formatCount(state.contextTokens)}/${formatCount(state.contextWindow)} ${state.contextPercent.toFixed(0)}%`;
      const right = this.theme.fg("muted", ` ${branch}${state.git.ahead ? ` ↑${state.git.ahead}` : ""}${state.git.behind ? ` ↓${state.git.behind}` : ""}${changes ? `  ±${changes}` : ""}  ctx ${context}${promoted}`);
      line = columns(left, right, width);
    }
    const result = [fit(line, width)];
    this.cache.set(width, result);
    return result;
  }

  invalidate(): void { this.cache.clear(); }
  dispose(): void { this.unsubscribe(); this.cache.clear(); }
}
