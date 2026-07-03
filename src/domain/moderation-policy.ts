import type { ModerationTarget } from "../repositories/moderation.js";
import { forbidden } from "./errors.js";

export interface ModerationPolicyConfig {
  minimumConfidence: number;
  allowedActions: string[];
}

export interface ModerationCandidate {
  action: string;
  confidence: number;
}

// Deterministic agreement between an action and the kind of target it may
// act on. Actions without an entry here are unknown to the policy; the
// acceptance allowlist still gates them.
const actionTargetTypes: Record<string, ReadonlySet<string>> = {
  delete_message: new Set(["content_item", "content_part"]),
  mute_actor: new Set(["actor"]),
  unmute_actor: new Set(["actor"]),
  remove_actor: new Set(["actor"]),
};

export class ModerationPolicy {
  private readonly allowedActions: Set<string>;

  public constructor(private readonly config: ModerationPolicyConfig) {
    this.allowedActions = new Set(config.allowedActions);
  }

  public assertTargetAllowed(action: string, target: ModerationTarget): void {
    const allowedTargetTypes = actionTargetTypes[action];

    if (
      allowedTargetTypes !== undefined &&
      !allowedTargetTypes.has(target.targetType)
    ) {
      throw forbidden(
        "moderation_target_mismatch",
        `Moderation action '${action}' cannot target '${target.targetType}'`,
      );
    }
  }

  public assertCanAccept(candidate: ModerationCandidate): void {
    if (!this.allowedActions.has(candidate.action)) {
      throw forbidden(
        "moderation_action_not_allowed",
        `Moderation action '${candidate.action}' is not allowed`,
      );
    }

    if (candidate.confidence < this.config.minimumConfidence) {
      throw forbidden(
        "moderation_confidence_too_low",
        `Proposal confidence must be at least ${this.config.minimumConfidence}`,
      );
    }
  }
}
