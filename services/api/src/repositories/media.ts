import { createHash, randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import * as Minio from "minio";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { notFound } from "../domain/errors.js";

export type MediaKind = "image" | "audio" | "video" | "file";

export interface MediaAsset {
  contractVersion: 1;
  entityType: "media_asset";
  mediaAssetId: string;
  roomId: string;
  ownerActorId: string;
  mediaKind: MediaKind;
  originalFilename: string;
  declaredMediaType: string;
  detectedMediaType?: string;
  byteLength: string;
  sha256?: string;
  lifecycleState:
    | "initiated"
    | "uploaded"
    | "quarantined"
    | "processing"
    | "published"
    | "rejected"
    | "deleted";
  createdAt: string;
  updatedAt?: string;
  publishedAt?: string;
  deletedAt?: string;
}

interface MediaAssetRow {
  id: string;
  room_id: string;
  owner_actor_id: string;
  media_kind: MediaKind;
  original_filename: string;
  declared_media_type: string;
  detected_media_type: string | null;
  byte_length: string;
  sha256: string | null;
  storage_object_key: string;
  lifecycle_state: MediaAsset["lifecycleState"];
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  deleted_at: Date | null;
}

const columns = `
  id, room_id, owner_actor_id, media_kind, original_filename,
  declared_media_type, detected_media_type, byte_length::text, sha256,
  storage_object_key, lifecycle_state, created_at, updated_at,
  published_at, deleted_at
`;

const fromRow = (row: MediaAssetRow): MediaAsset => ({
  contractVersion: 1,
  entityType: "media_asset",
  mediaAssetId: row.id,
  roomId: row.room_id,
  ownerActorId: row.owner_actor_id,
  mediaKind: row.media_kind,
  originalFilename: row.original_filename,
  declaredMediaType: row.declared_media_type,
  ...(row.detected_media_type === null
    ? {}
    : { detectedMediaType: row.detected_media_type }),
  byteLength: String(row.byte_length),
  ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
  lifecycleState: row.lifecycle_state,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  ...(row.published_at === null
    ? {}
    : { publishedAt: row.published_at.toISOString() }),
  ...(row.deleted_at === null
    ? {}
    : { deletedAt: row.deleted_at.toISOString() }),
});

const streamBytes = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

export class MediaObjectStorage {
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private initialized: Promise<void> | null = null;

  public constructor(config: AppConfig["objectStorage"]) {
    const endpoint = new URL(config.endpoint);
    this.bucket = config.bucket;
    this.client = new Minio.Client({
      endPoint: endpoint.hostname,
      port: endpoint.port === ""
        ? endpoint.protocol === "https:"
          ? 443
          : 80
        : Number(endpoint.port),
      useSSL: endpoint.protocol === "https:",
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
  }

  private ready(): Promise<void> {
    this.initialized ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) {
        await this.client.makeBucket(this.bucket);
      }
    })();

    return this.initialized;
  }

  public async put(
    objectKey: string,
    data: Buffer,
    mediaType: string,
  ): Promise<void> {
    await this.ready();
    await this.client.putObject(this.bucket, objectKey, data, data.length, {
      "Content-Type": mediaType,
    });
  }

  public async get(objectKey: string): Promise<Buffer> {
    await this.ready();
    return streamBytes(await this.client.getObject(this.bucket, objectKey));
  }

  public async remove(objectKey: string): Promise<void> {
    await this.ready();
    await this.client.removeObject(this.bucket, objectKey);
  }
}

export interface MediaRepository {
  createPublished(input: {
    roomId: string;
    ownerActorId: string;
    mediaKind: MediaKind;
    originalFilename: string;
    declaredMediaType: string;
    detectedMediaType: string;
    data: Buffer;
  }): Promise<MediaAsset>;
  get(roomId: string, mediaAssetId: string): Promise<MediaAsset | null>;
  data(roomId: string, mediaAssetId: string): Promise<{
    asset: MediaAsset;
    data: Buffer;
  } | null>;
}

export class PostgresMediaRepository implements MediaRepository {
  public constructor(
    private readonly database: Pool,
    private readonly storage: MediaObjectStorage,
  ) {}

  public async createPublished(input: {
    roomId: string;
    ownerActorId: string;
    mediaKind: MediaKind;
    originalFilename: string;
    declaredMediaType: string;
    detectedMediaType: string;
    data: Buffer;
  }): Promise<MediaAsset> {
    const room = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM rooms WHERE id = $1) AS exists",
      [input.roomId],
    );

    if (!room.rows[0]?.exists) {
      throw notFound(
        "room_not_found",
        `Room '${input.roomId}' does not exist`,
      );
    }

    const actor = await this.database.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1 FROM actors WHERE id = $1 AND retired_at IS NULL
        ) AS exists
      `,
      [input.ownerActorId],
    );

    if (!actor.rows[0]?.exists) {
      throw notFound(
        "actor_not_found",
        `Actor '${input.ownerActorId}' does not exist or is retired`,
      );
    }

    const mediaAssetId = randomUUID();
    const objectKey = `${input.roomId}/${mediaAssetId}`;
    const sha256 = createHash("sha256").update(input.data).digest("hex");

    await this.storage.put(objectKey, input.data, input.detectedMediaType);

    try {
      const result = await this.database.query<MediaAssetRow>(
        `
          INSERT INTO media_assets (
            id, room_id, owner_actor_id, media_kind, original_filename,
            declared_media_type, detected_media_type, byte_length, sha256,
            storage_object_key, lifecycle_state, published_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'published', now())
          RETURNING ${columns}
        `,
        [
          mediaAssetId,
          input.roomId,
          input.ownerActorId,
          input.mediaKind,
          input.originalFilename,
          input.declaredMediaType,
          input.detectedMediaType,
          input.data.length,
          sha256,
          objectKey,
        ],
      );

      return fromRow(result.rows[0]!);
    } catch (error) {
      await this.storage.remove(objectKey).catch(() => undefined);
      throw error;
    }
  }

  public async get(
    roomId: string,
    mediaAssetId: string,
  ): Promise<MediaAsset | null> {
    const result = await this.database.query<MediaAssetRow>(
      `SELECT ${columns} FROM media_assets WHERE room_id = $1 AND id = $2`,
      [roomId, mediaAssetId],
    );

    return result.rows[0] === undefined ? null : fromRow(result.rows[0]);
  }

  public async data(
    roomId: string,
    mediaAssetId: string,
  ): Promise<{ asset: MediaAsset; data: Buffer } | null> {
    const result = await this.database.query<MediaAssetRow>(
      `
        SELECT ${columns}
        FROM media_assets
        WHERE room_id = $1 AND id = $2 AND lifecycle_state = 'published'
      `,
      [roomId, mediaAssetId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      asset: fromRow(row),
      data: await this.storage.get(row.storage_object_key),
    };
  }
}
