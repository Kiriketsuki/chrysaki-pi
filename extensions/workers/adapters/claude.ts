import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AdapterLaunchContext } from "../types.ts";
import { InteractiveAdapter, type AdapterDefinition, type InteractiveAdapterOptions } from "./base.ts";

const DEFINITION: AdapterDefinition = Object.freeze({
  id: "claude",
  executable: "claude",
  environmentKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  credentialBindings: (home: string) => [{ hostPath: join(home, ".claude", ".credentials.json"), guestPath: "/home/worker/.claude/.credentials.json" }],
  capabilities: Object.freeze(["read", "write", "code", "tools", "reasoning", "images"]),
  readyPatterns: Object.freeze([/(?:^|\n)\s*❯\s*(?:Try [^\n]*)?$/m]),
  runningPatterns: Object.freeze([/esc to interrupt/i, /thinking|working/i]),
  blockedPatterns: Object.freeze([
    { id: "theme-selection", pattern: /Choose the text style that looks best with your terminal/i, response: "" },
    { id: "workspace-trust", pattern: /Do you trust the files in this folder\?/i, response: "y" },
    { id: "bypass-confirmation", pattern: /Bypass Permissions mode|dangerously skip permissions/i, response: "y" },
    { id: "tool-approval", pattern: /(?:Allow|Approve).*(?:tool|command|edit).*(?:\?|\[y\/n\])/i, response: "y" },
  ]),
  fatalPatterns: Object.freeze([/Invalid API key|Please run \/login|authentication (?:failed|required)|OAuth token.*expired/i]),
  completionHelper: "mailbox-instructions",
});

export class ClaudeWorkerAdapter extends InteractiveAdapter {
  constructor(options: InteractiveAdapterOptions = {}) { super(DEFINITION, options); }

  async prepareHome(homePath: string): Promise<void> {
    // Credentials alone do not skip Claude's first-run login wizard. Copy only
    // account identity and onboarding state, never host projects/hooks/settings.
    let host: Record<string, any> = {};
    try { host = JSON.parse(await readFile(join(this.homeDirectory, ".claude.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const accountKeys = ["accountUuid", "emailAddress", "organizationUuid", "displayName"];
    const oauthAccount = Object.fromEntries(accountKeys.flatMap((key) => typeof host.oauthAccount?.[key] === "string" ? [[key, host.oauthAccount[key]]] : []));
    await mkdir(join(homePath, ".claude"), { recursive: true, mode: 0o700 });
    await writeFile(join(homePath, ".claude", "settings.json"), '{"skipDangerousModePermissionPrompt":true,"remoteControlAtStartup":false}\n', { mode: 0o600, flag: "wx" });
    await writeFile(join(homePath, ".claude.json"), `${JSON.stringify({ theme: "dark", hasCompletedOnboarding: true, projects: { "/workspace": { hasTrustDialogAccepted: true } }, ...(Object.keys(oauthAccount).length ? { oauthAccount } : {}) })}\n`, { mode: 0o600, flag: "wx" });
  }

  buildInteractiveArgv(context: AdapterLaunchContext): readonly [string, ...string[]] {
    if (context.confinementActive !== true) throw new Error("Claude auto-approval requires active confinement");
    const argv: [string, ...string[]] = [context.executablePath, "--dangerously-skip-permissions", ...context.interactiveArgs];
    if (context.model) argv.push("--model", context.model);
    return this.validateArgv(argv, context.executablePath);
  }
}
