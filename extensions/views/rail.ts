import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import type { StateStore } from "../runtime/store.ts";
import type { RailModule, RailState, UiSnapshot } from "../runtime/types.ts";
import { doubleBox, fit, formatCount } from "./layout.ts";
import { renderGitModule } from "./git-module.ts";

export function railVisible(state: RailState, terminalWidth: number): boolean {
  if (state.visibility === "hidden") return false;
  if (state.visibility === "pinned") return terminalWidth >= 80;
  return terminalWidth >= state.threshold && state.promotedCount > 0;
}

export function promoteModule(state: RailState, module: RailModule): RailState {
  return Object.freeze({ ...state, promoted: module, promotedCount: 1, modules: Object.freeze([module, ...state.modules.filter((item) => item !== module)]) });
}

export interface RailLayout {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export class RailComponent {
  focused = false;
  private cache = new Map<string, string[]>();
  private unsubscribe: () => void;
  readonly layout: RailLayout = { offsetX: 0, offsetY: 0, width: 30, height: 72 };
  constructor(private store: StateStore<UiSnapshot>, private theme: Theme, private tui: TUI, private releaseFocus: () => void) {
    this.unsubscribe = store.subscribe((state) => state, () => { this.invalidate(); this.tui.requestRender(); });
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.releaseFocus(); return; }
    const resize = matchesKey(data, "alt+shift+left") || matchesKey(data, "alt+shift+right") || matchesKey(data, "alt+shift+up") || matchesKey(data, "alt+shift+down");
    if (resize) {
      if (matchesKey(data, "alt+shift+left")) this.layout.width = Math.max(22, this.layout.width - 2);
      if (matchesKey(data, "alt+shift+right")) this.layout.width = Math.min(60, this.layout.width + 2);
      if (matchesKey(data, "alt+shift+up")) this.layout.height = Math.max(35, this.layout.height - 5);
      if (matchesKey(data, "alt+shift+down")) this.layout.height = Math.min(95, this.layout.height + 5);
    } else if (matchesKey(data, "alt+left") || matchesKey(data, "alt+right") || matchesKey(data, "alt+up") || matchesKey(data, "alt+down")) {
      if (matchesKey(data, "alt+left")) this.layout.offsetX -= 2;
      if (matchesKey(data, "alt+right")) this.layout.offsetX += 2;
      if (matchesKey(data, "alt+up")) this.layout.offsetY -= 1;
      if (matchesKey(data, "alt+down")) this.layout.offsetY += 1;
    } else return;
    this.invalidate(); this.tui.requestRender();
  }
  render(width: number): string[] {
    const cacheKey = `${width}:${this.focused}`;
    const cached = this.cache.get(cacheKey); if (cached) return cached;
    const state = this.store.get();
    const module = state.rail.promoted ?? state.rail.modules[0] ?? "context";
    let lines: string[];
    if (module === "git") lines = renderGitModule(state.git, width, this.tui.terminal.rows, this.theme, this.focused);
    else if (module === "context") lines = doubleBox([
      ` ${this.theme.fg("accent", `${state.contextPercent.toFixed(0)}%`)} context`,
      ` ${formatCount(state.contextTokens)} / ${formatCount(state.contextWindow)} tokens`,
      ` ${this.theme.fg("muted", state.model)} · ${state.thinkingLevel}`,
    ], width, "CONTEXT");
    else if (module === "files") lines = doubleBox(state.git.files.slice(0, 12).map((file) => ` ${file.worktreeStatus.trim() || file.indexStatus.trim()} ${fit(file.path, width - 6)}`), width, "FILES");
    else if (module === "activity") lines = doubleBox(state.activeProcesses.length ? state.activeProcesses.map((name) => ` ● ${name}`) : [" idle"], width, "ACTIVITY");
    else lines = doubleBox([" No active plan tasks", this.theme.fg("dim", " Use the command deck for actions")], width, "TASKS");
    this.cache.set(cacheKey, lines); return lines;
  }
  invalidate(): void { this.cache.clear(); }
  dispose(): void { this.unsubscribe(); this.cache.clear(); }
}

export class SidebarAdapter {
  private handle?: OverlayHandle;
  private close?: () => void;
  private disposed = false;
  show(handle: OverlayHandle, close: () => void): void { if (this.disposed) { handle.hide(); return; } this.handle?.hide(); this.handle = handle; this.close = close; handle.setHidden(false); }
  hide(): void { this.handle?.setHidden(true); }
  pin(): void { this.handle?.setHidden(false); }
  promote(): void { this.handle?.setHidden(false); }
  focus(): void { this.handle?.setHidden(false); this.handle?.focus(); }
  unfocus(): void { this.handle?.unfocus(); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.handle?.hide(); this.close?.(); this.handle = undefined; this.close = undefined; }
}
