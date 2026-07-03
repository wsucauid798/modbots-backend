import type { Pool } from "pg";
import type { ContentTargetReference } from "./content.js";

export type ModerationProposalStatus = "pending" | "accepted" | "rejected";

// What a moderation proposal acts against: an actor, or any content-v1
// target (content item, content part, media asset, voice session, voice
// segment).
export type ModerationTarget =
  | { targetType: "actor"; actorId: string }
  | ContentTargetReference;

// One cited piece of evidence. A proposal may cite several, so cross-modal
// context (an image and a later response) survives review and training.
export interface ModerationEvidence {
  target: ModerationTarget;
  note?: string;
}

export interface ModerationProposal {
  id: string;
  roomId: string;
  modBotId: string;
  target: ModerationTarget | null;
  targetEventSequence: string | null;
  evidence: ModerationEvidence[];
  action: string;
  ruleId: string | null;
  rulesVersion: string | null;
  confidence: number;
  rationale: unknown;
  modelVersion: string;
  status: ModerationProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ModerationRepository {
  listProposals(
    roomId: string,
    options: { status?: ModerationProposalStatus; limit: number },
  ): Promise<ModerationProposal[] | null>;
}

interface ProposalRow {
  id: string;
  room_id: string;
  mod_bot_id: string;
  target: ModerationTarget | null;
  target_event_sequence: string | null;
  evidence: ModerationEvidence[];
  action: string;
  rule_id: string | null;
  rules_version: string | null;
  confidence: number;
  rationale: unknown;
  model_version: string;
  status: ModerationProposalStatus;
  created_at: Date;
  resolved_at: Date | null;
}

export class PostgresModerationRepository implements ModerationRepository {
  public constructor(private readonly database: Pool) {}

  public async listProposals(
    roomId: string,
    options: { status?: ModerationProposalStatus; limit: number },
  ): Promise<ModerationProposal[] | null> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [roomId],
    );

    if (!room.rows[0]?.exists) {
      return null;
    }

    const result = await this.database.query<ProposalRow>(
      `
        SELECT
          id,
          room_id,
          mod_bot_id,
          target,
          target_event_sequence,
          evidence,
          action,
          rule_id,
          rules_version,
          confidence,
          rationale,
          model_version,
          status,
          created_at,
          resolved_at
        FROM moderation_proposals
        WHERE room_id = $1
          AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3
      `,
      [roomId, options.status ?? null, options.limit],
    );

    return result.rows.map((proposal) => ({
      id: proposal.id,
      roomId: proposal.room_id,
      modBotId: proposal.mod_bot_id,
      target: proposal.target,
      targetEventSequence: proposal.target_event_sequence,
      evidence: proposal.evidence,
      action: proposal.action,
      ruleId: proposal.rule_id,
      rulesVersion: proposal.rules_version,
      confidence: proposal.confidence,
      rationale: proposal.rationale,
      modelVersion: proposal.model_version,
      status: proposal.status,
      createdAt: proposal.created_at.toISOString(),
      resolvedAt: proposal.resolved_at?.toISOString() ?? null,
    }));
  }
}
