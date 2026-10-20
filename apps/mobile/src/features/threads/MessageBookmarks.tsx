import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { MessageBookmark, MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { messageBookmarkEnvironment } from "../../state/messageBookmarks";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestThreadMessageJump } from "./threadMessageJump";

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
export function useThreadHasMessageBookmarks(thread: ScopedThreadRef, supported: boolean): boolean {
  const { data } = useEnvironmentQuery(
    supported
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
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={saved ? "Remove bookmark" : "Bookmark message"}
      accessibilityState={{ selected: saved, disabled: !canEdit || !isSuccess || pending }}
      disabled={!canEdit || !isSuccess || pending}
      hitSlop={8}
      className="size-7 items-center justify-center"
      onPress={async () => {
        setPending(true);
        try {
          const result = await (saved ? remove : add)({
            environmentId: thread.environmentId,
            input: { threadId: thread.threadId, messageId },
          });
          if (result._tag === "Failure") Dialog.alert("Could not update bookmark", "Try again.");
        } finally {
          setPending(false);
        }
      }}
    >
      <SymbolView
        name={saved ? "bookmark.fill" : "bookmark"}
        size={14}
        tintColorClassName="accent-icon-subtle"
      />
    </Pressable>
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
  const [pending, setPending] = useState(false);
  const target = {
    environmentId: thread.environmentId,
    input: { threadId: thread.threadId, messageId: bookmark.messageId },
  };
  return (
    <View className="flex-row items-center gap-2 px-3 py-1">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={bookmark.title}
        onPress={onSelect}
        className="min-h-12 flex-1 justify-center py-2"
      >
        <Text numberOfLines={2} className="text-sm text-foreground">
          {bookmark.title}
        </Text>
      </Pressable>
      {canEdit ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Rename ${bookmark.title}`}
            hitSlop={8}
            className="size-8 items-center justify-center"
            onPress={() =>
              Dialog.prompt({
                title: "Rename bookmark",
                initialValue: bookmark.title,
                confirmText: "Save",
                onConfirm: (value) => {
                  if (!value.trim() || value.trim().length > 160) {
                    Dialog.alert("Use a title between 1 and 160 characters");
                    return;
                  }
                  void rename({ ...target, input: { ...target.input, title: value.trim() } }).then(
                    (result) => {
                      if (result._tag === "Failure")
                        Dialog.alert("Could not rename bookmark", "Try again.");
                    },
                  );
                },
              })
            }
          >
            <SymbolView name="pencil" size={15} tintColorClassName="accent-icon-subtle" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${bookmark.title}`}
            disabled={pending}
            hitSlop={8}
            className="size-8 items-center justify-center"
            onPress={async () => {
              setPending(true);
              try {
                const result = await remove(target);
                if (result._tag === "Failure")
                  Dialog.alert("Could not remove bookmark", "Try again.");
              } finally {
                setPending(false);
              }
            }}
          >
            <SymbolView name="trash" size={15} tintColorClassName="accent-icon-subtle" />
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

export function MessageBookmarksPopup({
  thread,
  open,
  onClose,
}: {
  thread: ScopedThreadRef;
  open: boolean;
  onClose: () => void;
}) {
  const { data, error, canEdit, isPending, refresh } = useBookmarks(thread);
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1" accessibilityViewIsModal>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close bookmarks"
          onPress={onClose}
          className="absolute inset-0 bg-black/20"
        />
        <View
          className="mx-4 self-end overflow-hidden rounded-2xl border border-border-subtle bg-sheet"
          style={{ marginTop: insets.top + 48, width: 340, maxWidth: "92%", maxHeight: "65%" }}
        >
          <View className="flex-row items-center justify-between px-4 py-3">
            <Text className="font-t3-bold text-base text-foreground">
              Bookmarks{data?.length ? ` (${data.length})` : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close bookmarks"
              onPress={onClose}
              hitSlop={8}
            >
              <SymbolView name="xmark" size={16} tintColorClassName="accent-icon-subtle" />
            </Pressable>
          </View>
          {error ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Retry loading bookmarks"
              onPress={refresh}
              className="p-4"
            >
              <Text className="text-foreground">{error} Tap to retry.</Text>
            </Pressable>
          ) : (
            <FlatList
              data={data ?? []}
              keyExtractor={(item) => item.messageId}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text className="px-4 pb-4 text-sm text-foreground-secondary">
                  {isPending ? "Loading bookmarks…" : "Bookmark a message to find it here."}
                </Text>
              }
              renderItem={({ item }) => (
                <BookmarkRow
                  bookmark={item}
                  thread={thread}
                  canEdit={canEdit}
                  onSelect={() => {
                    requestThreadMessageJump(scopedThreadKey(thread), item.messageId);
                    onClose();
                  }}
                />
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
