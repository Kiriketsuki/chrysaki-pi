import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { GitCollector } from "./collectors/git.ts";
import { RateLimitCollector } from "./collectors/rate-limits.ts";
import { collectSession } from "./collectors/session.ts";
import { CommandRegistry, helpLines, type CommandDefinition } from "./commands/registry.ts";
import { findPreset, PRESETS } from "./commands/presets.ts";
import { ChrysakiEditor } from "./editor/chrysaki-editor.ts";
import { PracticalVimEditor } from "./editor/practical-vim.ts";
import { DisposalRegistry } from "./runtime/disposal.ts";
import { BoundedProcessRunner } from "./runtime/process.ts";
import { installRapidScroll } from "./runtime/rapid-scroll.ts";
import { RefreshScheduler } from "./runtime/scheduler.ts";
import { loadSettings, saveSettings } from "./runtime/settings.ts";
import { StateStore } from "./runtime/store.ts";
import { DEFAULT_SETTINGS, initialSnapshot, type ChrysakiSettings, type RailModule, type UiSnapshot } from "./runtime/types.ts";
import { CommandDeck } from "./views/command-deck.ts";
import { ChrysakiFooter } from "./views/footer.ts";
import { ChrysakiHeader } from "./views/header.ts";
import { RailComponent, SidebarAdapter, promoteModule, railVisible } from "./views/rail.ts";
import { modelShellBlockReason } from "./workers/enforcement.ts";
import type { WorkerBroker } from "./workers/broker.ts";
import { summarizeWorker } from "./workers/render.ts";
import { createChrysakiWorkerRuntime, type ChrysakiWorkerRuntime } from "./workers/runtime.ts";
import { registerWorkerTools } from "./workers/tools.ts";

interface Runtime {
  ctx: ExtensionContext | any;
  settings: ChrysakiSettings;
  store: StateStore<UiSnapshot>;
  processes: BoundedProcessRunner;
  git: GitCollector;
  rateLimits: RateLimitCollector;
  scheduler: RefreshScheduler;
  disposal: DisposalRegistry;
  sidebar: SidebarAdapter;
  renders: number;
  rapidScrollInstalled: boolean;
  workers?: ChrysakiWorkerRuntime;
  workerError?: string;
}
interface CommandContext { ctx: ExtensionContext; runtime: Runtime; }

export interface ChrysakiExtensionOptions { readonly createWorkerRuntime?: () => Promise<ChrysakiWorkerRuntime>; }

