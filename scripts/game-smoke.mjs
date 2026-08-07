const baseUrl = process.env.MODBOTS_API_URL ?? "http://127.0.0.1:3001";
const roomId = "chill-play";

const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, baseUrl), options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${body.message ?? response.statusText}`);
  }
  return body;
};

const createGuest = async (displayName) =>
  request("/api/guests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName, acceptPolicy: true }),
  });

const post = (path, actor, body = {}) =>
  request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${actor.session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ actorId: actor.actor.id, ...body }),
  });

const patch = (path, actor, body) =>
  request(path, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${actor.session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const first = await createGuest("Game Smoke One");
const second = await createGuest("Game Smoke Two");

await post(`/api/rooms/${roomId}/presence`, first, { state: "joined" });
await post(`/api/rooms/${roomId}/presence`, second, { state: "joined" });

const created = await post(`/api/rooms/${roomId}/games/tic-tac-toe`, first);
const gameId = created.session.id;
await patch(`/api/rooms/${roomId}/actors/${first.actor.id}/status`, first, {
  statusMode: "preset",
  statusText: "Busy",
});
const joined = await post(`/api/rooms/${roomId}/games/${gameId}/join`, second);
if (joined.session.state !== "active") throw new Error("Game did not start");
const statusAfterJoin = await request(`/api/actors/${first.actor.id}`);
if (statusAfterJoin.statusMode !== "preset" || statusAfterJoin.statusText !== "Busy") {
  throw new Error("Starting the game replaced the player's chosen status");
}

for (const [actor, cell] of [
  [first, 0],
  [second, 3],
  [first, 1],
  [second, 4],
  [first, 2],
]) {
  await post(`/api/rooms/${roomId}/games/${gameId}/moves`, actor, { cell });
}

const directory = await request(`/api/rooms/${roomId}/games`);
const completed = directory.sessions.find((session) => session.id === gameId);
if (completed?.state !== "won" || completed.winnerActorId !== first.actor.id) {
  throw new Error("Winning game state was not persisted");
}
if (completed.winningLine?.join(",") !== "0,1,2") {
  throw new Error("Winning line was not persisted");
}
const statusAfterGame = await request(`/api/actors/${first.actor.id}`);
if (statusAfterGame.statusMode !== "preset" || statusAfterGame.statusText !== "Busy") {
  throw new Error("Completing the game replaced the player's chosen status");
}

await post(`/api/rooms/${roomId}/games/${gameId}/rematch`, first);
const rematch = await post(`/api/rooms/${roomId}/games/${gameId}/rematch`, second);
if (
  rematch.session.state !== "active" ||
  rematch.session.playerXActorId !== second.actor.id ||
  rematch.session.playerOActorId !== first.actor.id
) {
  throw new Error("Rematch did not start with swapped marks");
}

await post(
  `/api/rooms/${roomId}/games/${rematch.session.id}/leave`,
  first,
);
await post(`/api/rooms/${roomId}/presence`, first, { state: "left" });
await post(`/api/rooms/${roomId}/presence`, second, { state: "left" });

console.log("Tic-tac-toe multiplayer smoke test passed");
console.log(`Completed game: ${gameId}`);
console.log(`Rematch game: ${rematch.session.id}`);
