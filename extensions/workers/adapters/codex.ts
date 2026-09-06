import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { AdapterLaunchContext, ScreenRecognition } from "../types.ts";
import { InteractiveAdapter, stripTerminalControl, type AdapterDefinition, type InteractiveAdapterOptions } from "./base.ts";

const DEFINITION: AdapterDefinition = Object.freeze({
  id: "codex",
  executable: "codex",
  environmentKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  credentialBindings: (home: string) => [{ hostPath: join(home, ".codex", "auth.json"), guestPath: "/home/worker/.codex/auth.json" }],
  capabilities: Object.freeze(["read", "write", "code", "tools", "reasoning"]),
  readyPatterns: Object.freeze([/(?:^|\n)\s*›\s*$/m, /Ask Codex to do anything/i]),
  runningPatterns: Object.freeze([/esc to interrupt/i, /working|thinking/i]),
  blockedPatterns: Object.freeze([
    { id: "workspace-trust", pattern: /Do you trust (?:(?:this|the) (?:folder|workspace|directory)|the contents of this directory)\?/i, response: "" },
    { id: "approval", pattern: /(?:approve|allow).*(?:command|edit|action).*(?:\?|\[y\/n\])/i, response: "y" },
  ]),
  fatalPatterns: Object.freeze([/Not logged in|Please run.*login|authentication (?:failed|required)|API key.*invalid/i]),
  completionHelper: "mailbox-instructions",
});

export class CodexWorkerAdapter extends InteractiveAdapter {
  constructor(options: InteractiveAdapterOptions = {}) { super(DEFINITION, options); }

  async prepareHome(homePath: string): Promise<void> {
    const configRoot = join(homePath, ".codex");
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(configRoot, "config.toml"), '[projects."/workspace"]\ntrust_level = "trusted"\n', { mode: 0o600, flag: "wx" });
  }

  override recognizeScreen(screen: string): ScreenRecognition {
    const recognition = super.recognizeScreen(screen);
    return recognition.state === "ready" && /model:\s*loading/i.test(stripTerminalControl(screen)) ? { state: "starting" } : recognition;
  }

  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]] {
    if (context.confinementActive !== true) throw new Error("Codex auto-approval requires active confinement");
    // The mandatory outer Bubblewrap profile enforces access. Codex's nested
    // workspace-write sandbox tries to mkdir .agents on a read-only workspace
    // and excludes /mailbox, so it cannot be used inside this profile.
    const argv: [string, ...string[]] = [context.executablePath, "--sandbox", "danger-full-access", "--ask-for-approval", "never", ...context.interactiveArgs];
    if (context.model) argv.push("--model", context.model);
    return this.validateArgv(argv, context.executablePath);
  }
}
