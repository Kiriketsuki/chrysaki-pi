import { join } from "node:path";
import type { AdapterLaunchContext } from "../types.ts";
import { InteractiveAdapter, type AdapterDefinition, type InteractiveAdapterOptions } from "./base.ts";

const DEFINITION: AdapterDefinition = Object.freeze({
  id: "claude",
  executable: "claude",
  environmentKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  credentialBindings: (home: string) => [{ hostPath: join(home, ".claude", ".credentials.json"), guestPath: "/home/worker/.claude/.credentials.json" }],
  capabilities: Object.freeze(["read", "write", "code", "tools", "reasoning", "images"]),
  readyPatterns: Object.freeze([/(?:^|\n)\s*❯\s*$/m]),
  runningPatterns: Object.freeze([/esc to interrupt/i, /thinking|working/i]),
  blockedPatterns: Object.freeze([
    { id: "workspace-trust", pattern: /Do you trust the files in this folder\?/i, response: "y" },
    { id: "bypass-confirmation", pattern: /Bypass Permissions mode|dangerously skip permissions/i, response: "y" },
    { id: "tool-approval", pattern: /(?:Allow|Approve).*(?:tool|command|edit).*(?:\?|\[y\/n\])/i, response: "y" },
  ]),
  fatalPatterns: Object.freeze([/Invalid API key|Please run \/login|authentication (?:failed|required)|OAuth token.*expired/i]),
  completionHelper: "mailbox-instructions",
});

export class ClaudeWorkerAdapter extends InteractiveAdapter {
  constructor(options: InteractiveAdapterOptions = {}) { super(DEFINITION, options); }

  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]] {
    if (context.confinementActive !== true) throw new Error("Claude auto-approval requires active confinement");
    const argv: [string, ...string[]] = [context.executablePath, "--dangerously-skip-permissions", ...context.interactiveArgs];
    if (context.model) argv.push("--model", context.model);
    return this.validateArgv(argv, context.executablePath);
  }
}