export default async function chrysakiPi(pi: ExtensionAPI, options: ChrysakiExtensionOptions = {}) {
  let settings = await loadSettings();
  let runtime: Runtime | undefined;
  const registry = new CommandRegistry<CommandContext>();
  const workerBroker = (): WorkerBroker => {
    if (!runtime?.workers) throw new Error(runtime?.workerError ?? "Chrysaki worker runtime is not active for this session");
    return runtime.workers.broker;
  };
  registerWorkerTools(pi, workerBroker);

  const refreshSession = (active: Runtime) => {
    active.store.update(collectSession(active.ctx, active.store.get()));
    if (!active.settings.autoPromotion) active.store.update((state) => ({ rail: Object.freeze({ ...state.rail, promoted: undefined, promotedCount: 0 }) }));
    else if (!active.settings.showGit && active.store.get().rail.promoted === "git") active.store.update((state) => ({ rail: promoteModule(state.rail, "context") }));
  };
  const setRailVisibility = (active: Runtime, visibility: "auto" | "pinned" | "hidden") => {
    active.store.update((state) => ({ rail: Object.freeze({ ...state.rail, visibility }) }));
    if (visibility === "hidden") active.sidebar.collapse(); else active.sidebar.pin();
  };
  const promote = (active: Runtime, module: RailModule) => {
    active.store.update((state) => ({ rail: promoteModule(state.rail.visibility === "hidden" ? { ...state.rail, visibility: "auto" } : state.rail, module) }));
    active.sidebar.promote();
  };
  const showGit = (active: Runtime, focus = false) => {
    active.store.update((state) => ({ rail: promoteModule({ ...state.rail, visibility: "pinned" }, "git") }));
    if (focus) active.sidebar.focus(); else active.sidebar.promote();
  };
  const hideGit = (active: Runtime) => setRailVisibility(active, "hidden");

  async function openDeck(ctx: ExtensionContext, active: Runtime): Promise<void> {
    if (ctx.mode !== "tui") return;
    const available = registry.list({ ctx, runtime: active });
    const id = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => new CommandDeck(tui, theme, available, done), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "65%", minWidth: 58, maxHeight: "80%", margin: 1 },
    });
    if (id) await registry.execute(id, { ctx, runtime: active });
  }

  const definitions: CommandDefinition<CommandContext>[] = [
    { id: "view.rail-auto", label: "Rail: Auto", category: "View", description: "Show promoted context at 120+ columns", handler: ({ runtime }) => setRailVisibility(runtime, "auto") },
    { id: "view.rail-pin", label: "Rail: Pin", category: "View", description: "Keep the context rail visible when space permits", handler: ({ runtime }) => setRailVisibility(runtime, "pinned") },
    { id: "view.rail-hide", label: "Rail: Hide", category: "View", description: "Hide the context rail", handler: ({ runtime }) => setRailVisibility(runtime, "hidden") },
    { id: "git.promote", label: "Show Git Panel", category: "Git", description: "Show the read-only Git panel", available: ({ runtime }) => runtime.store.get().git.available && !runtime.sidebar.isVisible(), handler: ({ runtime }) => showGit(runtime) },
    { id: "git.hide", label: "Hide Git Panel", category: "Git", description: "Collapse the active Git panel and return focus to the editor", keyHint: "Ctrl+Shift+H", available: ({ runtime }) => runtime.sidebar.isVisible(), handler: ({ runtime }) => hideGit(runtime) },
    { id: "git.refresh", label: "Refresh Git", category: "Git", description: "Request a bounded asynchronous Git refresh", handler: ({ runtime }) => runtime.scheduler.request("command:git") },
    { id: "git.focus", label: "Focus Git Panel", category: "Git", description: "Show and focus the panel for Alt+Arrow move and resize controls", keyHint: "Ctrl+Shift+G", handler: ({ runtime }) => showGit(runtime, true) },
    { id: "model.cycle-thinking", label: "Cycle Thinking", category: "Model", description: "Cycle the active model's thinking level", keyHint: "Shift+Tab", handler: ({ ctx }) => ctx.ui.notify("Use Shift+Tab to cycle thinking without overriding Pi defaults", "info") },
    { id: "session.context", label: "Show Session Context", category: "Session", description: "Promote model, context, and session telemetry", handler: ({ runtime }) => promote(runtime, "context") },
    ...PRESETS.map((preset): CommandDefinition<CommandContext> => ({ id: `preset.${preset.id}`, label: preset.label, category: "Preset", description: `${preset.thinkingLevel} thinking · ${preset.density} UI · ${preset.railPolicy} rail`, handler: ({ ctx, runtime }) => applyPreset(preset.id, ctx, runtime) })),
    { id: "editor.insert", label: "Editor: Insert Mode", category: "Editor", description: "Return the Practical Vim editor to Insert mode", keyHint: "i", handler: ({ ctx }) => ctx.ui.notify("Press i from Normal mode", "info") },
    { id: "editor.help", label: "Practical Vim Help", category: "Editor", description: "Show supported motions, operators, search, and text objects", handler: ({ ctx }) => showHelp(ctx, ["Practical Vim", "Insert starts by default; Esc enters Normal", "Motions: h j k l · w b e · 0 $ · counts", "Operators: d c y · dd cc yy · x · p · u", "Text objects: iw aw · example: ciw", "Visual: v, motion, then d/c/y", "Search: /query Enter · n next", "Unhandled control/application shortcuts remain Pi-owned"]) },
    { id: "help.commands", label: "Command Reference", category: "Help", description: "Show help generated from the canonical command registry", handler: ({ ctx, runtime }) => showHelp(ctx, helpLines(registry.list({ ctx, runtime }))) },
    { id: "help.settings", label: "Chrysaki Settings", category: "Help", description: "Configure threshold, motion, Git, density, and editor defaults", handler: ({ ctx, runtime }) => showSettings(ctx, runtime) },
  ];
  definitions.forEach((definition) => registry.register(definition));

  async function applyPreset(id: string, ctx: ExtensionContext, active: Runtime): Promise<void> {
    const preset = findPreset(id); if (!preset) return;
    pi.setThinkingLevel(preset.thinkingLevel);
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    const tools = preset.tools.filter((tool) => available.has(tool));
    if (tools.length) pi.setActiveTools(tools);
    setRailVisibility(active, preset.railPolicy);
    active.settings = { ...active.settings, density: preset.density };
    ctx.ui.setWorkingIndicator(preset.workingIndicator === "pulse" ? { frames: [ctx.ui.theme.fg("dim", "·"), ctx.ui.theme.fg("muted", "•"), ctx.ui.theme.fg("accent", "●"), ctx.ui.theme.fg("muted", "•")], intervalMs: 160 } : { frames: [ctx.ui.theme.fg("accent", "◆")] });
    ctx.ui.notify(`${preset.label} preset applied`, "info");
  }

  async function showHelp(ctx: ExtensionContext, lines: readonly string[]): Promise<void> {
    await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => ({
      render: (width) => lines.map((line, index) => theme.fg(index === 0 ? "accent" : index === 1 ? "text" : "muted", line.slice(0, width))),
      invalidate() {},
      handleInput: () => done(),
    }), { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "80%" } });
  }

  async function showSettings(ctx: ExtensionContext, active: Runtime): Promise<void> {
    const items = (): SettingItem[] => [
      { id: "threshold", label: "Rail threshold", currentValue: String(active.settings.railThreshold), values: ["100", "120", "140", "160"] },
      { id: "promotion", label: "Auto promotion", currentValue: active.settings.autoPromotion ? "on" : "off", values: ["on", "off"] },
      { id: "motion", label: "Motion", currentValue: active.settings.motion, values: ["minimal", "off"] },
      { id: "git", label: "Git module", currentValue: active.settings.showGit ? "on" : "off", values: ["on", "off"] },
      { id: "editor", label: "Practical Vim", currentValue: active.settings.editorEnabled ? "on" : "off", values: ["on", "off"] },
      { id: "start", label: "Editor start mode", currentValue: active.settings.editorStartMode, values: ["insert", "normal"] },
      { id: "density", label: "UI density", currentValue: active.settings.density, values: ["comfortable", "compact"] },
    ];
    await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
      const list = new SettingsList(items(), 12, getSettingsListTheme(), (id, value) => {
        const next = { ...active.settings };
        if (id === "threshold") next.railThreshold = Number(value);
        else if (id === "promotion") next.autoPromotion = value === "on";
        else if (id === "motion") next.motion = value as ChrysakiSettings["motion"];
        else if (id === "git") next.showGit = value === "on";
        else if (id === "editor") next.editorEnabled = value === "on";
        else if (id === "start") next.editorStartMode = value as ChrysakiSettings["editorStartMode"];
        else if (id === "density") next.density = value as ChrysakiSettings["density"];
        active.settings = next; settings = next;
        active.store.update((state) => ({ rail: Object.freeze({ ...state.rail, threshold: next.railThreshold }) }));
        void saveSettings(next);
      }, () => done(), { enableSearch: true });
      return list;
    });
  }

  pi.registerCommand("chrysaki-deck", { description: "Open the Chrysaki fuzzy command deck", handler: async (_args, ctx) => { if (runtime) await openDeck(ctx, runtime); } });
  pi.registerCommand("chrysaki-rail", { description: "Set rail mode: auto, pin, hide, git, context", handler: async (args, ctx) => {
    if (!runtime) return; const option = args.trim();
    if (option === "pin") setRailVisibility(runtime, "pinned"); else if (option === "hide") setRailVisibility(runtime, "hidden"); else if (option === "git" || option === "context") promote(runtime, option); else setRailVisibility(runtime, "auto");
    ctx.ui.notify(`Rail: ${option || "auto"}`, "info");
  } });
  pi.registerCommand("chrysaki-git", { description: "Control Git panel: show, focus, hide, toggle", handler: async (args, ctx) => {
    if (!runtime) return;
    const option = args.trim() || "toggle";
    if (option === "hide" || (option === "toggle" && runtime.sidebar.isVisible())) hideGit(runtime);
    else showGit(runtime, option === "focus");
    ctx.ui.notify(`Git panel: ${runtime.sidebar.isVisible() ? "shown" : "hidden"}`, "info");
  } });
  pi.registerCommand("chrysaki-help", { description: "Show Chrysaki commands and Practical Vim help", handler: async (_args, ctx) => { if (runtime) await registry.execute("help.commands", { ctx, runtime }); } });
  pi.registerCommand("chrysaki-settings", { description: "Configure the Chrysaki interface", handler: async (_args, ctx) => { if (runtime) await showSettings(ctx, runtime); } });
  pi.registerCommand("chrysaki-preset", { description: "Apply focused, deep-work, or minimal preset", getArgumentCompletions: (prefix) => PRESETS.filter((preset) => preset.id.startsWith(prefix)).map((preset) => ({ value: preset.id, label: preset.label })), handler: async (args, ctx) => { if (runtime) await applyPreset(args.trim() || "focused", ctx, runtime); } });
  pi.registerCommand("workers", { description: "List persisted Chrysaki workers", handler: async (_args, ctx) => {
    if (!runtime) return; const jobs = await workerBroker().status();
    const lines = ["Chrysaki Workers", jobs.length ? `${jobs.length} persisted worker${jobs.length === 1 ? "" : "s"}` : "No persisted workers", ...jobs.map((job) => { const item = summarizeWorker(job); return `${item.id}  ${item.state}${item.adapter ? `  ${item.adapter}` : ""}${item.progress ? `  ${item.progress}` : ""}`; })];
    if (ctx.mode === "tui") await showHelp(ctx, lines); else ctx.ui.notify(lines.join(" · "), "info");
  } });
  pi.registerCommand("worker", { description: "Worker controls: doctor|reveal|status|cancel|cleanup [job-id]", getArgumentCompletions: (prefix) => ["doctor", "reveal", "status", "cancel", "cleanup"].filter((item) => item.startsWith(prefix)).map((item) => ({ value: item, label: item })), handler: async (args, ctx) => {
    if (!runtime) return; const [action, jobId, ...rest] = args.trim().split(/\s+/).filter(Boolean); const broker = workerBroker();
    if (!action || !["doctor", "reveal", "status", "cancel", "cleanup"].includes(action)) { ctx.ui.notify("Usage: /worker doctor|reveal|status|cancel|cleanup [job-id]", "warning"); return; }
    if (action === "doctor") { const report = await broker.doctor(ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()); const lines = ["Chrysaki Worker Doctor", `Status: ${(report as any).ok ? "ready" : "not ready"}`, `tmux: ${(report as any).tmux?.available ? (report as any).tmux.version ?? "available" : (report as any).tmux?.reason ?? "unavailable"}`, `sandbox: ${(report as any).sandbox?.usable ? (report as any).sandbox.version ?? "usable" : (report as any).sandbox?.reason ?? "unavailable"}`, `active: ${(report as any).admission?.active ?? 0}`]; if (ctx.mode === "tui") await showHelp(ctx, lines); else ctx.ui.notify(lines.join(" · "), (report as any).ok ? "info" : "warning"); return; }
    if (action !== "cleanup" && !jobId) { ctx.ui.notify(`Usage: /worker ${action} <job-id>`, "warning"); return; }
    if (action === "reveal") { const result = await broker.reveal(jobId!); ctx.ui.notify(result.mode === "split" ? `Revealed ${jobId} in ${result.paneId ?? "a tmux split"}` : result.command, "info"); return; }
    if (action === "status") { const [job] = await broker.status([jobId!]); const item = summarizeWorker(job); ctx.ui.notify(`${item.id}: ${item.state}${item.adapter ? ` · ${item.adapter}` : ""}${item.progress ? ` · ${item.progress}` : ""}`, "info"); return; }
    if (action === "cancel") { const [job] = await broker.cancel([jobId!], rest.join(" ") || "Cancelled by /worker"); ctx.ui.notify(`${job.job.id}: ${job.status.state}`, "info"); return; }
    const results = await broker.cleanup(jobId ? [jobId] : undefined); ctx.ui.notify(results.length ? results.map((item) => `${item.jobId}: ${item.retained ? `retained (${item.reason})` : "cleaned"}`).join(" · ") : "No terminal workers to clean", results.some((item) => item.retained) ? "warning" : "info");
  } });
  pi.registerCommand("chrysaki-debug", { description: "Show cached-render and collector diagnostics", handler: async (_args, ctx) => { if (!runtime) return; const before = performance.now(); const footer = new ChrysakiFooter(runtime.store, ctx.ui.theme, () => {}); for (let index = 0; index < 10_000; index++) footer.render(index % 2 ? 80 : 160); const elapsed = performance.now() - before; footer.dispose(); ctx.ui.notify(`10k cached footer renders: ${elapsed.toFixed(1)}ms · children ${runtime.processes.activeCount} · subscriptions ${runtime.store.subscriptionCount}`, "info"); } });
  pi.registerShortcut("ctrl+shift+p", { description: "Open Chrysaki command deck", handler: async (ctx) => { if (runtime) await openDeck(ctx, runtime); } });
  // Ghostty reserves Ctrl+Shift+P for its own palette. Keep it for terminals
  // that pass it through and provide a reliable in-app alternative.
  pi.registerShortcut("ctrl+shift+k", { description: "Open Chrysaki command deck", handler: async (ctx) => { if (runtime) await openDeck(ctx, runtime); } });
  pi.registerShortcut("ctrl+shift+g", { description: "Show and focus the Chrysaki Git panel", handler: async () => { if (runtime) showGit(runtime, true); } });
  pi.registerShortcut("ctrl+shift+h", { description: "Hide the Chrysaki Git panel", handler: async () => { if (runtime) hideGit(runtime); } });

  pi.on("session_start", async (_event, ctx) => {
    const disposal = new DisposalRegistry();
    const store = new StateStore(initialSnapshot(settings));
    const processes = disposal.add(new BoundedProcessRunner());
    const git = disposal.add(new GitCollector(processes.run));
    const rateLimits = disposal.add(new RateLimitCollector(processes.run));
    const sidebar = disposal.add(new SidebarAdapter());
    const active = { ctx, settings: { ...settings }, store, processes, git, rateLimits, disposal, sidebar, renders: 0, rapidScrollInstalled: false } as Runtime;
    const scheduler = disposal.add(new RefreshScheduler(async (reasons) => {
      const [gitSnapshot, rateLimitSnapshot] = await Promise.all([
        git.refresh(reasons.join(",")),
        rateLimits.refresh(active.ctx.model?.provider ?? ""),
      ]);
      if (active !== runtime) return;
      store.update({ git: gitSnapshot, rateLimits: rateLimitSnapshot }); refreshSession(active);
    }, 75));
    active.scheduler = scheduler; runtime = active;
    try {
      const workers = disposal.add(await (options.createWorkerRuntime ?? createChrysakiWorkerRuntime)()); active.workers = workers;
      const recovery = await workers.start();
      if (recovery.invalid.length) ctx.ui.notify(`Worker recovery retained ${recovery.invalid.length} invalid mailbox${recovery.invalid.length === 1 ? "" : "es"} for inspection`, "warning");
    } catch (error) {
      active.workerError = `Worker runtime unavailable (no worker launched): ${error instanceof Error ? error.message : String(error)}`;
      ctx.ui.notify(active.workerError, "warning");
    }
    git.start({ cwd: ctx.cwd }); refreshSession(active); scheduler.request("session-start");
  });

  pi.on("resources_discover", (_event, ctx) => {
    const active = runtime; if (!active || ctx.mode !== "tui") return;
    ctx.ui.setHeader((_tui, theme) => new ChrysakiHeader(theme));
    ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "◆")] });
    ctx.ui.setFooter((tui, theme) => {
      if (!active.rapidScrollInstalled) { active.rapidScrollInstalled = true; active.disposal.add(installRapidScroll(tui)); }
      return new ChrysakiFooter(active.store, theme, () => { active.renders++; tui.requestRender(); });
    });
    ctx.ui.setEditorComponent((tui, theme, keybindings) => active.settings.editorEnabled
      ? new PracticalVimEditor(tui, theme, keybindings, active.settings.editorStartMode)
      : new ChrysakiEditor(tui, theme, keybindings));
    const mountRail = () => {
      if (runtime !== active) return;
      let closeRail = () => {};
      let remountQueued = false;
      const remount = () => {
        if (remountQueued || runtime !== active) return;
        remountQueued = true;
        closeRail();
        queueMicrotask(mountRail);
      };
      const layout = active.sidebar.layout;
      void ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        closeRail = done;
        return new RailComponent(active.store, theme, tui, layout, () => active.sidebar.unfocus(), remount);
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: `${layout.width}%`,
          minWidth: 34,
          maxHeight: `${layout.height}%`,
          margin: 1,
          offsetX: layout.offsetX,
          offsetY: layout.offsetY,
          visible: (width) => railVisible(active.store.get().rail, width),
        },
        onHandle: (handle) => active.sidebar.show(handle, closeRail, remount),
      });
    };
    mountRail();
  });

  pi.on("model_select", (_event, ctx) => { if (runtime) { runtime.ctx = ctx; refreshSession(runtime); } });
  pi.on("thinking_level_select", (_event, ctx) => { if (runtime) { runtime.ctx = ctx; refreshSession(runtime); } });
  pi.on("turn_end", (_event, ctx) => { if (runtime) { runtime.ctx = ctx; refreshSession(runtime); runtime.scheduler.request("turn-end"); } });
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const reason = modelShellBlockReason(event.input.command);
    if (reason) return { block: true, reason };
  });
  pi.on("tool_execution_start", (event) => { if (!runtime) return; runtime.store.update((state) => ({ activeTool: event.toolName, activeProcesses: Object.freeze([...state.activeProcesses, event.toolName]) })); refreshSession(runtime); });
  pi.on("tool_execution_end", (event) => { if (!runtime) return; runtime.store.update((state) => ({ activeTool: undefined, activeProcesses: Object.freeze(state.activeProcesses.filter((name) => name !== event.toolName)) })); if (event.toolName === "bash" || event.toolName.includes("git")) runtime.scheduler.request(`tool:${event.toolName}`); refreshSession(runtime); });
  pi.on("session_shutdown", async (_event, ctx) => {
    const active = runtime; runtime = undefined;
    if (!active) return;
    await active.disposal.dispose(); active.store.clear();
    if (ctx.mode === "tui") { ctx.ui.setFooter(undefined); ctx.ui.setHeader(undefined); ctx.ui.setEditorComponent(undefined); ctx.ui.setWorkingIndicator(); }
  });
}
