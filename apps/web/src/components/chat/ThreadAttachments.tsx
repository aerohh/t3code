import { WS_METHODS, type ScopedThreadRef, type ThreadAttachmentEntry } from "@t3tools/contracts";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { ClipboardPasteIcon, PaperclipIcon } from "lucide-react";
import { useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useClientSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { middleTruncateAttachmentName } from "../composerInlineChip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { PierreEntryIcon } from "./PierreEntryIcon";

const threadAttachmentsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-attachments",
  tag: WS_METHODS.threadAttachmentsList,
});

/**
 * The header shows the attachments button only once the chat has an attachment. The server
 * answers for history the client has not loaded; loaded messages cover a file sent just now.
 */
export function useThreadHasAttachments(
  thread: ScopedThreadRef | null,
  supported: boolean,
  loadedMessagesHaveAttachments: boolean,
): boolean {
  const { data } = useEnvironmentQuery(
    thread && supported
      ? threadAttachmentsQuery({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  return supported && (loadedMessagesHaveAttachments || (data?.entries.length ?? 0) > 0);
}

// Short enough to fit the popup row, so the middle is cut and the extension stays visible.
const ROW_NAME_MAX_CHARACTERS = 30;

function AttachmentRow({
  entry,
  onSelect,
}: {
  entry: ThreadAttachmentEntry;
  onSelect: () => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const { resolvedTheme } = useTheme();
  const attachedAt = formatDayAwareTimestamp(entry.lastAttachedAt, timestampFormat);
  return (
    <button
      type="button"
      className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
      onClick={onSelect}
    >
      {entry.kind === "pasted-text" ? (
        <ClipboardPasteIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <PierreEntryIcon
          pathValue={entry.name}
          kind="file"
          mimeType={entry.mimeType}
          theme={resolvedTheme}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {middleTruncateAttachmentName(entry.name, ROW_NAME_MAX_CHARACTERS)}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatAttachmentSize(entry.sizeBytes)} ·{" "}
          {entry.timesAttached > 1
            ? `attached ${entry.timesAttached} times · last ${attachedAt}`
            : attachedAt}
        </span>
      </span>
    </button>
  );
}

export function ThreadAttachmentsPopover({ thread }: { thread: ScopedThreadRef }) {
  const { data, error, refresh } = useEnvironmentQuery(
    threadAttachmentsQuery({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId },
    }),
  );
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) refresh();
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="icon-sm" aria-label="Chat attachments" />}
      >
        <PaperclipIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="compact" aria-label="Chat attachments">
        <PopoverTitle>Attachments{data ? ` (${data.entries.length})` : ""}</PopoverTitle>
        <div className="mt-2 max-h-[min(60vh,28rem)] overflow-y-auto">
          {error ? (
            <div role="alert" className="py-3 text-sm">
              {error}
              <Button variant="ghost" size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : !data ? (
            <p className="py-3 text-sm text-muted-foreground">Loading attachments…</p>
          ) : data.entries.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No attachments in this chat.</p>
          ) : (
            data.entries.map((entry) => (
              <AttachmentRow
                key={entry.id}
                entry={entry}
                onSelect={() => {
                  useRightPanelStore.getState().openAttachment(thread, {
                    type: "file",
                    id: entry.id,
                    name: entry.name,
                    mimeType: entry.mimeType,
                    sizeBytes: entry.sizeBytes,
                  });
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
