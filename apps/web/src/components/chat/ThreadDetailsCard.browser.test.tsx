import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { ThreadPaneContext } from "../../threadPaneContext";
import { SidebarThreadDetailsPanelSlot, SidebarThreadDetailsSlot } from "../sidebar/SidebarChrome";
import { SidebarProvider } from "../ui/sidebar";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};

async function setup() {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  // Below the mobile breakpoint the sidebar is a sheet, closed by default.
  await page.viewport(1280, 800);
}

const menuOpen = () =>
  selectThreadPanelOpen(useRightPanelStore.getState().threadPanelVisibilityByThreadKey, threadRef);

function Harness({
  sidebarOpen,
  activePane = true,
}: {
  sidebarOpen: boolean;
  activePane?: boolean;
}) {
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <SidebarThreadDetailsPanelSlot />
      <ul>
        <SidebarThreadDetailsSlot />
      </ul>
      <ThreadPaneContext value={{ side: "left", isActivePane: activePane, closePair: () => {} }}>
        <ThreadDetailsCard threadRef={threadRef} summary={<span>dev</span>} hint="+1 -0">
          <p>Details for thread-a</p>
        </ThreadDetailsCard>
      </ThreadPaneContext>
    </SidebarProvider>
  );
}

it("shows the chat's branch in the sidebar and opens its details inside it", async () => {
  await setup();
  await using _screen = await render(<Harness sidebarOpen />);
  await expect.element(page.getByText("Details for thread-a")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "dev" }));
  await expect.element(page.getByText("Details for thread-a")).toBeVisible();
  expect(menuOpen()).toBe(true);
  expect(document.querySelector("[data-sidebar-thread-details-panel]")?.textContent).toContain(
    "Details for thread-a",
  );
  await userEvent.click(page.getByRole("button", { name: "dev" }));
  await expect.element(page.getByText("Details for thread-a")).not.toBeInTheDocument();
});

it("shows nothing while the sidebar is closed and drops a menu left open", async () => {
  await setup();
  useRightPanelStore.getState().setThreadPanelOpen(threadRef, true);
  await using _screen = await render(<Harness sidebarOpen={false} />);
  await expect.element(page.getByRole("button", { name: "dev" })).not.toBeInTheDocument();
  expect(menuOpen()).toBe(false);
});

it("leaves the row to the active chat of a side-by-side pair", async () => {
  await setup();
  await using _screen = await render(<Harness sidebarOpen activePane={false} />);
  await expect.element(page.getByRole("button", { name: "dev" })).not.toBeInTheDocument();
});
