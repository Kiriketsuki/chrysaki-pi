import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GitSnapshot } from "../runtime/types.ts";
import { doubleBox, fit } from "./layout.ts";

const statusColor = (theme: Theme, code: string, text: string): string => {
  if (code === "A" || code === "?") return theme.fg("success", text);
  if (code === "D") return theme.fg("error", text);
  if (code === "M" || code === "R") return theme.fg("warning", text);
  return theme.fg("muted", text);
};

export function renderGitModule(snapshot: GitSnapshot, width: number, height = 20, theme?: Theme): string[] {
  const color = theme ?? ({ fg: (_role: string, text: string) => text, bold: (text: string) => text } as Theme);
  if (!snapshot.available) {
    const bodyHeight = Math.max(1, height - 2);
    return doubleBox([color.fg("muted", " Git unavailable"), ...Array.from({ length: bodyHeight - 1 }, () => "")], width, "GIT");
  }
  const lines: string[] = [];
  const branch = snapshot.branch ?? "HEAD";
  lines.push(` ${color.fg("accent", "●")} ${color.bold(branch)} ${color.fg("muted", snapshot.commit ?? "")}`);
  if (snapshot.ahead || snapshot.behind) lines.push(color.fg("muted", `   ↑${snapshot.ahead} ↓${snapshot.behind}`));
  const roomForFiles = Math.max(1, Math.min(snapshot.files.length, height < 14 ? 3 : 7));
  for (const file of snapshot.files.slice(0, roomForFiles)) {
    const code = file.worktreeStatus.trim() || file.indexStatus.trim() || "?";
    const stat = file.added || file.deleted ? ` +${file.added} -${file.deleted}` : "";
    lines.push(` ${statusColor(color, code, code)} ${fit(file.path, Math.max(4, width - 15))}${color.fg("muted", stat)}`);
  }
  if (snapshot.files.length > roomForFiles) lines.push(color.fg("dim", `   … ${snapshot.files.length - roomForFiles} more`));
  if (height >= 14 && snapshot.graph.length) {
    lines.push(color.fg("borderMuted", " ── history ─────────────────────────"));
    const historyRows = Math.max(1, height - lines.length - 3);
    snapshot.graph.slice(0, historyRows).forEach((commit, index) => {
      const graph = index === 0 ? "●" : "┆";
      const hash = color.fg("muted", commit.hash.padEnd(8));
      lines.push(` ${color.fg(index === 0 ? "accent" : "muted", graph)} ${hash} ${fit(commit.subject, Math.max(4, width - 15))}`);
    });
  }
  // A sidebar is a column, not a floating card: fill the requested viewport.
  const bodyHeight = Math.max(1, height - 2);
  while (lines.length < bodyHeight) lines.push("");
  return doubleBox(lines.slice(0, bodyHeight), width, `GIT · ${branch}`);
}
