import type { Pool } from "pg";

export type ModerationProposalStatus = "pending" | "accepted" | "rejected";

export interface ModerationProposal {
  id: string;
  roomId: string;
  modBotId: string;
  targetEventSequence: string | null;
  action: string;
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
  target_event_sequence: string | null;
  action: string;
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
          target_event_sequence,
          action,
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
      targetEventSequence: proposal.target_event_sequence,
      action: proposal.action,
      confidence: proposal.confidence,
      rationale: proposal.rationale,
      modelVersion: proposal.model_version,
      status: proposal.status,
      createdAt: proposal.created_at.toISOString(),
      resolvedAt: proposal.resolved_at?.toISOString() ?? null,
    }));
  }
}
