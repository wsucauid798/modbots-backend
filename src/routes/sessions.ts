import type { FastifyPluginAsync } from "fastify";
import { unauthorized } from "../domain/errors.js";
import { bearerToken } from "../domain/sessions.js";
import type { SessionRepository } from "../repositories/sessions.js";

export const sessionRoutes = (
  sessions: SessionRepository,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post("/api/sessions/revoke", async (request, reply) => {
      const token = bearerToken(request.headers.authorization);

      if (token === null || !(await sessions.revoke(token))) {
        throw unauthorized(
          "invalid_session",
          "The bearer token does not resolve to a live session",
        );
      }

      return reply.code(204).send();
    });
  };
};
