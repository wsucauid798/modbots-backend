import fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import type { UppsConfig } from "./config.js";
import { profilePictureById } from "./profile-pictures.js";

export const buildApp = (config: UppsConfig) => {
  const app = fastify({ logger: true });

  void app.register(fastifyStatic, {
    root: path.join(config.publicDir, "profile-pictures"),
    prefix: "/profile-picture-files/",
  });

  app.get<{ Params: { profilePictureId: string } }>(
    "/profile-pictures/:profilePictureId",
    async (request, reply) => {
      const profilePicture = profilePictureById(
        request.params.profilePictureId,
      );

      if (profilePicture === null) {
        return reply.code(404).send({
          error: "profile_picture_not_found",
          message: `Profile picture '${request.params.profilePictureId}' does not exist`,
        });
      }

      return reply.type(profilePicture.contentType).sendFile(profilePicture.file);
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
