import type { FastifyPluginAsync } from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import { badRequest } from "../domain/errors.js";
import type { GameHandler } from "../domain/games.js";

const bodyRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_body", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
};

const actorIdFrom = (value: unknown): string => {
  const actorId = bodyRecord(value).actorId;
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw badRequest("invalid_body", "'actorId' must be a non-empty string");
  }
  return actorId;
};

export const gameRoutes = (games: GameHandler, auth: WriteAuthorizer): FastifyPluginAsync =>
  async (app): Promise<void> => {
    app.get<{ Params: { roomId: string } }>("/api/rooms/:roomId/games", async (request) => ({
      sessions: await games.list(request.params.roomId),
    }));

    app.post<{ Params: { roomId: string }; Body: unknown }>("/api/rooms/:roomId/games/tic-tac-toe", async (request) => {
      const actorId = actorIdFrom(request.body);
      await auth.authorizeActor(request.headers.authorization, actorId);
      return { session: await games.create(request.params.roomId, actorId) };
    });

    const actorAction = (action: (roomId: string, gameId: string, actorId: string) => Promise<unknown>) =>
      async (request: { params: { roomId: string; gameId: string }; body: unknown; headers: { authorization?: string } }) => {
        const actorId = actorIdFrom(request.body);
        await auth.authorizeActor(request.headers.authorization, actorId);
        return { session: await action(request.params.roomId, request.params.gameId, actorId) };
      };

    app.post<{ Params: { roomId: string; gameId: string }; Body: unknown }>("/api/rooms/:roomId/games/:gameId/join", actorAction(games.join.bind(games)));
    app.post<{ Params: { roomId: string; gameId: string }; Body: unknown }>("/api/rooms/:roomId/games/:gameId/watch", actorAction(games.watch.bind(games)));
    app.post<{ Params: { roomId: string; gameId: string }; Body: unknown }>("/api/rooms/:roomId/games/:gameId/leave", actorAction(games.leave.bind(games)));
    app.post<{ Params: { roomId: string; gameId: string }; Body: unknown }>("/api/rooms/:roomId/games/:gameId/rematch", actorAction(games.requestRematch.bind(games)));

    app.post<{ Params: { roomId: string; gameId: string }; Body: unknown }>("/api/rooms/:roomId/games/:gameId/moves", async (request) => {
      const body = bodyRecord(request.body);
      const actorId = actorIdFrom(body);
      const cell = body.cell;
      if (!Number.isSafeInteger(cell) || (cell as number) < 0 || (cell as number) > 8) {
        throw badRequest("invalid_cell", "'cell' must be an integer from 0 to 8");
      }
      await auth.authorizeActor(request.headers.authorization, actorId);
      return { session: await games.move(request.params.roomId, request.params.gameId, actorId, cell as number) };
    });
  };
