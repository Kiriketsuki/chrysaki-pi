import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { filterCommands, type CommandDefinition } from "../commands/registry.ts";
import { columns, fit } from "./layout.ts";

export class CommandDeck<Context> {
  focused = false;
  private input = new Input();
  private selected = 0;
  private filtered: CommandDefinition<Context>[];
  private executed = false;

  constructor(private tui: TUI, private theme: Theme, private commands: readonly CommandDefinition<Context>[], private done: (id: string | null) => void) {
    this.filtered = [...commands];
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(null); return; }
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
    else if (matchesKey(data, "enter")) {
      const command = this.filtered[this.selected];
      if (command && !this.executed) { this.executed = true; this.done(command.id); }
      return;
    } else {
      this.input.handleInput(data);
      this.filtered = filterCommands(this.commands, this.input.getValue());
      this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
    }
    this.tui.requestRender();
  }
  render(width: number): string[] {
    if (width <= 2) return [this.theme.fg("borderAccent", "─".repeat(Math.max(1, width)))];
    const inner = width - 2;
    const fill = (line: string, selected = false): string => {
      const fitted = fit(line, inner);
      const padded = fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
      return `${this.theme.fg("borderAccent", "│")}${this.theme.bg(selected ? "selectedBg" : "toolPendingBg", padded)}${this.theme.fg("borderAccent", "│")}`;
    };
    this.input.focused = this.focused;
    const [query = ""] = this.input.render(Math.max(1, inner - 4));
    const title = fit(" ⬢ COMMAND PALETTE ", inner);
    const lines = [
      this.theme.bg("toolPendingBg", this.theme.fg("borderAccent", `┌${title}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}┐`)),
      fill(` ${this.theme.fg("warning", "❯")}  ${query}`),
      fill(this.theme.fg("borderMuted", ` ${"─".repeat(Math.max(1, inner - 2))} `)),
    ];
    if (!this.filtered.length) lines.push(fill(this.theme.fg("muted", "  No matching commands")));
    const start = Math.max(0, Math.min(this.selected - 6, Math.max(0, this.filtered.length - 12)));
    const categoryWidth = Math.max(7, ...this.filtered.slice(start, start + 12).map((command) => command.category.length));
    for (const [offset, command] of this.filtered.slice(start, start + 12).entries()) {
      const selected = start + offset === this.selected;
      const marker = selected ? this.theme.fg("warning", "▸") : " ";
      const category = this.theme.fg(selected ? "accent" : "muted", command.category.padEnd(categoryWidth));
      const label = selected ? this.theme.bold(command.label) : command.label;
      const hint = command.keyHint ? this.theme.fg("dim", command.keyHint) : "";
      lines.push(fill(` ${marker} ${category}  ${columns(label, hint, Math.max(1, inner - categoryWidth - 5))}`, selected));
      if (selected) lines.push(fill(`       ${this.theme.fg("muted", command.description)}`, selected));
    }
    lines.push(fill(this.theme.fg("dim", " ↑↓ navigate  ↵ execute  esc cancel")));
    lines.push(this.theme.bg("toolPendingBg", this.theme.fg("borderAccent", `└${"─".repeat(inner)}┘`)));
    return lines;
  }
  invalidate(): void { this.input.invalidate(); }
}
