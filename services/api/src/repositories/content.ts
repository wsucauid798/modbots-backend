import type { Pool } from "pg";

// Contract-facing shapes for content-v1. The normative definition is
// contracts/content-v1.schema.json.

export interface ContentItemReference {
  contentItemId: string;
  contentPartId?: string;
}

export type ContentAddress =
  | { targetType: "room" }
  | { targetType: "actor"; actorId: string };

export type ContentTargetReference =
  | { targetType: "content_item"; contentItemId: string }
  | { targetType: "content_part"; contentItemId: string; contentPartId: string }
  | { targetType: "media_asset"; mediaAssetId: string }
  | { targetType: "voice_session"; voiceSessionId: string }
  | { targetType: "voice_segment"; voiceSegmentId: string };

export interface ContentRelationship {
  relationshipType: "quotes" | "mentions" | "context";
  target: ContentTargetReference;
}

export interface TextContentPart {
  partId: string;
  kind: "text";
  text: string;
  language?: string;
}

export interface AssetContentPart {
  partId: string;
  kind: "image" | "audio" | "video" | "file";
  mediaAssetId: string;
  caption?: string;
  altText?: string;
}

export type ContentPart = TextContentPart | AssetContentPart;

export type ContentLifecycleState = "published" | "edited" | "removed";

export interface ContentItem {
  contractVersion: 1;
  entityType: "content_item";
  contentItemId: string;
  roomId: string;
  roomSequence: string;
  actorId: string;
  createdAt: string;
  updatedAt?: string;
  lifecycleState: ContentLifecycleState;
  revision: number;
  replyTo?: ContentItemReference;
  addressedTo: ContentAddress[];
  parts: ContentPart[];
  references: ContentRelationship[];
}

export interface ContentRepository {
  listByRoom(
    roomId: string,
    options: { after: number; limit: number },
  ): Promise<ContentItem[] | null>;
  getById(roomId: string, contentItemId: string): Promise<ContentItem | null>;
}

export interface ContentItemRow {
  id: string;
  room_id: string;
  room_sequence: string;
  actor_id: string;
  lifecycle_state: ContentLifecycleState;
  revision: number;
  reply_to: ContentItemReference | null;
  addressed_to: ContentAddress[];
  parts: ContentPart[];
  refs: ContentRelationship[];
  created_at: Date;
  updated_at: Date;
}

export const contentItemFromRow = (row: ContentItemRow): ContentItem => ({
  contractVersion: 1,
  entityType: "content_item",
  contentItemId: row.id,
  roomId: row.room_id,
  roomSequence: String(row.room_sequence),
  actorId: row.actor_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  lifecycleState: row.lifecycle_state,
  revision: row.revision,
  ...(row.reply_to === null ? {} : { replyTo: row.reply_to }),
  addressedTo: row.addressed_to,
  parts: row.parts,
  references: row.refs,
});

const selectColumns = `
  id, room_id, room_sequence::text, actor_id, lifecycle_state, revision,
  reply_to, addressed_to, parts, refs, created_at, updated_at
`;

export class PostgresContentRepository implements ContentRepository {
  public constructor(private readonly database: Pool) {}

  public async listByRoom(
    roomId: string,
    options: { after: number; limit: number },
  ): Promise<ContentItem[] | null> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [roomId],
    );

    if (!room.rows[0]?.exists) {
      return null;
    }

    const result = await this.database.query<ContentItemRow>(
      `
        SELECT ${selectColumns}
        FROM content_items
        WHERE room_id = $1 AND room_sequence > $2
        ORDER BY room_sequence ASC
        LIMIT $3
      `,
      [roomId, options.after, options.limit],
    );

    return result.rows.map(contentItemFromRow);
  }

  public async getById(
    roomId: string,
    contentItemId: string,
  ): Promise<ContentItem | null> {
    const result = await this.database.query<ContentItemRow>(
      `
        SELECT ${selectColumns}
        FROM content_items
        WHERE room_id = $1 AND id = $2
      `,
      [roomId, contentItemId],
    );
    const row = result.rows[0];

    return row === undefined ? null : contentItemFromRow(row);
  }
}
