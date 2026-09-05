import type { TUI } from "@earendil-works/pi-tui";

interface SgrMouseEvent { button: number; x: number; y: number; release: boolean; }

export function parseSgrMouse(data: string): SgrMouseEvent | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
  if (!match) return undefined;
  return {
    button: Number.parseInt(match[1]!, 10),
    x: Number.parseInt(match[2]!, 10) - 1,
    y: Number.parseInt(match[3]!, 10) - 1,
    release: match[4] === "m",
  };
}

/**
 * Add Windows-style middle-button rapid scrolling to Pi's fullscreen viewport.
 * Pi does not expose viewport scrolling through its public extension API yet,
 * so this adapter is deliberately capability-checked and becomes a no-op when
 * the fullscreen implementation does not provide the required hooks.
 */
export function installRapidScroll(tui: TUI): () => void {
  const viewport = tui as TUI & {
    handleViewportInput?: (data: string) => { consume?: boolean; data?: string } | undefined;
    scrollBy?: (lines: number) => void;
  };
  if (tui.mode !== "fullscreen" || typeof viewport.handleViewportInput !== "function" || typeof viewport.scrollBy !== "function") return () => {};

  const original = viewport.handleViewportInput;
  let anchorY: number | undefined;
  let pointerY = 0;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => { anchorY = undefined; if (timer) clearInterval(timer); timer = undefined; };
  const tick = () => {
    if (anchorY === undefined) return;
    const delta = pointerY - anchorY;
    if (Math.abs(delta) <= 1) return;
    const lines = Math.sign(delta) * Math.min(12, Math.max(1, Math.floor(Math.abs(delta) / 2)));
    viewport.scrollBy?.(lines);
    tui.requestRender();
  };

  viewport.handleViewportInput = (data: string) => {
    // A terminal can report mouse-up as either the released button or the
    // generic button 3. Stop before checking the button so rapid scrolling
    // cannot remain active and fight subsequent wheel-down input.
    if (data === "\x1b[O") stop();
    const event = parseSgrMouse(data);
    if (!event) return original.call(viewport, data);
    const wheel = (event.button & 64) !== 0;
    if (wheel) {
      // Wheel-down shares its low button bits with the middle button. Forward
      // wheel events before middle-button detection or downward scrolling is
      // incorrectly consumed as the start of rapid scrolling.
      if (anchorY !== undefined) stop();
      return original.call(viewport, data);
    }
    const baseButton = event.button & 3;
    const motion = (event.button & 32) !== 0;
    if (anchorY !== undefined && event.release) {
      stop();
      return { consume: true };
    }
    if (!motion && baseButton === 1 && !event.release) {
      anchorY = event.y; pointerY = event.y;
      if (!timer) timer = setInterval(tick, 32);
      return { consume: true };
    }
    if (anchorY !== undefined && motion && baseButton === 1) {
      pointerY = event.y;
      return { consume: true };
    }
    return original.call(viewport, data);
  };

  return () => { stop(); viewport.handleViewportInput = original; };
}
