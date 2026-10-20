import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  canPairThreads,
  isThreadPairStillValid,
  resolveSideBySideMenuOption,
  type ThreadPair,
  useThreadPairStore,
} from "./threadPairStore";

const environmentId = "env-1" as EnvironmentId;
const thread = (id: string, projectId = "project-1", archivedAt: string | null = null) => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  archivedAt,
  deletedAt: null,
});
const ref = (id: string) => scopeThreadRef(environmentId, ThreadId.make(id));

const chatA = thread("A");
const chatB = thread("B");
const chatC = thread("C");
const chatD = thread("D", "project-2");

beforeEach(() => {
  useThreadPairStore.setState({ pairs: [] });
});

describe("canPairThreads", () => {
  const pairAB: ThreadPair[] = [{ left: ref("A"), right: ref("B") }];

  it.each([
    { name: "two chats in the same project", pairs: [], left: chatA, right: chatB, ok: true },
    { name: "chats in different projects", pairs: [], left: chatA, right: chatD, ok: false },
    { name: "a chat with itself", pairs: [], left: chatA, right: chatA, ok: false },
    {
      name: "an archived chat",
      pairs: [],
      left: chatA,
      right: thread("B", "project-1", "2026-10-19T00:00:00.000Z"),
      ok: false,
    },
    { name: "a chat already in a pair", pairs: pairAB, left: chatC, right: chatB, ok: false },
    {
      name: "two chats outside any pair",
      pairs: pairAB,
      left: chatC,
      right: thread("E"),
      ok: true,
    },
  ])("$name → $ok", ({ pairs, left, right, ok }) => {
    expect(canPairThreads(pairs, left, right)).toBe(ok);
  });
});

describe("isThreadPairStillValid", () => {
  it.each([
    { name: "both chats still in the project", left: chatA, right: chatB, ok: true },
    { name: "one chat deleted", left: chatA, right: null, ok: false },
    {
      name: "one chat archived",
      left: chatA,
      right: thread("B", "project-1", "2026-10-19T00:00:00.000Z"),
      ok: false,
    },
    {
      name: "one chat moved to another project",
      left: chatA,
      right: thread("B", "project-2"),
      ok: false,
    },
  ])("$name → $ok", ({ left, right, ok }) => {
    expect(isThreadPairStillValid(left, right)).toBe(ok);
  });
});

describe("resolveSideBySideMenuOption", () => {
  const pairAB: ThreadPair[] = [{ left: ref("A"), right: ref("B") }];
  const base = { pairs: [], inScratchProject: false, fitsOnScreen: true };

  it.each([
    {
      name: "a paired chat offers close",
      input: { ...base, pairs: pairAB, thread: chatB, currentThread: chatC },
      expected: { kind: "close" },
    },
    {
      name: "the current chat offers a picker",
      input: { ...base, thread: chatA, currentThread: chatA },
      expected: { kind: "pick", blockedReason: null },
    },
    {
      name: "another chat in the project pairs with the current one",
      input: { ...base, thread: chatB, currentThread: chatA },
      expected: { kind: "pair", blockedReason: null },
    },
    {
      name: "a chat in another project is greyed out",
      input: { ...base, thread: chatD, currentThread: chatA },
      expected: { kind: "pair", blockedReason: "different project" },
    },
    {
      name: "no room greys out the picker",
      input: { ...base, fitsOnScreen: false, thread: chatA, currentThread: chatA },
      expected: { kind: "pick", blockedReason: "not enough room" },
    },
    {
      name: "a chat without a project offers nothing",
      input: { ...base, inScratchProject: true, thread: chatA, currentThread: chatA },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveSideBySideMenuOption(input)).toEqual(expected);
  });
});

describe("saved pairs", () => {
  it("survive a reload and drop malformed entries", async () => {
    const { storage, name } = useThreadPairStore.persist.getOptions();
    await storage!.setItem(name!, {
      state: {
        pairs: [
          { left: ref("A"), right: ref("B") },
          { left: ref("C") },
          { left: {}, right: ref("D") },
          null,
        ] as ThreadPair[],
      },
      version: 1,
    });

    await useThreadPairStore.persist.rehydrate();

    expect(useThreadPairStore.getState().pairs).toEqual([{ left: ref("A"), right: ref("B") }]);
  });

  it.each([null, {}, { pairs: null }, { pairs: "invalid" }])(
    "load malformed saved data %j as no pairs",
    async (state) => {
      const { storage, name } = useThreadPairStore.persist.getOptions();
      await storage!.setItem(name!, { state: state as { pairs: ThreadPair[] }, version: 1 });

      await useThreadPairStore.persist.rehydrate();

      expect(useThreadPairStore.getState().pairs).toEqual([]);
    },
  );
});
