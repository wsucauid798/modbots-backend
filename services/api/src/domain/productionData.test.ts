import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { devActorIdentityReason } from "./productionData.js";

describe("production data guard", () => {
  it("allows normal production actors", () => {
    assert.equal(
      devActorIdentityReason({
        displayName: "William",
        handle: "william",
      }),
      null,
    );
  });

  it("rejects smoke actor names", () => {
    assert.match(
      devActorIdentityReason({
        displayName: "Smoke Test Human",
        handle: "william",
      }) ?? "",
      /reserved/,
    );
  });

  it("rejects dev and probe handles", () => {
    assert.match(
      devActorIdentityReason({
        displayName: "William",
        handle: "smoke-human",
      }) ?? "",
      /prefix/,
    );
  });

  it("rejects probe display name prefixes", () => {
    assert.match(
      devActorIdentityReason({
        displayName: "Copilot Test 12",
      }) ?? "",
      /prefix/,
    );
  });
});
