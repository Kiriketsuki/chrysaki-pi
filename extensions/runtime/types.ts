export type RailVisibility = "auto" | "pinned" | "hidden";
export type RailModule = "context" | "tasks" | "files" | "git" | "activity";
export type EditorMode = "insert" | "normal" | "visual";

export interface GitFile {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  added: number;
  deleted: number;
}

export interface GitCommit {
  hash: string;
  refs: string;
  subject: string;
}

export interface GitSnapshot {
  available: boolean;
  root?: string;
  branch?: string;
  commit?: string;
  ahead: number;
  behind: number;
  files: readonly GitFile[];
  graph: readonly GitCommit[];
  error?: string;
  collectedAt: number;
}

export interface RailState {
  visibility: RailVisibility;
  threshold: number;
  modules: readonly RailModule[];
  promoted?: RailModule;
  promotedCount: number;
}

export interface UiSnapshot {
  model: string;
  provider: string;
  thinkingLevel: string;
  contextTokens: number;
  contextWindow: number;
  contextPercent: number;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  activeProcesses: readonly string[];
  activeTool?: string;
  git: GitSnapshot;
  rail: RailState;
  updatedAt: number;
}

export interface ChrysakiSettings {
  railThreshold: number;
  autoPromotion: boolean;
  motion: "minimal" | "off";
  showGit: boolean;
  editorEnabled: boolean;
  editorStartMode: "insert" | "normal";
  density: "compact" | "comfortable";
}

export const DEFAULT_SETTINGS: Readonly<ChrysakiSettings> = Object.freeze({
  railThreshold: 120,
  autoPromotion: true,
  motion: "minimal",
  showGit: true,
  editorEnabled: true,
  editorStartMode: "insert",
  density: "comfortable",
});

export const EMPTY_GIT: Readonly<GitSnapshot> = Object.freeze({
  available: false,
  ahead: 0,
  behind: 0,
  files: Object.freeze([]),
  graph: Object.freeze([]),
  collectedAt: 0,
});

export function initialSnapshot(settings: ChrysakiSettings = DEFAULT_SETTINGS): UiSnapshot {
  return Object.freeze({
    model: "Pi",
    provider: "",
    thinkingLevel: "off",
    contextTokens: 0,
    contextWindow: 0,
    contextPercent: 0,
    sessionId: "",
    cwd: process.cwd(),
    activeProcesses: Object.freeze([]),
    git: EMPTY_GIT,
    rail: Object.freeze({
      visibility: "auto",
      threshold: settings.railThreshold,
      modules: Object.freeze(["context", "tasks", "files", "git", "activity"] as RailModule[]),
      promotedCount: 0,
    }),
    updatedAt: 0,
  });
}
