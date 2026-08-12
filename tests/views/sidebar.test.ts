import assert from "node:assert/strict";
import test from "node:test";
import { SidebarAdapter } from "../../extensions/views/rail.ts";

test("sidebar cleanup is idempotent and removes overlays", () => {
  const events: string[] = [];
  const handle: any = { hide: () => events.push("hide"), setHidden: (hidden: boolean) => events.push(hidden ? "hidden" : "shown") };
  const sidebar = new SidebarAdapter();
  sidebar.show(handle, () => events.push("close")); sidebar.hide(); sidebar.pin(); sidebar.promote(); sidebar.dispose(); sidebar.dispose();
  assert.deepEqual(events, ["shown", "hidden", "shown", "shown", "hide", "close"]);
});
