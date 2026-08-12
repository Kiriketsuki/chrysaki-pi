import type { UiSnapshot } from "../runtime/types.ts";

export interface PiSessionContext {
  cwd: string;
  model?: { id: string; name?: string; provider: string; contextWindow?: number };
  thinkingLevel: string;
  sessionManager: { getSessionId(): string };
  getContextUsage(): { tokens: number } | undefined;
}

export function collectSession(ctx: PiSessionContext, current: UiSnapshot, now = Date.now()): Partial<UiSnapshot> {
  const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
  const contextWindow = ctx.model?.contextWindow ?? 0;
  return {
    model: ctx.model?.name ?? ctx.model?.id ?? "Pi",
    provider: ctx.model?.provider ?? "",
    thinkingLevel: ctx.thinkingLevel,
    contextTokens,
    contextWindow,
    contextPercent: contextWindow > 0 ? Math.min(100, contextTokens / contextWindow * 100) : 0,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    rail: promoteRail(current, contextTokens, contextWindow),
    updatedAt: now,
  };
}

function promoteRail(snapshot: UiSnapshot, used: number, total: number): UiSnapshot["rail"] {
  let promoted = snapshot.rail.promoted;
  if (snapshot.activeTool?.includes("git") || snapshot.git.files.length > 0) promoted = "git";
  else if (total > 0 && used / total >= 0.75) promoted = "context";
  else if (snapshot.activeProcesses.length > 0) promoted = "activity";
  const modules = promoted
    ? [promoted, ...snapshot.rail.modules.filter((module) => module !== promoted)]
    : [...snapshot.rail.modules];
  return Object.freeze({ ...snapshot.rail, promoted, modules: Object.freeze(modules), promotedCount: promoted ? 1 : 0 });
}
