import type { AuthMode } from "../config.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { SessionRepository } from "../repositories/sessions.js";
import { forbidden, unauthorized } from "./errors.js";
import { bearerToken } from "./sessions.js";

export interface WriteAuthorizer {
  authorizeActor(
    authorization: string | undefined,
    actorId: string,
  ): Promise<void>;
}

// Binds write commands to sessions. A presented bearer token must resolve to
// a live session, and that session's actor must be the acting actor, so a
// token can never act as someone else. Without a token, 'optional' mode lets
// the request through unchanged, while 'required' mode refuses human actors.
// Bots remain exempt until service credentials exist; that is a later B014
// slice.
export class SessionWriteAuthorizer implements WriteAuthorizer {
  public constructor(
    private readonly sessions: SessionRepository,
    private readonly actors: ActorRepository,
    private readonly mode: AuthMode,
  ) {}

  public async authorizeActor(
    authorization: string | undefined,
    actorId: string,
  ): Promise<void> {
    const token = bearerToken(authorization);

    if (token !== null) {
      const session = await this.sessions.resolve(token);

      if (session === null) {
        throw unauthorized(
          "invalid_session",
          "The bearer token does not resolve to a live session",
        );
      }

      if (session.actorId !== actorId) {
        throw forbidden(
          "session_actor_mismatch",
          "The session actor does not match the acting actor",
        );
      }

      return;
    }

    if (this.mode === "required") {
      const actor = await this.actors.getById(actorId);

      if (actor !== null && actor.type === "human") {
        throw unauthorized(
          "session_required",
          "Human actors must present a session token on write requests",
        );
      }
    }
  }
}
