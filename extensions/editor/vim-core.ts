import type { EditorMode } from "../runtime/types.ts";

export interface VimResult { handled: boolean; text: string; cursor: number; mode: EditorMode; hint: string; selection?: readonly [number, number]; }

const isWord = (char: string | undefined) => !!char && /[\p{L}\p{N}_]/u.test(char);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function lineBounds(text: string, cursor: number): [number, number] {
  const start = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const endIndex = text.indexOf("\n", cursor);
  return [start, endIndex < 0 ? text.length : endIndex];
}
function wordBounds(text: string, cursor: number, around = false): [number, number] {
  let point = clamp(cursor, 0, Math.max(0, text.length - 1));
  if (!isWord(text[point])) while (point < text.length && !isWord(text[point])) point++;
  let start = point; let end = point;
  while (start > 0 && isWord(text[start - 1])) start--;
  while (end < text.length && isWord(text[end])) end++;
  if (around) { while (end < text.length && /\s/.test(text[end]!)) end++; }
  return [start, end];
}
function motion(text: string, cursor: number, key: string, count: number): number | undefined {
  let next = cursor;
  for (let iteration = 0; iteration < count; iteration++) {
    const [start, end] = lineBounds(text, next);
    if (key === "h") next = Math.max(start, next - 1);
    else if (key === "l") next = Math.min(end, next + 1);
    else if (key === "0") next = start;
    else if (key === "$") next = end;
    else if (key === "w") { next = Math.min(text.length, next + 1); while (next < text.length && isWord(text[next])) next++; while (next < text.length && !isWord(text[next])) next++; }
    else if (key === "b") { next = Math.max(0, next - 1); while (next > 0 && !isWord(text[next])) next--; while (next > 0 && isWord(text[next - 1])) next--; }
    else if (key === "e") { while (next < text.length && !isWord(text[next])) next++; while (next < text.length && isWord(text[next + 1])) next++; }
    else if (key === "j" || key === "k") {
      const column = next - start;
      const adjacent = key === "j" ? end + 1 : text.lastIndexOf("\n", Math.max(0, start - 2)) + 1;
      if ((key === "j" && end === text.length) || (key === "k" && start === 0)) continue;
      const adjacentEndIndex = text.indexOf("\n", adjacent);
      const adjacentEnd = adjacentEndIndex < 0 ? text.length : adjacentEndIndex;
      next = Math.min(adjacent + column, adjacentEnd);
    } else return undefined;
  }
  return next;
}

export class VimEngine {
  mode: EditorMode = "insert";
  pendingOperator?: "d" | "c" | "y";
  count = "";
  register = "";
  searchQuery = "";
  hint = "INSERT · Esc for Normal";
  private visualAnchor?: number;
  private objectPrefix?: "i" | "a";
  private searchInput = false;
  private pendingG = false;
  private undo: Array<{ text: string; cursor: number }> = [];
  private lastSearch = "";

  constructor(startMode: "insert" | "normal" = "insert") { this.mode = startMode; this.hint = startMode === "insert" ? "INSERT · Esc for Normal" : "NORMAL · i insert · v visual · ? help"; }

