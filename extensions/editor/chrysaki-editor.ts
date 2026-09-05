import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const CTRL_BACKSPACE_SEQUENCES = new Set([
  "\x1b[127;5u", // CSI-u (Ghostty / tmux extended-keys-format csi-u)
  "\x1b[27;5;127~", // xterm modifyOtherKeys (tmux compatibility form)
]);

/** Chrysaki's always-on editor shell: balanced inset and terminal-safe word deletion. */
export class ChrysakiEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, { paddingX: 2 });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+backspace") || CTRL_BACKSPACE_SEQUENCES.has(data)) {
      // Pi's portable delete-word binding is Ctrl+W. Translate the terminal's
      // Ctrl+Backspace encoding so it works through Ghostty and tmux alike.
      super.handleInput("\x17");
      return;
    }
    super.handleInput(data);
  }
}
