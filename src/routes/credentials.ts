import type { FastifyPluginAsync } from "fastify";
import {
  verifyAgainstFallback,
  verifyPassword,
} from "../domain/credentials.js";
import { badRequest } from "../domain/errors.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { CredentialRepository } from "../repositories/credentials.js";

// Verifies a username and password pair for the account surface. The
// response never distinguishes an unknown username from a wrong password,
// and both paths cost one argon2 verification.
export const credentialRoutes = (
  actors: ActorRepository,
  credentials: CredentialRepository,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post<{ Body: unknown }>(
      "/api/credentials/verify",
      async (request, reply) => {
        const body = request.body;

        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw badRequest("invalid_body", "Request body must be a JSON object");
        }

        const { username, password } = body as Record<string, unknown>;

        if (typeof username !== "string" || username.trim().length === 0) {
          throw badRequest("invalid_body", "'username' must be a string");
        }

        if (typeof password !== "string" || password.length === 0) {
          throw badRequest("invalid_body", "'password' must be a string");
        }

        const unauthorized = () =>
          reply.code(401).send({
            error: "invalid_credentials",
            message: "Username or password is incorrect",
          });

        const actor = await actors.getByHandle(username.trim());

        if (
          actor === null ||
          actor.type !== "human" ||
          actor.retiredAt !== null
        ) {
          await verifyAgainstFallback(password);
          return unauthorized();
        }

        const hash = await credentials.passwordHashFor(actor.id);

        if (hash === null) {
          await verifyAgainstFallback(password);
          return unauthorized();
        }

        if (!(await verifyPassword(hash, password))) {
          return unauthorized();
        }

        return { actor };
      },
    );
  };
};
