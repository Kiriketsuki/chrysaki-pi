export const COMMAND_CATEGORIES = ["View", "Git", "Model", "Session", "Preset", "Editor", "Help"] as const;
export type CommandCategory = typeof COMMAND_CATEGORIES[number];

export interface CommandDefinition<Context = unknown> {
  id: string;
  label: string;
  category: CommandCategory;
  description: string;
  keyHint?: string;
  available?: (context: Context) => boolean;
  handler: (context: Context) => void | Promise<void>;
}

export class CommandRegistry<Context = unknown> {
  private commands: CommandDefinition<Context>[] = [];
  register(definition: CommandDefinition<Context>): void {
    if (this.commands.some((item) => item.id === definition.id)) throw new Error(`duplicate command: ${definition.id}`);
    this.commands.push(Object.freeze({ ...definition }));
  }
  get(id: string): CommandDefinition<Context> | undefined { return this.commands.find((item) => item.id === id); }
  list(context?: Context): readonly CommandDefinition<Context>[] {
    return this.commands.filter((item) => context === undefined || !item.available || item.available(context));
  }
  async execute(id: string, context: Context): Promise<boolean> {
    const command = this.get(id);
    if (!command || (command.available && !command.available(context))) return false;
    await command.handler(context); return true;
  }
}

function fuzzyScore(query: string, candidate: string): number | undefined {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const haystack = candidate.toLowerCase();
  if (!needle) return 0;
  let cursor = 0; let score = 0; let run = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return undefined;
    run = found === cursor ? run + 1 : 0;
    score += found + (run ? -run : 0);
    cursor = found + 1;
  }
  return score;
}

export function filterCommands<Context>(commands: readonly CommandDefinition<Context>[], query: string): CommandDefinition<Context>[] {
  return commands.map((command, index) => ({ command, index, score: fuzzyScore(query, `${command.category} ${command.label} ${command.description}`) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== undefined)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
}

export function helpLines<Context>(commands: readonly CommandDefinition<Context>[]): string[] {
  return commands.map((command) => `${command.category.padEnd(8)} ${command.label}${command.keyHint ? `  [${command.keyHint}]` : ""} — ${command.description}`);
}
