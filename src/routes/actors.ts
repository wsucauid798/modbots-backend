import type { FastifyPluginAsync } from "fastify";
import type { ActorRepository } from "../repositories/actors.js";

interface ActorParams {
  actorId: string;
}

export const actorRoutes = (actors: ActorRepository): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.get<{ Params: ActorParams }>(
      "/api/actors/:actorId",
      async (request, reply) => {
        const actor = await actors.getById(request.params.actorId);

        if (actor === null) {
          return reply.code(404).send({
            error: "actor_not_found",
            message: `Actor '${request.params.actorId}' does not exist`,
          });
        }

        return actor;
      },
    );
  };
};
