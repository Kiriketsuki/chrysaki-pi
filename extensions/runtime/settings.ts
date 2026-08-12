import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type ChrysakiSettings } from "./types.ts";

export function settingsPath(): string { return join(getAgentDir(), "chrysaki-pi.json"); }

export function validateSettings(input: unknown): ChrysakiSettings {
  const raw = input && typeof input === "object" ? input as Partial<ChrysakiSettings> : {};
  return {
    railThreshold: Number.isInteger(raw.railThreshold) ? Math.min(240, Math.max(80, raw.railThreshold!)) : DEFAULT_SETTINGS.railThreshold,
    autoPromotion: typeof raw.autoPromotion === "boolean" ? raw.autoPromotion : DEFAULT_SETTINGS.autoPromotion,
    motion: raw.motion === "off" ? "off" : "minimal",
    showGit: typeof raw.showGit === "boolean" ? raw.showGit : DEFAULT_SETTINGS.showGit,
    editorEnabled: typeof raw.editorEnabled === "boolean" ? raw.editorEnabled : DEFAULT_SETTINGS.editorEnabled,
    editorStartMode: raw.editorStartMode === "normal" ? "normal" : "insert",
    density: raw.density === "compact" ? "compact" : "comfortable",
  };
}

export async function loadSettings(path = settingsPath()): Promise<ChrysakiSettings> {
  try { return validateSettings(JSON.parse(await readFile(path, "utf8"))); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveSettings(settings: ChrysakiSettings, path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validateSettings(settings), null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
