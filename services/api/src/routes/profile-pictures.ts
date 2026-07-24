import type { FastifyPluginAsync } from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import type { CommandHandler } from "../domain/commands.js";
import { badRequest, forbidden, notFound } from "../domain/errors.js";
import type { ActorRepository } from "../repositories/actors.js";
import {
  type ProfilePictureStore,
  ProfilePictureStoreError,
} from "../repositories/profile-pictures.js";

interface ActorParams {
  actorId: string;
}

interface UploadBody {
  data?: unknown;
}

const userPictureId = /^user-/;

export const profilePictureRoutes = (
  actors: ActorRepository,
  auth: WriteAuthorizer,
  commands: CommandHandler,
  profilePictures: ProfilePictureStore,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post<{ Params: ActorParams; Body: UploadBody }>(
      "/api/actors/:actorId/profile-picture",
      { bodyLimit: 7 * 1024 * 1024 },
      async (request, reply) => {
        const actorId = request.params.actorId;
        await auth.authorizeActor(request.headers.authorization, actorId);
        const previousActor = await actors.getById(actorId);

        if (previousActor === null) {
          throw notFound("actor_not_found", `Actor '${actorId}' does not exist`);
        }

        if (previousActor.type !== "human") {
          throw forbidden(
            "profile_picture_not_allowed",
            "Only people can manage personal profile pictures",
          );
        }

        if (typeof request.body?.data !== "string") {
          throw badRequest(
            "invalid_profile_picture",
            "'data' must be a base64 string",
          );
        }

        let uploaded;

        try {
          uploaded = await profilePictures.upload(request.body.data);
        } catch (error) {
          if (
            error instanceof ProfilePictureStoreError &&
            error.statusCode === 400
          ) {
            throw badRequest("invalid_profile_picture", error.message);
          }

          throw error;
        }

        let updatedActor;

        try {
          updatedActor = await commands.updateActorProfilePicture({
            actorId,
            profilePictureId: uploaded.profilePictureId,
          });
        } catch (error) {
          await profilePictures
            .remove(uploaded.profilePictureId)
            .catch((cleanupError) =>
              app.log.error(
                cleanupError,
                "Failed to remove an unassigned UPPS profile picture",
              ),
            );
          throw error;
        }

        if (
          previousActor.profilePictureId !== null &&
          userPictureId.test(previousActor.profilePictureId)
        ) {
          await profilePictures
            .remove(previousActor.profilePictureId)
            .catch((error) =>
              app.log.error(
                error,
                "Failed to remove a replaced UPPS profile picture",
              ),
            );
        }

        return reply.code(200).send(updatedActor);
      },
    );

    app.delete<{ Params: ActorParams }>(
      "/api/actors/:actorId/profile-picture",
      async (request, reply) => {
        const actorId = request.params.actorId;
        await auth.authorizeActor(request.headers.authorization, actorId);
        const previousActor = await actors.getById(actorId);

        if (previousActor === null) {
          throw notFound("actor_not_found", `Actor '${actorId}' does not exist`);
        }

        if (previousActor.type !== "human") {
          throw forbidden(
            "profile_picture_not_allowed",
            "Only people can manage personal profile pictures",
          );
        }

        const updatedActor = await commands.updateActorProfilePicture({
          actorId,
          profilePictureId: null,
        });

        if (
          previousActor.profilePictureId !== null &&
          userPictureId.test(previousActor.profilePictureId)
        ) {
          await profilePictures
            .remove(previousActor.profilePictureId)
            .catch((error) =>
              app.log.error(
                error,
                "Failed to remove a cleared UPPS profile picture",
              ),
            );
        }

        return reply.code(200).send(updatedActor);
      },
    );
  };
};
