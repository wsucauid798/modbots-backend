import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../database.js";
import { appendRoomEvent } from "../events/room-events.js";
import type { ActorStatusMode } from "../repositories/actors.js";
import { conflict, notFound } from "./errors.js";
import {
  emptyTicTacToeBoard,
  playTicTacToeMove,
  type TicTacToeBoard,
  type TicTacToeMark,
} from "./tic-tac-toe.js";

export type GameState = "waiting" | "active" | "won" | "draw" | "cancelled";

export interface GameSession {
  id: string;
  roomId: string;
  gameType: "tic_tac_toe";
  state: GameState;
  playerXActorId: string;
  playerOActorId: string | null;
  board: TicTacToeBoard;
  nextMark: TicTacToeMark | null;
  winnerActorId: string | null;
  winningLine: number[] | null;
  spectatorActorIds: string[];
  rematchRequestedBy: string[];
  rematchOfSessionId: string | null;
  rematchSessionId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface GameRow {
  id: string;
  room_id: string;
  game_type: "tic_tac_toe";
  state: GameState;
  player_x_actor_id: string;
  player_o_actor_id: string | null;
  board: TicTacToeBoard;
  next_mark: TicTacToeMark | null;
  winner_actor_id: string | null;
  winning_line: number[] | null;
  spectator_actor_ids: string[];
  rematch_requested_by: string[];
  rematch_of_session_id: string | null;
  rematch_session_id: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface GameHandler {
  list(roomId: string): Promise<GameSession[]>;
  create(roomId: string, actorId: string): Promise<GameSession>;
  join(roomId: string, sessionId: string, actorId: string): Promise<GameSession>;
  watch(roomId: string, sessionId: string, actorId: string): Promise<GameSession>;
  move(roomId: string, sessionId: string, actorId: string, cell: number): Promise<GameSession>;
  leave(roomId: string, sessionId: string, actorId: string): Promise<GameSession>;
  requestRematch(roomId: string, sessionId: string, actorId: string): Promise<GameSession>;
}

const gameColumns = `
  game_sessions.*,
  COALESCE((SELECT array_agg(actor_id ORDER BY joined_at) FROM game_spectators WHERE session_id = game_sessions.id), '{}') AS spectator_actor_ids,
  COALESCE((SELECT array_agg(actor_id ORDER BY created_at) FROM game_rematch_votes WHERE session_id = game_sessions.id), '{}') AS rematch_requested_by
`;

const gameFromRow = (row: GameRow): GameSession => ({
  id: row.id,
  roomId: row.room_id,
  gameType: row.game_type,
  state: row.state,
  playerXActorId: row.player_x_actor_id,
  playerOActorId: row.player_o_actor_id,
  board: row.board,
  nextMark: row.next_mark,
  winnerActorId: row.winner_actor_id,
  winningLine: row.winning_line,
  spectatorActorIds: row.spectator_actor_ids,
  rematchRequestedBy: row.rematch_requested_by,
  rematchOfSessionId: row.rematch_of_session_id,
  rematchSessionId: row.rematch_session_id,
  revision: row.revision,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null,
});

const requireGamesRoom = async (client: PoolClient, roomId: string): Promise<void> => {
  const result = await client.query<{ capabilities: string[] }>(
    "SELECT capabilities FROM rooms WHERE id = $1",
    [roomId],
  );
  if (result.rows[0] === undefined) {
    throw notFound("room_not_found", `Room '${roomId}' does not exist`);
  }
  if (!result.rows[0].capabilities.includes("games")) {
    throw conflict("games_not_available", "Games are not available in this room");
  }
};

const requireAvailableActor = async (client: PoolClient, roomId: string, actorId: string): Promise<void> => {
  const actor = await client.query<{ retired_at: Date | null }>(
    "SELECT retired_at FROM actors WHERE id = $1 FOR UPDATE",
    [actorId],
  );
  if (actor.rows[0] === undefined) {
    throw notFound("actor_not_found", `Actor '${actorId}' does not exist`);
  }
  if (actor.rows[0].retired_at !== null) {
    throw conflict("actor_retired", "A retired actor cannot play games");
  }
  const presence = await client.query<{ event_type: string }>(
    `SELECT event_type FROM room_events WHERE room_id = $1 AND actor_id = $2
     AND event_type IN ('actor_joined', 'actor_left') ORDER BY sequence DESC LIMIT 1`,
    [roomId, actorId],
  );
  if (presence.rows[0]?.event_type !== "actor_joined") {
    throw conflict("actor_not_in_room", `Actor '${actorId}' must join the room first`);
  }
};

const requireNoCurrentGame = async (client: PoolClient, actorId: string): Promise<void> => {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM game_participant_statuses gps
      JOIN game_sessions gs ON gs.id = gps.session_id
      WHERE gps.actor_id = $1 AND gs.state IN ('waiting', 'active')
    ) AS exists`,
    [actorId],
  );
  if (result.rows[0]?.exists) {
    throw conflict("actor_already_in_game", "You must leave your current game first");
  }
};

const loadGame = async (client: PoolClient, roomId: string, sessionId: string, lock = false): Promise<GameSession> => {
  if (lock) {
    const locked = await client.query("SELECT id FROM game_sessions WHERE id = $1 AND room_id = $2 FOR UPDATE", [sessionId, roomId]);
    if (locked.rows[0] === undefined) {
      throw notFound("game_not_found", "That game does not exist in this room");
    }
  }
  const result = await client.query<GameRow>(
    `SELECT ${gameColumns} FROM game_sessions WHERE game_sessions.id = $1 AND game_sessions.room_id = $2`,
    [sessionId, roomId],
  );
  if (result.rows[0] === undefined) {
    throw notFound("game_not_found", "That game does not exist in this room");
  }
  return gameFromRow(result.rows[0]);
};

const rememberAndSetStatus = async (
  client: PoolClient,
  sessionId: string,
  roomId: string,
  actorId: string,
  role: "player" | "spectator",
  text: string,
): Promise<void> => {
  const actor = await client.query<{ profile_status_mode: ActorStatusMode | null; profile_status_text: string | null }>(
    "SELECT profile_status_mode, profile_status_text FROM actors WHERE id = $1 FOR UPDATE",
    [actorId],
  );
  await client.query(
    `INSERT INTO game_participant_statuses (session_id, actor_id, previous_mode, previous_text, participation_role)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (session_id, actor_id) DO NOTHING`,
    [sessionId, actorId, actor.rows[0]?.profile_status_mode ?? null, actor.rows[0]?.profile_status_text ?? null, role],
  );
  await client.query("UPDATE actors SET profile_status_mode = 'game', profile_status_text = $2 WHERE id = $1", [actorId, text]);
  await appendRoomEvent(client, { roomId, type: "actor_status_changed", actorId, payload: { actorId, statusMode: "game", statusText: text } });
};

const restoreStatuses = async (client: PoolClient, sessionId: string, roomId: string, onlyActorId?: string): Promise<void> => {
  const statuses = await client.query<{ actor_id: string; previous_mode: ActorStatusMode | null; previous_text: string | null }>(
    `DELETE FROM game_participant_statuses WHERE session_id = $1 ${onlyActorId === undefined ? "" : "AND actor_id = $2"}
     RETURNING actor_id, previous_mode, previous_text`,
    onlyActorId === undefined ? [sessionId] : [sessionId, onlyActorId],
  );
  for (const status of statuses.rows) {
    await client.query("UPDATE actors SET profile_status_mode = $2, profile_status_text = $3 WHERE id = $1", [status.actor_id, status.previous_mode, status.previous_text]);
    await appendRoomEvent(client, { roomId, type: "actor_status_changed", actorId: status.actor_id, payload: { actorId: status.actor_id, statusMode: status.previous_mode, statusText: status.previous_text } });
  }
};

const emitGame = async (client: PoolClient, roomId: string, type: string, actorId: string, session: GameSession): Promise<void> => {
  await appendRoomEvent(client, { roomId, type, actorId, payload: { session } });
};

export class GameService implements GameHandler {
  public constructor(private readonly database: Pool) {}

  public async list(roomId: string): Promise<GameSession[]> {
    const result = await this.database.query<GameRow>(
      `SELECT ${gameColumns} FROM game_sessions
       WHERE room_id = $1 AND (state IN ('waiting', 'active') OR updated_at > now() - interval '24 hours')
       ORDER BY CASE WHEN state IN ('waiting', 'active') THEN 0 ELSE 1 END, updated_at DESC LIMIT 50`,
      [roomId],
    );
    return result.rows.map(gameFromRow);
  }

  public async create(roomId: string, actorId: string): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      await requireGamesRoom(client, roomId);
      await requireAvailableActor(client, roomId, actorId);
      await requireNoCurrentGame(client, actorId);
      const id = randomUUID();
      await client.query(
        `INSERT INTO game_sessions (id, room_id, game_type, state, player_x_actor_id, board)
         VALUES ($1, $2, 'tic_tac_toe', 'waiting', $3, $4)`,
        [id, roomId, actorId, JSON.stringify(emptyTicTacToeBoard())],
      );
      await rememberAndSetStatus(client, id, roomId, actorId, "player", "Waiting to play Tic-tac-toe");
      const session = await loadGame(client, roomId, id);
      await emitGame(client, roomId, "game_created", actorId, session);
      return session;
    });
  }

  public async join(roomId: string, sessionId: string, actorId: string): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      await requireAvailableActor(client, roomId, actorId);
      const game = await loadGame(client, roomId, sessionId, true);
      if (game.state !== "waiting" || game.playerOActorId !== null) {
        throw conflict("game_not_joinable", "That game is no longer waiting for a player");
      }
      if (game.playerXActorId === actorId) {
        throw conflict("cannot_join_own_game", "You are already in this game");
      }
      await requireNoCurrentGame(client, actorId);
      await client.query(
        `UPDATE game_sessions SET player_o_actor_id = $3, state = 'active', next_mark = 'X', revision = revision + 1, updated_at = now()
         WHERE id = $1 AND room_id = $2`,
        [sessionId, roomId, actorId],
      );
      await rememberAndSetStatus(client, sessionId, roomId, actorId, "player", "Playing Tic-tac-toe");
      await client.query("UPDATE actors SET profile_status_mode = 'game', profile_status_text = 'Playing Tic-tac-toe' WHERE id = $1", [game.playerXActorId]);
      await appendRoomEvent(client, { roomId, type: "actor_status_changed", actorId: game.playerXActorId, payload: { actorId: game.playerXActorId, statusMode: "game", statusText: "Playing Tic-tac-toe" } });
      const session = await loadGame(client, roomId, sessionId);
      await emitGame(client, roomId, "game_started", actorId, session);
      return session;
    });
  }

  public async watch(roomId: string, sessionId: string, actorId: string): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      await requireAvailableActor(client, roomId, actorId);
      const game = await loadGame(client, roomId, sessionId, true);
      if (!(["waiting", "active"] as GameState[]).includes(game.state)) {
        throw conflict("game_not_watchable", "That game has ended");
      }
      if (game.playerXActorId === actorId || game.playerOActorId === actorId) {
        return game;
      }
      if (!game.spectatorActorIds.includes(actorId)) {
        await requireNoCurrentGame(client, actorId);
        await client.query("INSERT INTO game_spectators (session_id, actor_id) VALUES ($1, $2)", [sessionId, actorId]);
        await rememberAndSetStatus(client, sessionId, roomId, actorId, "spectator", "Watching Tic-tac-toe");
      }
      const session = await loadGame(client, roomId, sessionId);
      await emitGame(client, roomId, "game_spectator_joined", actorId, session);
      return session;
    });
  }

  public async move(roomId: string, sessionId: string, actorId: string, cell: number): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      const game = await loadGame(client, roomId, sessionId, true);
      if (game.state !== "active") {
        throw conflict("game_not_active", "That game is not active");
      }
      const mark = game.playerXActorId === actorId ? "X" : game.playerOActorId === actorId ? "O" : null;
      if (mark === null) {
        throw conflict("not_a_player", "Only a player in this game can make a move");
      }
      if (game.nextMark !== mark) {
        throw conflict("not_your_turn", "It is not your turn");
      }
      const result = playTicTacToeMove(game.board, mark, cell);
      const winnerActorId = result.outcome === "won" ? actorId : null;
      const state = result.outcome === "ongoing" ? "active" : result.outcome;
      const nextMark = result.outcome === "ongoing" ? (mark === "X" ? "O" : "X") : null;
      await client.query(
        `UPDATE game_sessions SET board = $3, state = $4, next_mark = $5, winner_actor_id = $6,
         winning_line = $7, revision = revision + 1, updated_at = now(), completed_at = CASE WHEN $4 = 'active' THEN NULL ELSE now() END
         WHERE id = $1 AND room_id = $2`,
        [sessionId, roomId, JSON.stringify(result.board), state, nextMark, winnerActorId, result.winningLine === null ? null : JSON.stringify(result.winningLine)],
      );
      const session = await loadGame(client, roomId, sessionId);
      await emitGame(client, roomId, state === "active" ? "game_move_made" : "game_finished", actorId, session);
      if (state !== "active") {
        await restoreStatuses(client, sessionId, roomId);
      }
      return session;
    });
  }

  public async leave(roomId: string, sessionId: string, actorId: string): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      const game = await loadGame(client, roomId, sessionId, true);
      if (game.spectatorActorIds.includes(actorId)) {
        await client.query("DELETE FROM game_spectators WHERE session_id = $1 AND actor_id = $2", [sessionId, actorId]);
        await restoreStatuses(client, sessionId, roomId, actorId);
        const session = await loadGame(client, roomId, sessionId);
        await emitGame(client, roomId, "game_spectator_left", actorId, session);
        return session;
      }
      if (game.playerXActorId !== actorId && game.playerOActorId !== actorId) {
        throw conflict("not_in_game", "You are not in this game");
      }
      if (game.state === "waiting") {
        await client.query("UPDATE game_sessions SET state = 'cancelled', next_mark = NULL, revision = revision + 1, updated_at = now(), completed_at = now() WHERE id = $1", [sessionId]);
      } else if (game.state === "active") {
        const winner = game.playerXActorId === actorId ? game.playerOActorId : game.playerXActorId;
        await client.query("UPDATE game_sessions SET state = 'won', next_mark = NULL, winner_actor_id = $2, revision = revision + 1, updated_at = now(), completed_at = now() WHERE id = $1", [sessionId, winner]);
      } else {
        return game;
      }
      const session = await loadGame(client, roomId, sessionId);
      await emitGame(client, roomId, session.state === "cancelled" ? "game_cancelled" : "game_finished", actorId, session);
      await restoreStatuses(client, sessionId, roomId);
      return session;
    });
  }

  public async requestRematch(roomId: string, sessionId: string, actorId: string): Promise<GameSession> {
    return withTransaction(this.database, async (client) => {
      const game = await loadGame(client, roomId, sessionId, true);
      if (game.state !== "won" && game.state !== "draw") {
        throw conflict("rematch_not_available", "A rematch is only available after a completed game");
      }
      if (game.playerXActorId !== actorId && game.playerOActorId !== actorId) {
        throw conflict("not_a_player", "Only the two players can request a rematch");
      }
      if (game.rematchSessionId !== null) {
        return loadGame(client, roomId, game.rematchSessionId);
      }
      await requireAvailableActor(client, roomId, actorId);
      await client.query("INSERT INTO game_rematch_votes (session_id, actor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [sessionId, actorId]);
      const votes = await client.query<{ actor_id: string }>("SELECT actor_id FROM game_rematch_votes WHERE session_id = $1", [sessionId]);
      if (votes.rowCount !== 2) {
        const session = await loadGame(client, roomId, sessionId);
        await emitGame(client, roomId, "game_rematch_requested", actorId, session);
        return session;
      }
      const playerX = game.playerOActorId!;
      const playerO = game.playerXActorId;
      await requireAvailableActor(client, roomId, playerX);
      await requireAvailableActor(client, roomId, playerO);
      const newId = randomUUID();
      await client.query(
        `INSERT INTO game_sessions (id, room_id, game_type, state, player_x_actor_id, player_o_actor_id, board, next_mark, rematch_of_session_id)
         VALUES ($1, $2, 'tic_tac_toe', 'active', $3, $4, $5, 'X', $6)`,
        [newId, roomId, playerX, playerO, JSON.stringify(emptyTicTacToeBoard()), sessionId],
      );
      await client.query("UPDATE game_sessions SET rematch_session_id = $2, revision = revision + 1, updated_at = now() WHERE id = $1", [sessionId, newId]);
      await rememberAndSetStatus(client, newId, roomId, playerX, "player", "Playing Tic-tac-toe");
      await rememberAndSetStatus(client, newId, roomId, playerO, "player", "Playing Tic-tac-toe");
      const session = await loadGame(client, roomId, newId);
      await emitGame(client, roomId, "game_rematch_started", actorId, session);
      return session;
    });
  }
}
