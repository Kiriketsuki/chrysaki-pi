import { basename } from "node:path";
import type { WorkerAdapterId } from "./types.ts";

export interface HeadlessInvocationViolation {
  readonly provider: WorkerAdapterId;
  readonly executable: string;
  readonly argument?: string;
  readonly reason: string;
}

export class HeadlessInvocationError extends Error {
  constructor(readonly violation: HeadlessInvocationViolation) {
    super(`${violation.reason}. Delegate model work through worker_run instead.`); this.name = "HeadlessInvocationError";
  }
}

function executableName(value: string): string {
  return basename(value).toLowerCase().replace(/\.exe$/, "");
}

function optionValue(args: readonly string[], index: number, name: string): string | undefined {
  const argument = args[index];
  if (argument === name) return args[index + 1];
  if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
  return undefined;
}

export function findHeadlessModelArgv(argv: readonly string[]): HeadlessInvocationViolation | undefined {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string" || value.includes("\0"))) {
    return { provider: "pi", executable: String(argv[0] ?? ""), reason: "Model launch must use a non-empty NUL-free argv array" };
  }
  const executable = executableName(argv[0]); const args = argv.slice(1);
  if (executable === "pi") {
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]; const mode = optionValue(args, index, "--mode")?.toLowerCase();
      if (argument === "-p" || argument === "--print" || argument.startsWith("--print=") || argument === "--json" || argument === "--rpc")
        return { provider: "pi", executable: argv[0], argument, reason: `Prohibited non-interactive Pi option: ${argument}` };
      if (mode && ["print", "json", "rpc"].includes(mode))
        return { provider: "pi", executable: argv[0], argument: argument === "--mode" ? `--mode ${mode}` : argument, reason: `Prohibited non-interactive Pi mode: ${mode}` };
    }
  } else if (executable === "claude") {
    for (let index = 0; index < args.length; index++) {
      const argument = args[index];
      if (argument === "-p" || argument === "--print" || argument.startsWith("--print=") || argument === "--json" || argument === "--output-format" || argument.startsWith("--output-format=") || argument === "--input-format" || argument.startsWith("--input-format="))
        return { provider: "claude", executable: argv[0], argument, reason: `Prohibited non-interactive Claude option: ${argument}` };
    }
  } else if (executable === "codex") {
    const subcommand = args.find((argument) => ["exec", "e", "review"].includes(argument.toLowerCase()))?.toLowerCase();
    if (subcommand)
      return { provider: "codex", executable: argv[0], argument: subcommand, reason: `Prohibited non-interactive Codex subcommand: ${subcommand}` };
    const option = args.find((argument) => argument === "--json" || argument.startsWith("--output-schema"));
    if (option) return { provider: "codex", executable: argv[0], argument: option, reason: `Prohibited non-interactive Codex option: ${option}` };
  }
  return undefined;
}

export function assertInteractiveModelArgv(argv: readonly string[], expectedProvider?: WorkerAdapterId, resolvedExecutable?: string): void {
  const violation = findHeadlessModelArgv(argv); if (violation) throw new HeadlessInvocationError(violation);
  if (expectedProvider && executableName(argv[0]) !== expectedProvider && argv[0] !== resolvedExecutable)
    throw new HeadlessInvocationError({ provider: expectedProvider, executable: argv[0], reason: `Adapter ${expectedProvider} attempted to launch a different executable` });
}

interface ShellToken { readonly value: string; readonly operator: boolean; }

function shellTokens(source: string): ShellToken[] {
  const tokens: ShellToken[] = []; let current = ""; let quote: "'" | '"' | undefined;
  const emit = () => { if (current) { tokens.push({ value: current, operator: false }); current = ""; } };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < source.length) current += source[++index];
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "\\" && index + 1 < source.length) { current += source[++index]; continue; }
    if (/\s/.test(character)) {
      emit();
      if (character === "\n") tokens.push({ value: "\n", operator: true });
      continue;
    }
    if (";|&(){}\u0060".includes(character)) {
      emit();
      const pair = source.slice(index, index + 2);
      if (pair === "&&" || pair === "||") { tokens.push({ value: pair, operator: true }); index++; }
      else tokens.push({ value: character, operator: true });
      continue;
    }
    current += character;
  }
  emit(); return tokens;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const SIMPLE_WRAPPERS = new Set(["command", "exec", "nohup"]);

function inspectSegment(words: readonly string[], depth: number): HeadlessInvocationViolation | undefined {
  if (words.length === 0 || depth > 4) return undefined;
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index])) index++;
  let command = executableName(words[index] ?? "");
  if (command === "env") {
    index++;
    while (index < words.length) {
      const word = words[index];
      if (ASSIGNMENT.test(word) || word === "--") { index++; continue; }
      if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(word)) { index += 2; continue; }
      if (word.startsWith("-")) { index++; continue; }
      break;
    }
    command = executableName(words[index] ?? "");
  }
  while (SIMPLE_WRAPPERS.has(command)) {
    index++;
    while (words[index]?.startsWith("-")) index++;
    command = executableName(words[index] ?? "");
  }
  if (command === "timeout") {
    index++;
    while (index < words.length && words[index].startsWith("-")) index++;
    if (index < words.length) index++; // duration
    command = executableName(words[index] ?? "");
  }
  if (SHELLS.has(command)) {
    const commandIndex = words.indexOf("-c", index + 1);
    if (commandIndex >= 0 && words[commandIndex + 1]) return findHeadlessModelShell(words[commandIndex + 1], depth + 1);
  }
  if (["pi", "claude", "codex"].includes(command)) return findHeadlessModelArgv(words.slice(index));
  if (["xargs", "parallel"].includes(command)) {
    const nested = words.slice(index + 1).findIndex((word) => ["pi", "claude", "codex"].includes(executableName(word)));
    if (nested >= 0) return findHeadlessModelArgv(words.slice(index + 1 + nested));
  }
  if (command === "find") {
    const marker = words.findIndex((word, position) => position > index && ["-exec", "-execdir", "-ok", "-okdir"].includes(word));
    if (marker >= 0 && words[marker + 1]) return inspectSegment(words.slice(marker + 1), depth + 1);
  }
  if (command === "eval" && words[index + 1]) return findHeadlessModelShell(words.slice(index + 1).join(" "), depth + 1);
  return undefined;
}

export function findHeadlessModelShell(command: string, depth = 0): HeadlessInvocationViolation | undefined {
  const tokens = shellTokens(command); let segment: string[] = [];
  for (const token of tokens) {
    if (token.operator) {
      const violation = inspectSegment(segment, depth); if (violation) return violation;
      segment = [];
    } else segment.push(token.value);
  }
  return inspectSegment(segment, depth);
}

export function assertNoHeadlessModelShell(command: string): void {
  const violation = findHeadlessModelShell(command); if (violation) throw new HeadlessInvocationError(violation);
}

export function modelShellBlockReason(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const violation = findHeadlessModelShell(command);
  return violation ? `${violation.reason}. Use worker_run for delegated model work; direct user-issued shell commands are unaffected.` : undefined;
}
