import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect } from "react";

import { useThreadShell } from "../state/entities";
import { environmentShell } from "../state/shell";
import { isThreadPairStillValid, type ThreadPair, useThreadPairStore } from "../threadPairStore";

export function ThreadPairCleanup() {
  const pairs = useThreadPairStore((state) => state.pairs);
  return pairs.map((pair) => <ThreadPairCheck key={scopedThreadKey(pair.left)} pair={pair} />);
}

function ThreadPairCheck({ pair }: { pair: ThreadPair }) {
  // Until the server's chat list is live, a chat that is still loading looks the same as a deleted one.
  const shellStatus = useAtomValue(environmentShell.stateValueAtom(pair.left.environmentId)).status;
  const left = useThreadShell(pair.left);
  const right = useThreadShell(pair.right);
  const closePair = useThreadPairStore((state) => state.closePair);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a pair is saved on this device, but archive, delete and move can arrive from any client
  useEffect(() => {
    if (shellStatus !== "live" || isThreadPairStillValid(left, right)) return;
    closePair(pair.left);
  }, [closePair, left, pair.left, right, shellStatus]);

  return null;
}
