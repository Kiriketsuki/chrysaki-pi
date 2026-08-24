import { join } from "node:path";
import type { AdapterLaunchContext } from "../types.ts";
import { InteractiveAdapter, type AdapterDefinition, type InteractiveAdapterOptions } from "./base.ts";

const DEFINITION: AdapterDefinition = Object.freeze({
  id: "codex",
  executable: "codex",
  environmentKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  credentialBindings: (home: string) => [{ hostPath: join(home, ".codex", "auth.json"), guestPath: "/home/worker/.codex/auth.json" }],
  capabilities: Object.freeze(["read", "write", "code", "tools", "reasoning"]),
  readyPatterns: Object.freeze([/(?:^|\n)\s*›\s*$/m]),
  runningPatterns: Object.freeze([/esc to interrupt/i, /working|thinking/i]),
  blockedPatterns: Object.freeze([
    { id: "workspace-trust", pattern: /Do you trust (?:this|the) (?:folder|workspace|directory)\?/i, response: "y" },
    { id: "approval", pattern: /(?:approve|allow).*(?:command|edit|action).*(?:\?|\[y\/n\])/i, response: "y" },
  ]),
  fatalPatterns: Object.freeze([/Not logged in|Please run.*login|authentication (?:failed|required)|API key.*invalid/i]),
  completionHelper: "mailbox-instructions",
});

export class CodexWorkerAdapter extends InteractiveAdapter {
  constructor(options: InteractiveAdapterOptions = {}) { super(DEFINITION, options); }

  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]] {
    if (context.confinementActive !== true) throw new Error("Codex auto-approval requires active confinement");
    const argv: [string, ...string[]] = [context.executablePath, "--sandbox", "workspace-write", "--ask-for-approval", "never", ...context.interactiveArgs];
    if (context.model) argv.push("--model", context.model);
    return this.validateArgv(argv, context.executablePath);
  }
}
