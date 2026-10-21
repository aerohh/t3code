import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

/** Matches ThreadTagName in contracts; the server rejects anything longer. */
const THREAD_TAG_NAME_MAX_LENGTH = 40;

type Request = { readonly resolve: (tagName: string | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/** Asks the user for a tag name. Resolves the trimmed name, or null when cancelled. */
export function requestNewTagName(): Promise<string | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(tagName: string | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(tagName);
}

export function NewTagDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <NewTagDialog /> : null;
}

function NewTagDialog() {
  const id = useId();
  const [tagName, setTagName] = useState("");
  const trimmedTagName = tagName.trim();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmedTagName === "") return;
            finish(trimmedTagName);
          }}
        >
          <DialogHeader>
            <DialogTitle>New tag</DialogTitle>
            <DialogDescription>Chats with the same tag are grouped together.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                autoFocus
                maxLength={THREAD_TAG_NAME_MAX_LENGTH}
                placeholder="Billing"
                value={tagName}
                onChange={(event) => setTagName(event.target.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmedTagName === ""}>
              Add tag
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
