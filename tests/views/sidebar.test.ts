import assert from "node:assert/strict";
import test from "node:test";
import { SidebarAdapter } from "../../extensions/views/rail.ts";

test("sidebar cleanup is idempotent and removes overlays", () => {
  const events: string[] = [];
  const handle: any = {
    hide: () => events.push("hide"),
    setHidden: (hidden: boolean) => events.push(hidden ? "hidden" : "shown"),
    focus: () => events.push("focus"),
    unfocus: () => events.push("unfocus"),
    isFocused: () => false,
    isHidden: () => false,
  };
  const sidebar = new SidebarAdapter();
  sidebar.show(handle, () => events.push("close"), () => events.push("remount"));
  sidebar.hide(); sidebar.pin(); sidebar.promote(); sidebar.focus(); sidebar.relayout(); sidebar.collapse(); sidebar.dispose(); sidebar.dispose();
  assert.deepEqual(events, ["shown", "unfocus", "hidden", "shown", "shown", "shown", "focus", "remount", "unfocus", "hidden", "hide", "close"]);
});
