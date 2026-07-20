import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationEngine } from "./engine.js";
import type { PerceivedMessage } from "./experience.js";
import type { Decision } from "./mind.js";
import type { Persona } from "./personas.js";
import type {
  Actor,
  ContentAddress,
  InferencePart,
  RoomContentPart,
  RoomEvent,
} from "./platform.js";

interface PostedMessage {
  actorId: string;
  content: string;
  replyTo?: { contentItemId: string };
  addressedTo?: ContentAddress[];
}

class FakePlatform {
  public readonly posts: PostedMessage[] = [];
  public onPost?: () => void;

  public constructor(private readonly actors: Record<string, Actor>) {}

  public async getActor(actorId: string): Promise<Actor> {
    const actor = this.actors[actorId];

    if (actor === undefined) {
      throw new Error(`Unknown actor ${actorId}`);
    }

    return actor;
  }

  public async inferenceParts(
    parts: RoomContentPart[],
  ): Promise<InferencePart[]> {
    return parts.flatMap((part): InferencePart[] =>
      part.kind === "text" ? [{ kind: "text", text: part.text }] : [],
    );
  }

  public async join(_actorId: string): Promise<void> {}

  public async postMessage(
    actorId: string,
    content: string,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
  ): Promise<void> {
    this.posts.push({ actorId, content, replyTo, addressedTo });
    this.onPost?.();
  }
}

class FakeMind {
  public readonly considered: string[] = [];
  public readonly roomTimesUtc: string[] = [];
  public readonly allowPassValues: boolean[] = [];

  public constructor(
    private readonly decisions: Decision[],
    private readonly firstDecisionDelayMs = 0,
  ) {}

  public async addressee(
    _residents: string[],
    _transcript: string[],
    _speaker: string,
    _message: string,
  ): Promise<string | null> {
    return null;
  }

  public async consider(
    persona: Persona,
    _roster: {
      residents: string[];
      humans: string[];
      roomTimeUtc: string;
    },
    _transcript: string[],
    _experience: string,
    _hint: string | null,
    _topicContext: {
      eligible: boolean;
      questionAllowed: boolean;
      guidance: string;
    },
    _allowPass = true,
  ): Promise<Decision> {
    this.considered.push(persona.displayName);
    this.roomTimesUtc.push(_roster.roomTimeUtc);
    this.allowPassValues.push(_allowPass);

    if (this.considered.length === 1 && this.firstDecisionDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.firstDecisionDelayMs),
      );
    }

    const decision = this.decisions.shift() ?? { speak: false };

    if (!decision.speak) {
      return decision;
    }

    return {
      topic: "human message",
      topicMove: "reply",
      topicSource: "conversation",
      topicGrounding: "the human's current message",
      topicContribution: decision.message ?? "a direct response",
      ...decision,
    };
  }

  public async observe(_parts: InferencePart[]): Promise<string> {
    return "Observed content";
  }
}

const makeActor = (id: string, display: string): Actor => ({
  id,
  handle: display.toLowerCase(),
  displayName: display,
  display,
  profilePictureId: null,
  profilePictureUrl: null,
  type: "human",
  retiredAt: null,
});

const makeExperience = (perceived: PerceivedMessage[] = []) => ({
  perceive(message: PerceivedMessage): void {
    perceived.push(message);
  },
  view(): string {
    return "No established experience yet.";
  },
});

const arwen: Persona = {
  handle: "arwen",
  displayName: "Arwen",
  card: "Warm and curious.",
  activity: { startHourUtc: 4, endHourUtc: 14 },
};
const jakob: Persona = {
  handle: "jacob",
  displayName: "Jakob",
  card: "Friendly and opinionated.",
  activity: { startHourUtc: 10, endHourUtc: 20 },
};

const noonUtc = () => new Date("2026-07-18T12:00:00.000Z");

const makeBots = () => [
  { persona: arwen, actorId: "bot-arwen", experience: makeExperience() },
  { persona: jakob, actorId: "bot-jacob", experience: makeExperience() },
];

const humanMessage = (
  sequence: string,
  actorId: string,
  content: string,
  payload: Record<string, unknown> = {},
): RoomEvent => ({
  sequence,
  type: "message_posted",
  actorId,
  payload: {
    content,
    contentItemId: `content-${sequence}`,
    ...payload,
  },
  occurredAt: "2026-07-18T00:00:00.000Z",
});

