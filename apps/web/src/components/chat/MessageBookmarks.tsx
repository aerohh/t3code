import { useAtomValue } from "@effect/atom-react";
import type { MessageBookmark, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { messageBookmarkNavigation } from "@t3tools/client-runtime/state/messageBookmarks";
import { BookmarkIcon, CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { messageBookmarkEnvironment } from "../../state/messageBookmarks";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { closeThreadFind } from "./threadFindStore";

function useBookmarks(thread: ScopedThreadRef) {
  const config = useAtomValue(serverEnvironment.configValueAtom(thread.environmentId));
  const supported = config?.messageBookmarks === true;
  const query = useEnvironmentQuery(
    supported
      ? messageBookmarkEnvironment.live({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  const canEdit = useAtomValue(messageBookmarkEnvironment.add.permissionAtom(thread.environmentId));
  return { ...query, supported, canEdit };
}

/** The header shows the bookmarks button only once the chat has a bookmark. */
export function useThreadHasMessageBookmarks(
  thread: ScopedThreadRef | null,
  supported: boolean,
): boolean {
  const { data } = useEnvironmentQuery(
    thread && supported
      ? messageBookmarkEnvironment.live({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  return (data?.length ?? 0) > 0;
}

export function MessageBookmarkButton({
  thread,
  messageId,
}: {
  thread: ScopedThreadRef;
  messageId: MessageId;
}) {
  const { data, supported, canEdit, isSuccess } = useBookmarks(thread);
  const add = useAtomCommand(messageBookmarkEnvironment.add);
  const remove = useAtomCommand(messageBookmarkEnvironment.remove);
  const [pending, setPending] = useState(false);
  if (!supported) return null;
  const saved = data?.some((bookmark) => bookmark.messageId === messageId) ?? false;
  const label = saved ? "Remove bookmark" : "Bookmark message";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            aria-pressed={saved}
            disabled={!canEdit || !isSuccess || pending}
            onClick={async () => {
              setPending(true);
              try {
                const result = await (saved ? remove : add)({
                  environmentId: thread.environmentId,
                  input: { threadId: thread.threadId, messageId },
                });
                if (result._tag === "Failure")
                  toastManager.add({
                    type: "error",
                    title: "Could not update bookmark",
                    description: "Try again.",
                  });
              } finally {
                setPending(false);
              }
            }}
          />
        }
      >
        <BookmarkIcon fill={saved ? "currentColor" : "none"} />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function BookmarkRow({
  bookmark,
  thread,
  canEdit,
  onSelect,
}: {
  bookmark: MessageBookmark;
  thread: ScopedThreadRef;
  canEdit: boolean;
  onSelect: () => void;
}) {
  const rename = useAtomCommand(messageBookmarkEnvironment.rename);
  const remove = useAtomCommand(messageBookmarkEnvironment.remove);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(bookmark.title);
  const [pending, setPending] = useState(false);
  const target = {
    environmentId: thread.environmentId,
    input: { threadId: thread.threadId, messageId: bookmark.messageId },
  };
  return (
    <div className="flex items-center gap-1 py-1">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!title.trim() || pending) return;
            setPending(true);
            try {
              const result = await rename({
                ...target,
                input: { ...target.input, title: title.trim() },
              });
              if (result._tag === "Success") setEditing(false);
              else
                toastManager.add({
                  type: "error",
                  title: "Could not rename bookmark",
                  description: "Try again.",
                });
            } finally {
              setPending(false);
            }
          }}
        >
          <Input
            aria-label="Bookmark title"
            autoFocus
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Button
            aria-label="Save bookmark title"
            type="submit"
            size="icon-xs"
            variant="ghost-muted"
            disabled={pending || !title.trim()}
          >
            <CheckIcon />
          </Button>
          <Button
            aria-label="Cancel rename"
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => setEditing(false)}
          >
            <XIcon />
          </Button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onSelect}
          >
            <span className="line-clamp-2 break-words">{bookmark.title}</span>
          </button>
          {canEdit ? (
            <>
              <Button
                aria-label={`Rename ${bookmark.title}`}
                size="icon-xs"
                variant="ghost-muted"
                onClick={() => {
                  setTitle(bookmark.title);
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                aria-label={`Remove ${bookmark.title}`}
                size="icon-xs"
                variant="ghost-destructive"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  try {
                    const result = await remove(target);
                    if (result._tag === "Failure")
                      toastManager.add({
                        type: "error",
                        title: "Could not remove bookmark",
                        description: "Try again.",
                      });
                  } finally {
                    setPending(false);
                  }
                }}
              >
                <Trash2Icon />
              </Button>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

export function MessageBookmarksPopover({ thread }: { thread: ScopedThreadRef }) {
  const { data, error, supported, canEdit, refresh } = useBookmarks(thread);
  const [open, setOpen] = useState(false);
  if (!supported || !data?.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost-muted" size="icon-sm" aria-label="Chat bookmarks" />}
      >
        <BookmarkIcon className="size-4" />
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="compact" aria-label="Chat bookmarks">
        <PopoverTitle>Bookmarks ({data.length})</PopoverTitle>
        <div className="mt-2 max-h-[min(60vh,28rem)] overflow-y-auto">
          {error ? (
            <div role="alert" className="py-3 text-sm">
              {error}
              <Button variant="ghost" size="sm" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : (
            data.map((bookmark) => (
              <BookmarkRow
                key={bookmark.messageId}
                bookmark={bookmark}
                thread={thread}
                canEdit={canEdit}
                onSelect={() => {
                  // The jump borrows find's match navigation, so an open find would win over it.
                  closeThreadFind();
                  const atom = messageBookmarkNavigation(scopedThreadKey(thread));
                  appAtomRegistry.set(atom, {
                    bookmark,
                    requestId: (appAtomRegistry.get(atom)?.requestId ?? 0) + 1,
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
