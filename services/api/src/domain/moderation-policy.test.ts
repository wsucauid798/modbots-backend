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

  it("requires content actions to target content", () => {
    assert.throws(
      () => {
        policy.assertTargetAllowed("delete_message", {
          targetType: "actor",
          actorId: "actor-1",
        });
      },
      (error) =>
        error instanceof DomainError &&
        error.code === "moderation_target_mismatch",
    );

    assert.doesNotThrow(() => {
      policy.assertTargetAllowed("delete_message", {
        targetType: "content_item",
        contentItemId: "content-1",
      });
    });
  });

  it("requires actor actions to target actors", () => {
    assert.throws(
      () => {
        policy.assertTargetAllowed("mute_actor", {
          targetType: "content_item",
          contentItemId: "content-1",
        });
      },
      (error) =>
        error instanceof DomainError &&
        error.code === "moderation_target_mismatch",
    );

    assert.doesNotThrow(() => {
      policy.assertTargetAllowed("remove_actor", {
        targetType: "actor",
        actorId: "actor-1",
      });
    });

    assert.throws(
      () => {
        policy.assertTargetAllowed("unmute_actor", {
          targetType: "content_item",
          contentItemId: "content-1",
        });
      },
      (error) =>
        error instanceof DomainError &&
        error.code === "moderation_target_mismatch",
    );
  });

  it("does not constrain targets for unknown actions", () => {
    assert.doesNotThrow(() => {
      policy.assertTargetAllowed("escalate_for_review", {
        targetType: "actor",
        actorId: "actor-1",
      });
    });
  });
});
