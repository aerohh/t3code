import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  buildMessageContext,
  fileContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
import {
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map() };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });

  it("keeps an attached file when its chip is deleted, but drops a large paste", () => {
    const pdf = {
      type: "file",
      id: "file-1",
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 3,
      file: new File(["pdf"], "spec.pdf", { type: "application/pdf" }),
    } satisfies ComposerFileAttachment;
    const paste = {
      type: "file",
      id: "file-2",
      name: "pasted-1.txt",
      mimeType: "text/plain;charset=utf-8",
      sizeBytes: 4,
      file: new File(["text"], "pasted-1.txt", { type: "text/plain;charset=utf-8" }),
      source: { _tag: "pasted-text" },
    } satisfies ComposerFileAttachment;
    const retained = retention();

    const deleted = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [pdf, paste],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(deleted.filesToRemove).toEqual(["file-2"]);

    const undone = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([fileContextReference(paste).contextId]),
      files: [pdf],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(undone.filesToRestore).toEqual([paste]);
  });
});
