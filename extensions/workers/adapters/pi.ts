import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterLaunchContext, AdapterPromptContext } from "../types.ts";
import { InteractiveAdapter, type AdapterDefinition, type InteractiveAdapterOptions } from "./base.ts";

const mailboxExtensionPath = fileURLToPath(new URL("../pi-mailbox-extension.ts", import.meta.url));

const DEFINITION: AdapterDefinition = Object.freeze({
  id: "pi",
  executable: "pi",
  environmentKeys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"],
  credentialBindings: (home: string) => [{ hostPath: join(home, ".pi", "agent", "auth.json"), guestPath: "/home/worker/.pi/agent/auth.json" }],
  capabilities: Object.freeze(["read", "write", "code", "tools", "reasoning", "images"]),
  readyPatterns: Object.freeze([/(?:^|\n)\s*[>❯]\s*$/m]),
  runningPatterns: Object.freeze([/esc to interrupt/i, /working|thinking/i]),
  blockedPatterns: Object.freeze([
    { id: "project-trust", pattern: /Trust project folder\?/i, response: "y" },
    { id: "tool-approval", pattern: /(?:allow|approve).*(?:tool|command).*(?:\?|\[y\/n\])/i, response: "y" },
  ]),
  fatalPatterns: Object.freeze([/No API key|authentication required|failed to load extension|project is not trusted/i]),
  completionHelper: "pi-extension",
});

export class PiWorkerAdapter extends InteractiveAdapter {
  constructor(options: InteractiveAdapterOptions = {}) { super(DEFINITION, options, [dirname(mailboxExtensionPath)]); }

  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]] {
    if (context.confinementActive !== true) throw new Error("Pi worker auto-trust requires active confinement");
    const argv: [string, ...string[]] = [context.executablePath, "--no-session", "--extension", mailboxExtensionPath, ...context.interactiveArgs];
    if (context.model) argv.push("--model", context.model);
    return this.validateArgv(argv, context.executablePath);
  }

  buildPrompt(context: AdapterPromptContext): string { return context.task; }
}

export { mailboxExtensionPath as piMailboxExtensionPath };
