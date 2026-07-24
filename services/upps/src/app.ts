import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { UppsConfig } from "./config.js";
import {
  createUserProfilePicture,
  profilePictureById,
  removeUserProfilePicture,
} from "./profile-pictures.js";

const maximumProfilePictureBytes = 5 * 1024 * 1024;

const authorized = (
  authorization: string | undefined,
  serviceToken: string,
): boolean => {
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(serviceToken);

  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
};

const decodeProfilePicture = (raw: unknown): Buffer | null => {
  if (
    typeof raw !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(raw) ||
    raw.length % 4 !== 0
  ) {
    return null;
  }

  const data = Buffer.from(raw, "base64");
  return data.length > 0 && data.length <= maximumProfilePictureBytes
    ? data
    : null;
};

export const buildApp = (config: UppsConfig) => {
  const app = fastify({ logger: true });
  const profilePictureDirectory = path.join(
    config.publicDir,
    "profile-pictures",
  );

  mkdirSync(profilePictureDirectory, { recursive: true });

  void app.register(fastifyStatic, {
    root: profilePictureDirectory,
    prefix: "/profile-picture-files/",
  });

  app.get<{ Params: { profilePictureId: string } }>(
    "/profile-pictures/:profilePictureId",
    async (request, reply) => {
      const profilePicture = await profilePictureById(
        request.params.profilePictureId,
        config.publicDir,
      );

      if (profilePicture === null) {
        return reply.code(404).send({
          error: "profile_picture_not_found",
          message: `Profile picture '${request.params.profilePictureId}' does not exist`,
        });
      }

      return reply
        .header(
          "cache-control",
          profilePicture.source === "user"
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400",
        )
        .type(profilePicture.contentType)
        .sendFile(profilePicture.file);
    },
  );

  app.post<{ Body: { data?: unknown } }>(
    "/internal/profile-pictures",
    { bodyLimit: 7 * 1024 * 1024 },
    async (request, reply) => {
      if (!authorized(request.headers.authorization, config.serviceToken)) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "A valid UPPS service token is required",
        });
      }

      const data = decodeProfilePicture(request.body?.data);

      if (data === null) {
        return reply.code(400).send({
          error: "invalid_profile_picture",
          message: "Profile pictures must contain 1 byte to 5 MB of base64 data",
        });
      }

      try {
        const profilePicture = await createUserProfilePicture(
          config.publicDir,
          data,
        );

        return reply.code(201).send({
          profilePictureId: profilePicture.id,
          contentType: profilePicture.contentType,
          byteLength: data.length,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "unsupported_profile_picture_type"
        ) {
          return reply.code(400).send({
            error: "invalid_profile_picture",
            message: "Profile pictures must be PNG, JPEG, or WebP",
          });
        }

        throw error;
      }
    },
  );

  app.delete<{ Params: { profilePictureId: string } }>(
    "/internal/profile-pictures/:profilePictureId",
    async (request, reply) => {
      if (!authorized(request.headers.authorization, config.serviceToken)) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "A valid UPPS service token is required",
        });
      }

      const removed = await removeUserProfilePicture(
        request.params.profilePictureId,
        config.publicDir,
      );

      return removed ? reply.code(204).send() : reply.code(404).send({
        error: "profile_picture_not_found",
        message: `Profile picture '${request.params.profilePictureId}' does not exist`,
      });
    },
  );

  app.get("/health", async () => ({
    status: "ok",
    service: "modbots-upps",
    storage: "local-filesystem",
  }));

  app.get("/", async () => ({
    service: "modbots-upps",
    name: "Unified Profile-Picture System",
    endpoints: ["/health", "/profile-pictures/:profilePictureId"],
  }));

  return app;
};
