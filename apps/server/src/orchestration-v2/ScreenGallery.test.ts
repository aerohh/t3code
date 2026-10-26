import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ScreenGallery from "./ScreenGallery.ts";

const layerStorage = Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerGit = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "screen-gallery-git-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layerTest = ScreenGallery.layer.pipe(
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(layerGit),
);
const providerInstanceId = ProviderInstanceId.make("codex");

const addAssistantMessage = (threadId: ThreadId, ordinal: number, at: DateTime.Utc, text: string) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    projections.apply({
      id: EventId.make(`item:${ordinal}`),
      threadId,
      occurredAt: at,
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`item:${ordinal}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        messageId: MessageId.make(`message-${ordinal}`),
        text,
        type: "assistant_message",
        streaming: false,
      },
    }),
  );

it.live("uses this machine's pushes of the thread's branch as checkpoints", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "screen-gallery-" });
    const remote = `${directory}/remote.git`;
    const repo = `${directory}/repo`;
    yield* fs.makeDirectory(repo);
    const run = (cwd: string, args: string[]) =>
      git.execute({ operation: "screen-gallery-test", cwd, args });
    yield* run(directory, ["init", "--bare", remote]);
    yield* run(repo, ["init", "-b", "main"]);
    yield* run(repo, ["remote", "add", "origin", remote]);
    yield* run(repo, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    // Shots are dated far before and after the real push so the test never reads the clock.
    yield* run(repo, ["push", "-u", "origin", "main"]);

    const projectId = ProjectId.make("gallery-project");
    const threadId = ThreadId.make("gallery-thread");
    const createdAt = DateTime.makeUnsafe(Date.UTC(2000, 0, 1));
    yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
      projects.apply({
        sequence: 0,
        eventId: EventId.make("project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(createdAt),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Gallery",
          workspaceRoot: repo,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(createdAt),
          updatedAt: DateTime.formatIso(createdAt),
        },
      }),
    );
    yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
      projections.apply({
        id: EventId.make("thread-created"),
        type: "thread.created",
        threadId,
        providerInstanceId,
        occurredAt: createdAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Gallery",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      }),
    );
    yield* addAssistantMessage(
      threadId,
      1,
      DateTime.makeUnsafe(Date.UTC(2000, 0, 1)),
      '![Starting state](/shots/1.png "Gallery: Settings page")',
    );
    yield* addAssistantMessage(
      threadId,
      2,
      DateTime.makeUnsafe(Date.UTC(2000, 0, 2)),
      '![Blue Save button](/shots/2.png "Gallery: Settings page")\n\n![Other](/shots/x.png)',
    );
    yield* addAssistantMessage(
      threadId,
      3,
      DateTime.makeUnsafe(Date.UTC(2100, 0, 1)),
      '![Save moved right](/shots/3.png "Gallery: Settings page")',
    );

    const gallery = yield* Effect.flatMap(ScreenGallery.ScreenGallery, (service) =>
      service.get({ threadId }),
    );

    assert.strictEqual(gallery.pushBranch, "origin/main");
    assert.strictEqual(gallery.screens.length, 1);
    const settings = gallery.screens[0]!;
    assert.strictEqual(settings.before.src, "/shots/1.png");
    assert.deepStrictEqual(
      settings.pushes.map((push) => push.shot.src),
      ["/shots/2.png"],
    );
    assert.strictEqual(settings.notPushedYet?.note, "Save moved right");
    assert.deepStrictEqual(
      gallery.unlabelled.map((shot) => shot.src),
      ["/shots/x.png"],
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
