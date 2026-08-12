import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(0, width), "…");
}

export function columns(left: string, right: string, width: number): string {
  const available = Math.max(0, width);
  if (visibleWidth(left) + visibleWidth(right) + 1 > available) return fit(`${left} ${right}`, available);
  return left + " ".repeat(Math.max(1, available - visibleWidth(left) - visibleWidth(right))) + right;
}

export function doubleBox(lines: readonly string[], width: number, title = ""): string[] {
  if (width <= 1) return lines.map((line) => fit(line, width));
  const inner = width - 2;
  const titleText = title ? ` ${title} ` : "";
  const top = `╔${fit(titleText, inner)}${"═".repeat(Math.max(0, inner - visibleWidth(titleText)))}╗`;
  return [fit(top, width), ...lines.map((line) => { const fitted = fit(line, inner); return `║${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}║`; }), `╚${"═".repeat(inner)}╝`];
}

export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}
