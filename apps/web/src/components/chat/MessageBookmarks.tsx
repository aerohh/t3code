import { useAtomValue } from "@effect/atom-react";
import type {
  AssistantCitation,
  MessageBookmarkWithExchange,
  MessageId,
  RunId,
  SavedMessageBookmark,
  ScopedThreadRef,
  TurnItemId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { messageBookmarkNavigation } from "@t3tools/client-runtime/state/messageBookmarks";
import {
  AppWindowIcon,
  BookmarkIcon,
  CheckIcon,
  CornerDownRightIcon,
  PanelRightIcon,
  PaperclipIcon,
  PencilIcon,
  QuoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import { useRightPanelStore } from "../../rightPanelStore";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  messageBookmarkEnvironment,
  messageBookmarkMessagesQuery,
  unbookmarkableRunIdsAtom,
} from "../../state/messageBookmarks";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { assistantCitationNavigation } from "../../lib/assistantCitationNavigation";
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
  const panelSupported = config?.messageBookmarksPanel === true;
  const query = useEnvironmentQuery(
    supported
      ? messageBookmarkEnvironment.live({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  const canEdit = useAtomValue(messageBookmarkEnvironment.add.permissionAtom(thread.environmentId));
  return { ...query, supported, panelSupported, canEdit };
}

function useJumpToMessageBookmark(thread: ScopedThreadRef) {
  const navigate = useNavigate();
  return (bookmark: SavedMessageBookmark) => {
    const { target } = bookmark;
    if (target.type === "text") {
      // Opening it like a citation scrolls to the exact words and highlights them.
      void navigate(
        assistantCitationNavigation({
          version: 1,
          environmentId: thread.environmentId,
          threadId: thread.threadId,
          messageId: target.messageId,
          ...target.selection,
        }),
      );
      return;
    }
    // The jump borrows find's match navigation, so an open find would win over it.
    closeThreadFind();
    const atom = messageBookmarkNavigation(scopedThreadKey(thread));
    appAtomRegistry.set(atom, {
      target: {
        entryId: target.type === "page" ? target.itemId : target.messageId,
        runId: bookmark.runId,
      },
      requestId: (appAtomRegistry.get(atom)?.requestId ?? 0) + 1,
    });
  };
}

/** Null when the item isn't in the loaded chat; the server still refuses unfinished turns. */
function useVisibleItemRunId(
  thread: ScopedThreadRef,
  matches: (item: ThreadStructureTurnItem) => boolean,
): RunId | null {
  const structure = useQuietThreadProjection(thread);
  return (
    structure?.projection.visibleTurnItems.find((entry) => matches(entry.item))?.item.runId ?? null
  );
}

function bookmarkFailureDescription(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Try again.";
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
  runId,
}: {
  thread: ScopedThreadRef;
  messageId: MessageId;
  runId: RunId | null;
}) {
  const { data, supported, canEdit, isSuccess } = useBookmarks(thread);
  const unbookmarkableRunIds = useAtomValue(unbookmarkableRunIdsAtom(thread));
  const add = useAtomCommand(messageBookmarkEnvironment.add);
  const remove = useAtomCommand(messageBookmarkEnvironment.remove);
  const [pending, setPending] = useState(false);
  if (!supported) return null;
  if (runId !== null && unbookmarkableRunIds.has(runId)) return null;
  // A whole-message bookmark's id is its message id.
  const saved = data?.some((bookmark) => bookmark.id === messageId) ?? false;
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
              const result = await (saved
                ? remove({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.threadId, bookmarkId: messageId },
                  })
                : add({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.threadId, target: { type: "message", messageId } },
                  }));
              setPending(false);
              if (result._tag === "Failure")
                toastManager.add({
                  type: "error",
                  title: "Could not update bookmark",
                  description: "Try again.",
                });
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

/** Beside Cite in the selection toolbar: saves just the selected words of an agent reply. */
export function MessageBookmarkSelectionButton({
  thread,
  citation,
}: {
  thread: ScopedThreadRef;
  citation: AssistantCitation;
}) {
  const { supported, canEdit } = useBookmarks(thread);
  const unbookmarkableRunIds = useAtomValue(unbookmarkableRunIdsAtom(thread));
  const runId = useVisibleItemRunId(
    thread,
    (item) => item.type === "assistant_message" && item.messageId === citation.messageId,
  );
  const add = useAtomCommand(messageBookmarkEnvironment.add);
  if (!supported || !canEdit) return null;
  if (runId !== null && unbookmarkableRunIds.has(runId)) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="glass"
      aria-label="Bookmark selection"
      onClick={async () => {
        const result = await add({
          environmentId: thread.environmentId,
          input: {
            threadId: thread.threadId,
            target: {
              type: "text",
              messageId: citation.messageId,
              selection: {
                text: citation.text,
                start: citation.start,
                end: citation.end,
                prefix: citation.prefix,
                suffix: citation.suffix,
              },
            },
          },
        });
        if (result._tag === "Failure")
          toastManager.add({
            type: "error",
            title: "Could not bookmark selection",
            description: bookmarkFailureDescription(result),
          });
      }}
    >
      <BookmarkIcon aria-hidden="true" className="size-3.5" />
      Bookmark
    </Button>
  );
}

