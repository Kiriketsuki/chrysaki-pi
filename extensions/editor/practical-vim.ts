import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { VimEngine } from "./vim-core.ts";

function cursorOffset(text: string, cursor: { line: number; col: number }): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < cursor.line; index++) offset += (lines[index]?.length ?? 0) + 1;
  return offset + cursor.col;
}
function keyName(data: string): string | undefined {
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "backspace")) return "backspace";
  if (matchesKey(data, "enter")) return "enter";
  if (data.length === 1 && data.charCodeAt(0) >= 32) return data;
  return undefined;
}

export class PracticalVimEditor extends CustomEditor {
  readonly vim: VimEngine;
  private selection?: readonly [number, number];

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, startMode: "insert" | "normal" = "insert") {
    super(tui, theme, keybindings);
    this.vim = new VimEngine(startMode);
  }

  handleInput(data: string): void {
    const key = keyName(data);
    if (!key) { super.handleInput(data); return; }
    const text = this.getText();
    const beforeCursor = cursorOffset(text, this.getCursor());
    const result = this.vim.handle(key, text, beforeCursor);
    this.selection = result.selection;
    if (!result.handled) { super.handleInput(data); return; }
    if (result.text !== text || result.cursor !== beforeCursor) this.apply(result.text, result.cursor);
    this.tui.requestRender();
  }

  private apply(text: string, offset: number): void {
    this.setText(text);
    const lines = text.split("\n");
    let targetLine = 0; let targetCol = offset; let consumed = 0;
    for (let index = 0; index < lines.length; index++) {
      const length = lines[index]!.length;
      if (offset <= consumed + length) { targetLine = index; targetCol = offset - consumed; break; }
      consumed += length + 1;
    }
    const up = lines.length - 1 - targetLine;
    for (let index = 0; index < up; index++) super.handleInput("\x1b[A");
    super.handleInput("\x1b[H");
    for (let index = 0; index < targetCol; index++) super.handleInput("\x1b[C");
  }

  render(width: number): string[] {
    const lines = super.render(width);
    if (!lines.length) return lines;
    const label = ` ${this.vim.mode.toUpperCase()} `;
    const last = lines.length - 1;
    if (visibleWidth(lines[last]!) >= label.length) lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - label.length), "") + label;
    const preview = this.selection ? this.getText().slice(this.selection[0], this.selection[1]).replace(/\n/g, "↵") : "";
    const hint = preview ? `${this.vim.hint} · [${preview}]` : this.vim.hint;
    lines.push(truncateToWidth(` ${hint}`, width, "…"));
    return lines;
  }
}
