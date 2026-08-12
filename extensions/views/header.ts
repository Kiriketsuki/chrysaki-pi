import type { Theme } from "@earendil-works/pi-coding-agent";
import { fit } from "./layout.ts";

export class ChrysakiHeader {
  constructor(private theme: Theme) {}
  render(width: number): string[] {
    if (width < 48) return [fit(`${this.theme.fg("accent", "⬢")} ${this.theme.bold("CHRYS AKI")} · Pi`, width)];
    return [
      fit(this.theme.fg("accent", "  ══◆══") + this.theme.fg("borderMuted", "━━━━━━━━━━━━━━━━━━━━━━━━"), width),
      fit(`  ${this.theme.bold("CHRYS AKI")}  ${this.theme.fg("muted", "PRECISION INTERFACE · Pi")}`, width),
      fit(this.theme.fg("borderMuted", "  ━━━━━━━━━━━━━━━━━━━━━━━━") + this.theme.fg("accent", "══◆══"), width),
    ];
  }
  invalidate(): void {}
}