  handle(key: string, text: string, cursor: number): VimResult {
    const result = (handled = true): VimResult => ({ handled, text, cursor: clamp(cursor, 0, text.length), mode: this.mode, hint: this.hint, selection: this.selection(cursor) });
    if (this.mode === "insert") {
      if (key === "escape") { this.mode = "normal"; this.reset("NORMAL · i insert · v visual · ? help"); return result(); }
      return result(false);
    }
    if (this.searchInput) {
      if (key === "escape") { this.searchInput = false; this.searchQuery = ""; this.hint = "Search cancelled"; return result(); }
      if (key === "backspace") this.searchQuery = this.searchQuery.slice(0, -1);
      else if (key === "enter") { this.searchInput = false; this.lastSearch = this.searchQuery; const found = text.indexOf(this.lastSearch, Math.min(text.length, cursor + 1)); if (found >= 0) cursor = found; this.hint = found >= 0 ? `/${this.lastSearch}` : `Pattern not found: ${this.lastSearch}`; }
      else if (key.length === 1 && key.charCodeAt(0) >= 32) this.searchQuery += key;
      this.hint = this.searchInput ? `/${this.searchQuery}` : this.hint; return result();
    }
    if (/^[1-9]$/.test(key) || (key === "0" && this.count)) { this.count += key; this.hint = `${this.mode.toUpperCase()} · count ${this.count}`; return result(); }
    const count = Number(this.count) || 1;
    if (key === "escape") { if (this.mode === "visual") this.mode = "normal"; this.visualAnchor = undefined; this.reset("NORMAL"); return result(); }
    if (key === "i" && !this.pendingOperator) { this.mode = "insert"; this.reset("INSERT"); return result(); }
    if (key === "a" && !this.pendingOperator) { cursor = Math.min(text.length, cursor + 1); this.mode = "insert"; this.reset("INSERT · append"); return result(); }
    if (key === "v") { this.mode = this.mode === "visual" ? "normal" : "visual"; this.visualAnchor = this.mode === "visual" ? cursor : undefined; this.reset(this.mode === "visual" ? "VISUAL · motion then d/c/y" : "NORMAL"); return result(); }
    if (key === "/") { this.searchInput = true; this.searchQuery = ""; this.reset("/"); return result(); }
    if (key === "n" && this.lastSearch) { const found = text.indexOf(this.lastSearch, Math.min(text.length, cursor + 1)); if (found >= 0) cursor = found; this.reset(found >= 0 ? `/${this.lastSearch}` : "No next match"); return result(); }
    if (this.pendingG) { if (key === "g") { cursor = 0; this.reset("First line"); } else this.reset(`Unsupported sequence: g${key}`); return result(); }
    if (key === "g") { this.pendingG = true; this.count = ""; this.hint = "g · press g for first line"; return result(); }
    if (key === "G") { cursor = text.length; this.reset("Last line"); return result(); }
    if (key === "u") { const previous = this.undo.pop(); if (previous) { text = previous.text; cursor = previous.cursor; } this.reset(previous ? "Undo" : "Nothing to undo"); return result(); }
    if (key === "p") { if (this.register) { this.save(text, cursor); text = text.slice(0, cursor + 1) + this.register + text.slice(cursor + 1); cursor += this.register.length; } this.reset(this.register ? "Pasted register" : "Register empty"); return result(); }
    if (key === "x") { if (cursor < text.length) { this.save(text, cursor); this.register = text.slice(cursor, cursor + count); text = text.slice(0, cursor) + text.slice(cursor + count); } this.reset("Delete character"); return result(); }
    if (this.mode === "visual" && (key === "d" || key === "c" || key === "y")) {
      const [start, end] = this.selection(cursor)!; this.register = text.slice(start, end);
      if (key !== "y") { this.save(text, cursor); text = text.slice(0, start) + text.slice(end); cursor = start; }
      this.mode = key === "c" ? "insert" : "normal"; this.visualAnchor = undefined; this.reset(key === "y" ? "Yanked selection" : key === "c" ? "INSERT · changed selection" : "Deleted selection"); return result();
    }
    if ((key === "d" || key === "c" || key === "y") && !this.pendingOperator) { this.pendingOperator = key; this.count = ""; this.hint = `${key} · awaiting motion/text object`; return result(); }
    if (this.pendingOperator && (key === "i" || key === "a")) { this.objectPrefix = key; this.hint = `${this.pendingOperator}${key} · w supported`; return result(); }
    if (this.pendingOperator) {
      let range: [number, number] | undefined;
      if (this.objectPrefix && key === "w") range = wordBounds(text, cursor, this.objectPrefix === "a");
      else if (key === this.pendingOperator) { const [start, end] = lineBounds(text, cursor); range = [start, Math.min(text.length, end + 1)]; }
      else { const target = motion(text, cursor, key, count); if (target !== undefined) range = [Math.min(cursor, target), Math.min(text.length, Math.max(cursor, target) + (target >= cursor ? 0 : 1))]; }
      if (range) {
        const operator = this.pendingOperator; this.register = text.slice(range[0], range[1]);
        if (operator !== "y") { this.save(text, cursor); text = text.slice(0, range[0]) + text.slice(range[1]); cursor = range[0]; }
        if (operator === "c") this.mode = "insert";
        this.reset(operator === "y" ? "Yanked" : operator === "c" ? "INSERT · changed" : "Deleted"); return result();
      }
      this.reset(`Unsupported sequence: ${this.pendingOperator}${this.objectPrefix ?? ""}${key}`); return result();
    }
    const target = motion(text, cursor, key, count);
    if (target !== undefined) { cursor = target; this.count = ""; this.hint = this.mode === "visual" ? "VISUAL" : "NORMAL"; return result(); }
    this.reset(`Unsupported: ${key}`); return result();
  }

  private selection(cursor: number): readonly [number, number] | undefined { if (this.mode !== "visual" || this.visualAnchor === undefined) return undefined; return [Math.min(this.visualAnchor, cursor), Math.max(this.visualAnchor, cursor) + 1]; }
  private save(text: string, cursor: number): void { this.undo.push({ text, cursor }); if (this.undo.length > 100) this.undo.shift(); }
  private reset(hint: string): void { this.pendingOperator = undefined; this.objectPrefix = undefined; this.pendingG = false; this.count = ""; this.hint = hint; }
}
