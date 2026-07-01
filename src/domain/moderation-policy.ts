import { forbidden } from "./errors.js";

export interface ModerationPolicyConfig {
  minimumConfidence: number;
  allowedActions: string[];
}

export interface ModerationCandidate {
  action: string;
  confidence: number;
}

export class ModerationPolicy {
  private readonly allowedActions: Set<string>;

  public constructor(private readonly config: ModerationPolicyConfig) {
    this.allowedActions = new Set(config.allowedActions);
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
