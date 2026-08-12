import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { filterCommands, type CommandDefinition } from "../commands/registry.ts";
import { doubleBox } from "./layout.ts";

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
    this.input.focused = this.focused;
    const [query = ""] = this.input.render(Math.max(1, width - 8));
    const lines = [` ${this.theme.fg("warning", "❯")} ${query}`, this.theme.fg("borderMuted", " ╌".repeat(Math.max(1, Math.floor((width - 4) / 2))))];
    if (!this.filtered.length) lines.push(this.theme.fg("muted", " No matching commands"));
    const start = Math.max(0, Math.min(this.selected - 6, Math.max(0, this.filtered.length - 12)));
    for (const [offset, command] of this.filtered.slice(start, start + 12).entries()) {
      const selected = start + offset === this.selected;
      const marker = selected ? this.theme.fg("warning", "▸") : " ";
      const category = this.theme.fg(selected ? "accent" : "muted", command.category.padEnd(7));
      const label = selected ? this.theme.bold(command.label) : command.label;
      lines.push(truncateToWidth(` ${marker} ${category} ${label}${command.keyHint ? this.theme.fg("dim", `  ${command.keyHint}`) : ""}`, width - 2));
      if (selected) lines.push(truncateToWidth(`     ${this.theme.fg("muted", command.description)}`, width - 2));
    }
    lines.push(this.theme.fg("dim", " ↑↓ navigate · enter execute · esc cancel"));
    return doubleBox(lines, width, "COMMAND DECK");
  }
  invalidate(): void { this.input.invalidate(); }
}