/** In an inline page's title bar: saves just that page. */
export function MessageBookmarkPageButton({
  thread,
  itemId,
}: {
  thread: ScopedThreadRef;
  itemId: TurnItemId;
}) {
  const { data, supported, canEdit, isSuccess } = useBookmarks(thread);
  const unbookmarkableRunIds = useAtomValue(unbookmarkableRunIdsAtom(thread));
  const runId = useVisibleItemRunId(thread, (item) => item.id === itemId);
  const add = useAtomCommand(messageBookmarkEnvironment.add);
  const remove = useAtomCommand(messageBookmarkEnvironment.remove);
  const [pending, setPending] = useState(false);
  if (!supported) return null;
  if (runId !== null && unbookmarkableRunIds.has(runId)) return null;
  const bookmarkId = `page:${itemId}`;
  const saved = data?.some((bookmark) => bookmark.id === bookmarkId) ?? false;
  const label = saved ? "Remove page bookmark" : "Bookmark page";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={saved}
            size="icon-xs"
            variant="ghost"
            disabled={!canEdit || !isSuccess || pending}
            onClick={async () => {
              setPending(true);
              const result = await (saved
                ? remove({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.threadId, bookmarkId },
                  })
                : add({
                    environmentId: thread.environmentId,
                    input: { threadId: thread.threadId, target: { type: "page", itemId } },
                  }));
              setPending(false);
              if (result._tag === "Failure")
                toastManager.add({
                  type: "error",
                  title: "Could not update bookmark",
                  description: bookmarkFailureDescription(result),
                });
            }}
          />
        }
      >
        <BookmarkIcon className="size-3.5" fill={saved ? "currentColor" : "none"} />
      </TooltipTrigger>
      <TooltipPopup side="left">{label}</TooltipPopup>
    </Tooltip>
  );
}

function BookmarkKindIcon({ bookmark }: { bookmark: SavedMessageBookmark }) {
  if (bookmark.target.type === "text")
    return <QuoteIcon aria-label="Text" className="size-3.5 shrink-0 text-muted-foreground" />;
  if (bookmark.target.type === "page")
    return <AppWindowIcon aria-label="Page" className="size-3.5 shrink-0 text-muted-foreground" />;
  return null;
}

