import type { FastifyPluginAsync } from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import { badRequest } from "../domain/errors.js";
import type {
  MediaKind,
  MediaRepository,
} from "../repositories/media.js";

interface RoomParams {
  roomId: string;
}

interface MediaParams extends RoomParams {
  mediaAssetId: string;
}

interface UploadBody {
  actorId?: unknown;
  mediaKind?: unknown;
  originalFilename?: unknown;
  declaredMediaType?: unknown;
  data?: unknown;
}

const maximumMediaBytes = 100 * 1024 * 1024;
const mediaKinds = new Set<MediaKind>(["image", "audio", "video", "file"]);

const string = (value: unknown, label: string, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw badRequest(
      "invalid_media_upload",
      `'${label}' must be a non-empty string of at most ${maximum} characters`,
    );
  }

  return value;
};

const mediaTypeFor = (data: Buffer, declared: string): string => {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }

  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }

  if (data.subarray(0, 4).toString("ascii") === "RIFF") {
    return data.subarray(8, 12).toString("ascii") === "WAVE"
      ? "audio/wav"
      : declared;
  }

  if (data.subarray(4, 8).toString("ascii") === "ftyp") {
    return "video/mp4";
  }

  if (data.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"))) {
    return "video/webm";
  }

  if (data.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }

  return declared;
};

const decode = (raw: unknown): Buffer => {
  if (typeof raw !== "string") {
    throw badRequest("invalid_media_upload", "'data' must be base64");
  }

  const encoded = raw.startsWith("data:")
    ? raw.slice(raw.indexOf(",") + 1)
    : raw;

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw badRequest("invalid_media_upload", "'data' must be valid base64");
  }

  const data = Buffer.from(encoded, "base64");

  if (data.length === 0 || data.length > maximumMediaBytes) {
    throw badRequest(
      "invalid_media_upload",
      `'data' must contain 1 to ${maximumMediaBytes} decoded bytes`,
    );
  }

  return data;
};

export const mediaRoutes = (
  media: MediaRepository,
  auth: WriteAuthorizer,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post<{ Params: RoomParams; Body: UploadBody }>(
      "/api/rooms/:roomId/media-assets",
      { bodyLimit: 140 * 1024 * 1024 },
      async (request, reply) => {
        const actorId = string(request.body.actorId, "actorId", 64);
        const mediaKind = string(request.body.mediaKind, "mediaKind", 16);

        if (!mediaKinds.has(mediaKind as MediaKind)) {
          throw badRequest(
            "invalid_media_upload",
            "'mediaKind' must be image, audio, video, or file",
          );
        }

        await auth.authorizeActor(request.headers.authorization, actorId);
        const data = decode(request.body.data);
        const declaredMediaType = string(
          request.body.declaredMediaType,
          "declaredMediaType",
          255,
        );
        const detectedMediaType = mediaTypeFor(data, declaredMediaType);

        if (
          mediaKind !== "file" &&
          !detectedMediaType.startsWith(`${mediaKind}/`)
        ) {
          throw badRequest(
            "media_kind_mismatch",
            `The uploaded data is ${detectedMediaType}, not ${mediaKind}`,
          );
        }

        const asset = await media.createPublished({
          roomId: request.params.roomId,
          ownerActorId: actorId,
          mediaKind: mediaKind as MediaKind,
          originalFilename: string(
            request.body.originalFilename,
            "originalFilename",
            1_024,
          ),
          declaredMediaType,
          detectedMediaType,
          data,
        });

        return reply.code(201).send(asset);
      },
    );

    app.get<{ Params: MediaParams }>(
      "/api/rooms/:roomId/media-assets/:mediaAssetId",
      async (request, reply) => {
        const asset = await media.get(
          request.params.roomId,
          request.params.mediaAssetId,
        );

        if (asset === null) {
          return reply.code(404).send({
            error: "media_asset_not_found",
            message: `Media asset '${request.params.mediaAssetId}' does not exist in this room`,
          });
        }

        return asset;
      },
    );

    app.get<{ Params: MediaParams }>(
      "/api/rooms/:roomId/media-assets/:mediaAssetId/data",
      async (request, reply) => {
        const result = await media.data(
          request.params.roomId,
          request.params.mediaAssetId,
        );

        if (result === null) {
          return reply.code(404).send({
            error: "media_asset_not_found",
            message: `Published media asset '${request.params.mediaAssetId}' does not exist in this room`,
          });
        }

        const range = request.headers.range;

        if (range !== undefined) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);

          if (match === null) {
            return reply
              .code(416)
              .header("content-range", `bytes */${result.data.length}`)
              .send();
          }

          const start = Number(match[1]);
          const requestedEnd = match[2] === "" ? result.data.length - 1 : Number(match[2]);
          const end = Math.min(requestedEnd, result.data.length - 1);

          if (!Number.isSafeInteger(start) || start < 0 || start > end) {
            return reply
              .code(416)
              .header("content-range", `bytes */${result.data.length}`)
              .send();
          }

          const chunk = result.data.subarray(start, end + 1);

          return reply
            .code(206)
            .header("accept-ranges", "bytes")
            .header("content-range", `bytes ${start}-${end}/${result.data.length}`)
            .header("content-type", result.asset.detectedMediaType ?? "application/octet-stream")
            .header("content-length", chunk.length)
            .send(chunk);
        }

        return reply
          .header("accept-ranges", "bytes")
          .header("content-type", result.asset.detectedMediaType ?? "application/octet-stream")
          .header("content-length", result.data.length)
          .send(result.data);
      },
    );
  };
};
