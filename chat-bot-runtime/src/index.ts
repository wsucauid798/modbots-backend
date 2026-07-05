import { loadConfig } from "./config.js";
import { ConversationEngine } from "./engine.js";
import { Mind } from "./mind.js";
import { personas } from "./personas.js";
import { PlatformClient } from "./platform.js";
import type { RoomEvent } from "./platform.js";

const config = loadConfig();
const client = new PlatformClient(config.apiUrl, config.roomId);
const mind = new Mind(config.mlUrl);

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Watch the room over the realtime gateway so the engine can react to
// humans and to moderation. Reconnects resume from the last processed
// sequence; only events after startup are reacted to, history is not.
const watchRoom = async (
  fromSequence: string,
  onEvent: (event: RoomEvent) => void,
): Promise<never> => {
  let after = fromSequence;

  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        const url = new URL(`/v1/rooms/${config.roomId}`, config.realtimeUrl);
        url.searchParams.set("after", after);
        const socket = new WebSocket(url);

        socket.addEventListener("message", (message) => {
          try {
            const envelope = JSON.parse(String(message.data)) as {
              delivery?: string;
              channel?: string;
              sequence?: string;
              event?: RoomEvent;
            };

            if (
              envelope.delivery === "reliable" &&
              envelope.channel === "room.event" &&
              envelope.event !== undefined &&
              typeof envelope.sequence === "string"
            ) {
              after = envelope.sequence;
              onEvent(envelope.event);
            }
          } catch {
            // A malformed frame is ignored; the stream continues.
          }
        });
        socket.addEventListener("close", () => resolve());
        socket.addEventListener("error", () =>
          reject(new Error("realtime connection failed")),
        );
      });
    } catch (error) {
      console.error(
        error instanceof Error ? error.message : String(error),
      );
    }

    await wait(2_000);
  }
};

const main = async (): Promise<void> => {
  // The stack may still be starting; wait for the platform.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.health();
      break;
    } catch {
      if (attempt === 60) {
        throw new Error("The platform API did not become healthy");
      }

      await wait(2_000);
    }
  }

  // The minds need the ML service; wait for it the same way. Model load
  // can take a while on first boot, so this is patient.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mind.health();
      break;
    } catch {
      if (attempt === 300) {
        throw new Error("The ML service did not become healthy");
      }

      await wait(2_000);
    }
  }

  // The residents take their places: find or create each chat bot by its
  // handle and join the room. Presence is part of startup, not a seed step.
  const bots = [];

  for (const persona of personas) {
    const actor = await client.ensureActor(
      persona.handle,
      persona.displayName,
    );
    await client.join(actor.id);
    bots.push({ persona, actorId: actor.id });
    console.log(`${persona.displayName} is in the room (${actor.id})`);
  }

  const engine = new ConversationEngine(client, mind, config.tempo, bots);
  const startSequence = await client.latestSequence();

  void watchRoom(startSequence, (event) => {
    void engine.onRoomEvent(event);
  });

  console.log(
    `Chat bot runtime running: room '${config.roomId}', tempo ${config.tempo}`,
  );
  await engine.run();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
