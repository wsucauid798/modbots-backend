import type { FastifyPluginAsync } from "fastify";
import { badRequest, unauthorized } from "../domain/errors.js";
import { bearerToken } from "../domain/sessions.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { SessionRepository } from "../repositories/sessions.js";

export const sessionRoutes = (
  sessions: SessionRepository,
  actors: ActorRepository,
  accountUrl: string,
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

    // The browser sign-in hand-off: a client that completed the account
    // site's OIDC flow presents the access token it received; the backend
    // validates it at the issuer and exchanges it for a platform session.
    app.post<{ Body: unknown }>(
      "/api/sessions/exchange",
      async (request, reply) => {
        const body = request.body;

        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw badRequest("invalid_body", "Request body must be a JSON object");
        }

        const { accessToken } = body as Record<string, unknown>;

        if (typeof accessToken !== "string" || accessToken.length === 0) {
          throw badRequest("invalid_body", "'accessToken' must be a string");
        }

        let subject: string | null = null;

        try {
          const userinfo = await fetch(new URL("/oidc/me", accountUrl), {
            headers: { authorization: `Bearer ${accessToken}` },
          });

          if (userinfo.ok) {
            const claims = (await userinfo.json()) as { sub?: unknown };
            subject = typeof claims.sub === "string" ? claims.sub : null;
          }
        } catch {
          subject = null;
        }

        if (subject === null) {
          throw unauthorized(
            "invalid_token",
            "The access token does not resolve at the account service",
          );
        }

        const actor = await actors.getById(subject);

        if (
          actor === null ||
          actor.type !== "human" ||
          actor.retiredAt !== null
        ) {
          throw unauthorized(
            "invalid_token",
            "The access token does not belong to an active human actor",
          );
        }

        const session = await sessions.issue(actor.id);

        return reply.code(201).send({ actor, session });
      },
    );
  };
};
