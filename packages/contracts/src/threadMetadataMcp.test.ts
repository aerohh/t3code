import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ThreadMetadataMcpUpdateInput } from "./threadMetadataMcp.ts";

const decodeUpdate = Schema.decodeUnknownSync(ThreadMetadataMcpUpdateInput);

describe("ThreadMetadataMcpUpdateInput", () => {
  it("rejects malformed client request ids without normalizing valid keys", () => {
    const validKey = "metadata-\ud83d\ude80-1";
    assert.equal(
      decodeUpdate({ action: "regenerate_title", clientRequestId: validKey }).clientRequestId,
      validKey,
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\ud800" }),
    );
    assert.throws(() =>
      decodeUpdate({ action: "regenerate_title", clientRequestId: "metadata-\udc00" }),
    );
  });

  it("requires a summary for update_summary and accepts one only there", () => {
    const summary = { about: "Fixing the login loop.", verdict: "Fixed.", stillOpen: [] };
    assert.deepEqual(decodeUpdate({ action: "update_summary", summary }).summary, summary);
    assert.throws(() => decodeUpdate({ action: "update_summary" }));
    assert.throws(() => decodeUpdate({ action: "rename", title: "Login", summary }));
  });
});
