import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportsMediaStatus } from "./room-capabilities.js";

describe("media status room capability", () => {
  it("allows rooms that own media status activity", () => {
    assert.equal(supportsMediaStatus(["synchronized_media", "media_status"]), true);
    assert.equal(supportsMediaStatus(["games", "media_status"]), true);
  });

  it("rejects rooms without media status activity", () => {
    assert.equal(supportsMediaStatus([]), false);
    assert.equal(supportsMediaStatus(["games"]), false);
    assert.equal(supportsMediaStatus(["synchronized_media"]), false);
  });
});
