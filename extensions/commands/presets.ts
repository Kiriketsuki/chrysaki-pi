import type { RailVisibility } from "../runtime/types.ts";

export interface PresetDefinition {
  id: string;
  label: string;
  modelMatcher?: string;
  thinkingLevel: "minimal" | "medium" | "high";
  tools: readonly string[];
  density: "compact" | "comfortable";
  railPolicy: RailVisibility;
  workingIndicator: "dot" | "pulse";
}

export const PRESETS: readonly PresetDefinition[] = Object.freeze([
  Object.freeze({ id: "focused", label: "Focused", thinkingLevel: "medium", tools: Object.freeze(["read", "bash", "edit", "write"]), density: "comfortable", railPolicy: "auto", workingIndicator: "dot" }),
  Object.freeze({ id: "deep-work", label: "Deep Work", thinkingLevel: "high", tools: Object.freeze(["read", "bash", "edit", "write"]), density: "comfortable", railPolicy: "pinned", workingIndicator: "pulse" }),
  Object.freeze({ id: "minimal", label: "Minimal", thinkingLevel: "minimal", tools: Object.freeze(["read", "bash"]), density: "compact", railPolicy: "hidden", workingIndicator: "dot" }),
]);

export function findPreset(id: string): PresetDefinition | undefined { return PRESETS.find((preset) => preset.id === id); }