test("queues overlapping human messages without losing a response", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
    "human-two": makeActor("human-two", "Theo"),
  });
  const mind = new FakeMind(
    [
      { speak: true, message: "I would start with the smaller option." },
      {
        speak: true,
        message: "That sounds like a separate issue worth unpacking.",
      },
    ],
    10,
  );
  const engine = new ConversationEngine(platform, mind, 0, makeBots(), noonUtc);

  const first = engine.enqueueRoomEvent(
    humanMessage("1", "human-one", "Which option should I try first?"),
  );
  const second = engine.enqueueRoomEvent(
    humanMessage("2", "human-two", "I ran into another problem."),
  );

  await Promise.all([first, second]);

  assert.deepEqual(
    platform.posts.map((post) => post.content),
    [
      "I would start with the smaller option.",
      "That sounds like a separate issue worth unpacking.",
    ],
  );
  assert.deepEqual(
    platform.posts.map((post) => post.replyTo?.contentItemId),
    ["content-1", "content-2"],
  );
});

test("routes a structural address to the intended resident", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "I would pick the charcoal version." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(),
    () => new Date("2026-07-18T02:00:00.000Z"),
  );

  await engine.enqueueRoomEvent(
    humanMessage("3", "human-one", "Which color do you prefer?", {
      addressedTo: [{ targetType: "actor", actorId: "bot-jacob" }],
    }),
  );

  assert.deepEqual(mind.considered, ["Jakob"]);
  assert.equal(platform.posts.length, 1);
  assert.deepEqual(platform.posts[0]?.addressedTo, [
    { targetType: "actor", actorId: "human-one" },
  ]);
});

test("uses one fallback resident when the first resident passes", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: false },
    { speak: true, message: "I can take that one." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(), noonUtc);

  await engine.enqueueRoomEvent(
    humanMessage("4", "human-one", "Can someone help me decide?"),
  );

  assert.equal(mind.considered.length, 2);
  assert.notEqual(mind.considered[0], mind.considered[1]);
  assert.equal(platform.posts.length, 1);
  assert.equal(platform.posts[0]?.content, "I can take that one.");
});

test("uses an active resident for an unaddressed human message", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "I am around, what happened?" },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(),
    () => new Date("2026-07-18T05:00:00.000Z"),
  );

  await engine.enqueueRoomEvent(
    humanMessage("5", "human-one", "Anyone want to hear a strange story?"),
  );

  assert.deepEqual(mind.considered, ["Arwen"]);
  assert.deepEqual(mind.roomTimesUtc, ["2026-07-18T05:00:00.000Z"]);
  assert.equal(platform.posts.length, 1);
});

test("perceives the authoritative UTC event time", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([]);
  const arwenPerceptions: PerceivedMessage[] = [];
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [
      {
        persona: arwen,
        actorId: "bot-arwen",
        experience: makeExperience(arwenPerceptions),
      },
      {
        persona: jakob,
        actorId: "bot-jacob",
        experience: makeExperience(),
      },
    ],
    noonUtc,
  );
  const event = humanMessage(
    "6",
    "human-one",
    "This happened earlier.",
  );
  event.occurredAt = "2026-07-17T21:14:00.000Z";

  await engine.enqueueRoomEvent(event, { react: false });

  assert.equal(
    arwenPerceptions[0]?.occurredAt,
    "2026-07-17T21:14:00.000Z",
  );
});

test("a scheduled activity turn rotates residents until one speaks", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    { speak: false },
    { speak: true, message: "There is something different worth noticing." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(), noonUtc);
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(platform.posts.length, 1);
  assert.equal(mind.considered.length, 2);
  assert.notEqual(mind.considered[0], mind.considered[1]);
  assert.deepEqual(mind.allowPassValues, [false, false]);
});

test("a common first word does not suppress a scheduled contribution", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    {
      speak: true,
      message: "This separate observation takes the conversation elsewhere.",
    },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(), noonUtc);
  platform.onPost = () => engine.stop();

  await engine.enqueueRoomEvent(
    humanMessage("7", "bot-arwen", "This morning feels unusually slow."),
    { react: false },
  );
  await engine.enqueueRoomEvent(
    humanMessage("8", "bot-jacob", "This weather makes the room feel quiet."),
    { react: false },
  );
  await engine.run();

  assert.equal(
    platform.posts[0]?.content,
    "This separate observation takes the conversation elsewhere.",
  );
});