function BookmarkRow({
  bookmark,
  thread,
  canEdit,
  onSelect,
}: {
  bookmark: SavedMessageBookmark;
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
    input: { threadId: thread.threadId, bookmarkId: bookmark.id },
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
            const result = await rename({
              ...target,
              input: { ...target.input, title: title.trim() },
            });
            setPending(false);
            if (result._tag === "Success") setEditing(false);
            else
              toastManager.add({
                type: "error",
                title: "Could not rename bookmark",
                description: "Try again.",
              });
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
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-1.5 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onSelect}
          >
            <BookmarkKindIcon bookmark={bookmark} />
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
                  const result = await remove(target);
                  setPending(false);
                  if (result._tag === "Failure")
                    toastManager.add({
                      type: "error",
                      title: "Could not remove bookmark",
                      description: "Try again.",
                    });
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

export function MessageBookmarksPopover({
  thread,
  rightPanelAvailable = false,
}: {
  thread: ScopedThreadRef;
  /** Side chats have no right panel of their own, so they never offer the panel link. */
  rightPanelAvailable?: boolean;
}) {
  const { data, error, supported, panelSupported, canEdit, refresh } = useBookmarks(thread);
  const jumpToMessageBookmark = useJumpToMessageBookmark(thread);
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
                key={bookmark.id}
                bookmark={bookmark}
                thread={thread}
                canEdit={canEdit}
                onSelect={() => {
                  jumpToMessageBookmark(bookmark);
                  setOpen(false);
                }}
              />
            ))
          )}
        </div>
        {panelSupported && rightPanelAvailable ? (
          <div className="mt-1 border-t border-border/60 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                useRightPanelStore.getState().open(thread, "bookmarks");
                setOpen(false);
              }}
            >
              <PanelRightIcon />
              Open in panel
            </Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function MessageBookmarkExchange({
  bookmarkedMessageId,
  exchange,
  thread,
  cwd,
  loading,
}: {
  bookmarkedMessageId: MessageId;
  exchange: MessageBookmarkWithExchange | undefined;
  thread: ScopedThreadRef;
  cwd: string | undefined;
  loading: boolean;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (!exchange)
    return (
      <p className="text-xs text-muted-foreground">
        {loading ? "Loading message…" : "This message is no longer available."}
      </p>
    );
  return exchange.entries.map((item) => {
    if (item.type === "page")
      return (
        <HtmlRenderFrame
          key={item.itemId}
          environmentId={thread.environmentId}
          htmlRender={item.htmlRender}
          threadRef={thread}
        />
      );
    const message = item;
    const fromUser = message.role === "user";
    return (
      <section
        key={message.messageId}
        className={fromUser ? "flex min-w-0 flex-col items-end" : "min-w-0"}
      >
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {formatDayAwareTimestamp(message.createdAt, timestampFormat)}
          {message.messageId === bookmarkedMessageId ? (
            <BookmarkIcon aria-label="Bookmarked" className="size-3" fill="currentColor" />
          ) : null}
        </p>
        <div
          className={
            fromUser
              ? "mt-1 min-w-0 max-w-[90%] rounded-2xl bg-message px-3 py-2 text-sm text-message-foreground"
              : "mt-1 min-w-0 text-sm"
          }
        >
          {message.text.trim() ? (
            <ChatMarkdown
              text={message.text}
              cwd={cwd}
              threadRef={thread}
              lineBreaks={fromUser}
              parseRawHtml={!fromUser}
            />
          ) : null}
          {message.attachments.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-1 text-xs opacity-80">
              {message.attachments.map((attachment) => (
                <li key={attachment.id} className="flex min-w-0 items-center gap-1.5">
                  <PaperclipIcon className="size-3 shrink-0" />
                  <span className="truncate">{attachment.name}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    );
  });
}

function MessageBookmarkCard({
  bookmark,
  exchange,
  thread,
  canEdit,
  cwd,
  loading,
}: {
  bookmark: SavedMessageBookmark;
  exchange: MessageBookmarkWithExchange | undefined;
  thread: ScopedThreadRef;
  canEdit: boolean;
  cwd: string | undefined;
  loading: boolean;
}) {
  const remove = useAtomCommand(messageBookmarkEnvironment.remove);
  const jumpToMessageBookmark = useJumpToMessageBookmark(thread);
  const [removing, setRemoving] = useState(false);
  const { target } = bookmark;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border/70 px-3 py-3">
      {target.type === "message" ? (
        <MessageBookmarkExchange
          bookmarkedMessageId={target.messageId}
          exchange={exchange}
          thread={thread}
          cwd={cwd}
          loading={loading}
        />
      ) : target.type === "text" ? (
        // The selection holds the words as shown, not the reply's Markdown, so it stays plain text.
        <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm">
          {target.selection.text}
        </blockquote>
      ) : (
        <HtmlRenderFrame
          environmentId={thread.environmentId}
          htmlRender={target.htmlRender}
          threadRef={thread}
        />
      )}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="xs" onClick={() => jumpToMessageBookmark(bookmark)}>
          <CornerDownRightIcon />
          {target.type === "page" ? "Go to page" : "Go to message"}
        </Button>
        {canEdit ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              const result = await remove({
                environmentId: thread.environmentId,
                input: { threadId: thread.threadId, bookmarkId: bookmark.id },
              });
              setRemoving(false);
              if (result._tag === "Failure")
                toastManager.add({
                  type: "error",
                  title: "Could not remove bookmark",
                  description: "Try again.",
                });
            }}
          >
            <Trash2Icon />
            Remove
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * Right panel tab: every bookmark in the chat. A whole-message bookmark shows its prompt-and-reply
 * exchange; a text or page bookmark shows only what was saved.
 */
export function MessageBookmarksPanel({
  thread,
  cwd,
}: {
  thread: ScopedThreadRef;
  cwd: string | undefined;
}) {
  const { data, error, panelSupported, canEdit } = useBookmarks(thread);
  const messages = useEnvironmentQuery(
    panelSupported
      ? messageBookmarkMessagesQuery({
          environmentId: thread.environmentId,
          input: { threadId: thread.threadId },
        })
      : null,
  );
  const latestRun = useQuietThreadShell(thread)?.latestRun;
  // Titles don't show here, so only a changed set of bookmarked messages, or a turn
  // starting or finishing its reply, needs the exchanges fetched again. Text and page
  // bookmarks carry their own content.
  const exchangesKey = data
    ? `${data
        .flatMap((bookmark) => (bookmark.target.type === "message" ? [bookmark.id] : []))
        .join(",")}|${latestRun?.runId}:${latestRun?.completedAt}`
    : null;
  const fetchedKeyRef = useRef(exchangesKey);
  const refreshMessages = messages.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches server data when bookmarks change or a turn finishes
  useEffect(() => {
    if (exchangesKey === fetchedKeyRef.current) return;
    fetchedKeyRef.current = exchangesKey;
    refreshMessages();
  }, [exchangesKey, refreshMessages]);

  if (!panelSupported)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This server can't show bookmarks in the panel yet.
      </p>
    );
  if (error ?? messages.error)
    return (
      <div role="alert" className="p-4 text-sm">
        {error ?? messages.error}
        <Button variant="ghost" size="sm" onClick={messages.refresh}>
          Retry
        </Button>
      </div>
    );
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading bookmarks…</p>;
  if (data.length === 0)
    return <p className="p-4 text-sm text-muted-foreground">This chat has no bookmarks.</p>;
  const exchangesByBookmarkId = new Map(
    (messages.data ?? []).map((exchange) => [exchange.bookmarkId, exchange]),
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 px-4 pt-3 pb-2 text-sm font-medium">Bookmarks ({data.length})</p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
        {data.map((bookmark) => (
          <MessageBookmarkCard
            key={bookmark.id}
            bookmark={bookmark}
            exchange={exchangesByBookmarkId.get(bookmark.id)}
            thread={thread}
            canEdit={canEdit}
            cwd={cwd}
            loading={messages.isPending}
          />
        ))}
      </div>
    </div>
  );
}
