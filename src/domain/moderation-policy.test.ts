import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "./errors.js";
import { ModerationPolicy } from "./moderation-policy.js";

const policy = new ModerationPolicy({
  minimumConfidence: 0.9,
  allowedActions: ["delete_message"],
});

describe("ModerationPolicy", () => {
  it("allows configured actions above the confidence threshold", () => {
    assert.doesNotThrow(() => {
      policy.assertCanAccept({
        action: "delete_message",
        confidence: 0.95,
      });
    });
  });

  it("rejects actions outside the deterministic allowlist", () => {
    assert.throws(
      () => {
        policy.assertCanAccept({
          action: "ban_actor",
          confidence: 0.99,
        });
      },
      (error) =>
        error instanceof DomainError &&
        error.code === "moderation_action_not_allowed",
    );
  });

  it("rejects proposals below the confidence threshold", () => {
    assert.throws(
      () => {
        policy.assertCanAccept({
          action: "delete_message",
          confidence: 0.89,
        });
      },
      (error) =>
        error instanceof DomainError &&
        error.code === "moderation_confidence_too_low",
    );
  });
});
