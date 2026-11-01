import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

vi.mock(import("./ScreenGallery"), () => ({
  ScreenGalleryButton: () => <button type="button">Screenshot gallery</button>,
}));
vi.mock(import("./MessageBookmarks"), () => ({
  MessageBookmarksPopover: () => <button type="button">Bookmarks</button>,
}));
vi.mock(import("./ThreadAttachments"), () => ({
  ThreadAttachmentsPopover: () => <button type="button">Attachments</button>,
}));

import { PanelLayoutControls } from "./PanelLayoutControls";

const threadRef = (threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make(threadId),
});

const controlsFor = (thread: ScopedThreadRef) => (
  <PanelLayoutControls
    galleryThread={thread}
    bookmarksThread={thread}
    attachmentsThread={thread}
    terminalAvailable
    terminalOpen={false}
    terminalShortcutLabel={null}
    threadPanelOpen={false}
    threadPanelPresentation="inline"
    threadPanelShortcutLabel={null}
    rightPanelAvailable
    rightPanelOpen={false}
    rightPanelShortcutLabel={null}
    onToggleTerminal={() => {}}
    onToggleThreadPanel={() => {}}
    onToggleRightPanel={() => {}}
  />
);

describe("PanelLayoutControls", () => {
  it("keeps one of each thread button when switching between threads", async () => {
    // The controls have no links or navigation, so they need no router.
    await using screen = await render(controlsFor(threadRef("first")), { router: false });
    for (const threadId of ["second", "first", "second"]) {
      await screen.rerender(controlsFor(threadRef(threadId)));
    }

    for (const name of ["Screenshot gallery", "Bookmarks", "Attachments"]) {
      expect(screen.getByRole("button", { name }).elements()).toHaveLength(1);
    }
  });
});
