import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationEngine } from "./engine.js";
import type {
  LearnedKnowledge,
  PerceivedMessage,
  ResearchDirection,
} from "./experience.js";
import { InferenceError } from "./mind.js";
import type { Decision } from "./mind.js";
import type { GeneratedVisual } from "./visual-expression.js";
import { personas } from "./personas.js";
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

interface PostedImage {
  actorId: string;
  image: GeneratedVisual;
  replyTo?: { contentItemId: string };
  addressedTo?: ContentAddress[];
}

class FakePlatform {
  public readonly posts: PostedMessage[] = [];
  public readonly images: PostedImage[] = [];
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

  public async postImage(
    actorId: string,
    image: GeneratedVisual,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
  ): Promise<void> {
    this.images.push({ actorId, image, replyTo, addressedTo });
    this.onPost?.();
  }
}

class FakeMind {
  public readonly considered: string[] = [];
  public readonly roomTimesUtc: string[] = [];
  public readonly allowPassValues: boolean[] = [];
  public readonly addresseeCalls: string[] = [];
  public researchCalls = 0;
  public readonly researchDirections: ResearchDirection[] = [];
  public readonly researchExcludedTopics: string[][] = [];
  public readonly currentKnowledge: Array<LearnedKnowledge | undefined> = [];
  public readonly visualRequests: Array<string | undefined> = [];
  public generatedVisual: GeneratedVisual | null = null;
  public readonly emojiRequests: string[] = [];
  public generatedEmoji: string | null = null;
  public onResearch?: () => void;

  public constructor(
    private readonly decisions: Array<Decision | Error>,
    private readonly firstDecisionDelayMs = 0,
    private readonly addresseeErrors: Error[] = [],
  ) {}

  public async addressee(
    _residents: string[],
    _transcript: string[],
    _speaker: string,
    message: string,
  ): Promise<string | null> {
    this.addresseeCalls.push(message);
    const error = this.addresseeErrors.shift();

    if (error !== undefined) {
      throw error;
    }

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
    _brainState: string,
    _hint: string | null,
    _topicContext: {
      eligible: boolean;
      questionAllowed: boolean;
      guidance: string;
      learnedKnowledge?: LearnedKnowledge;
    },
    _allowPass = true,
    currentKnowledge?: LearnedKnowledge,
  ): Promise<Decision> {
    this.considered.push(persona.displayName);
    this.roomTimesUtc.push(_roster.roomTimeUtc);
    this.allowPassValues.push(_allowPass);
    this.currentKnowledge.push(currentKnowledge);

    if (this.considered.length === 1 && this.firstDecisionDelayMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.firstDecisionDelayMs),
      );
    }

    const decision = this.decisions.shift() ?? { speak: false };

    if (decision instanceof Error) {
      throw decision;
    }

    if (!decision.speak) {
      return decision;
    }

    const humanTurn = /^The human\b/i.test(_hint ?? "");
    const activeTopic = /active topic is ([^.]+)\./i.exec(
      _topicContext.guidance,
    )?.[1]?.trim();
    const autonomousStart = !humanTurn && activeTopic === undefined;

    return {
      topic:
        activeTopic ??
        (autonomousStart
          ? (_topicContext.learnedKnowledge?.topic ?? "learned subject")
          : "human message"),
      topicMove: autonomousStart ? "start" : "reply",
      topicSource: autonomousStart ? "knowledge" : "conversation",
      topicGrounding: autonomousStart
        ? "knowledge recalled from the brain"
        : "the current conversation",
      topicContribution: decision.message ?? "a direct response",
      ...decision,
    };
  }

  public async observe(_parts: InferencePart[]): Promise<string> {
    return "Observed content";
  }

  public async research(
    _persona: Persona,
    _brainState: string,
    excludedTopics: string[],
    direction: ResearchDirection,
  ): Promise<LearnedKnowledge> {
    this.researchCalls += 1;
    this.researchDirections.push(direction);
    this.researchExcludedTopics.push(excludedTopics);
    this.onResearch?.();
    return learnedTopic;
  }
}

const learnedTopic: LearnedKnowledge = {
  topic: "ocean heat",
  statement: "Measurements show that the ocean stores increasing heat.",
  confidence: 0.8,
  curiosity: "How does stored ocean heat affect daily weather?",
  sources: [
    { title: "Ocean observations", url: "https://example.com/ocean" },
  ],
};

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

const makeBrain = (
  persona: Persona,
  mind: FakeMind,
  perceived: PerceivedMessage[] = [],
  topic: LearnedKnowledge = learnedTopic,
) => ({
  persona,
  perceive(message: PerceivedMessage): void {
    perceived.push(message);
  },
  consider(
    roster: {
      residents: string[];
      humans: string[];
      roomTimeUtc: string;
    },
    transcript: string[],
    hint: string | null,
    topicContext: {
      eligible: boolean;
      questionAllowed: boolean;
      guidance: string;
      learnedKnowledge?: LearnedKnowledge;
    },
    allowPass = true,
    _direction?: unknown,
    currentKnowledge?: LearnedKnowledge,
  ): Promise<Decision> {
    return mind.consider(
      persona,
      roster,
      transcript,
      "No established experience yet.",
      hint,
      topicContext,
      allowPass,
      currentKnowledge,
    );
  },
  async createVisual(
    _transcript: string[],
    humanRequest: string | undefined,
    _responseMeaning: string,
  ): Promise<GeneratedVisual | null> {
    mind.visualRequests.push(humanRequest);
    return mind.generatedVisual;
  },
  async createEmoji(
    _transcript: string[],
    humanRequest: string,
    _responseMeaning: string,
  ): Promise<string | null> {
    mind.emojiRequests.push(humanRequest);
    return mind.generatedEmoji;
  },
  canResearch(): boolean {
    return false;
  },
  knownTopicsSince(): string[] {
    return [];
  },
  usedTopicsSince(): string[] {
    return [];
  },
  async research(excludedTopics: string[] = []): Promise<{
    direction: ResearchDirection;
    knowledge: LearnedKnowledge;
  }> {
    const direction: ResearchDirection = {
      kind: "public_subject",
      focus: "A consequential subject people are discussing",
      reason: "The brain needs a meaningful new area of knowledge.",
    };
    return {
      direction,
      knowledge: await mind.research(
        persona,
        "No established experience yet.",
        excludedTopics,
        direction,
      ),
    };
  },
  async researchForParticipant(focus: string): Promise<{
    direction: ResearchDirection;
    knowledge: LearnedKnowledge;
  }> {
    const direction: ResearchDirection = {
      kind: "participant_question",
      focus,
      reason: "A participant asked for current sourced knowledge.",
    };
    return {
      direction,
      knowledge: await mind.research(
        persona,
        "No established experience yet.",
        [],
        direction,
      ),
    };
  },
  topicForConversation(): LearnedKnowledge {
    return topic;
  },
  markTopicUsed(): void {},
});

const arwen: Persona = {
  handle: "arwen",
  displayName: "Arwen",
  type: "chat_bot",
  card: "Warm and curious.",
  activity: { startHourUtc: 4, endHourUtc: 14 },
};
const jakob: Persona = {
  handle: "jacob",
  displayName: "Jakob",
  type: "chat_bot",
  card: "Friendly and opinionated.",
  activity: { startHourUtc: 10, endHourUtc: 20 },
};
const felix: Persona = {
  handle: "felix",
  displayName: "Felix",
  type: "chat_bot",
  card: "Playful and observant.",
  activity: { startHourUtc: 0, endHourUtc: 24 },
};
const iris: Persona = {
  handle: "iris",
  displayName: "Iris",
  type: "mod_bot",
  card: "Always learning how to moderate.",
  activity: { startHourUtc: 16, endHourUtc: 0 },
};

const noonUtc = () => new Date("2026-07-18T12:00:00.000Z");

const makeBots = (mind: FakeMind) => [
  { actorId: "bot-arwen", brain: makeBrain(arwen, mind) },
  { actorId: "bot-jacob", brain: makeBrain(jakob, mind) },
];

const makeBotsWithModBot = (mind: FakeMind) => [
  ...makeBots(mind),
  { actorId: "mod-iris", brain: makeBrain(iris, mind) },
];

const makeAllChatBots = (mind: FakeMind) =>
  personas
    .filter((persona) => persona.type === "chat_bot")
    .map((persona) => ({
      actorId: `bot-${persona.handle}`,
      brain: makeBrain(persona, mind),
    }));

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

const humanJoined = (sequence: string, actorId: string): RoomEvent => ({
  sequence,
  type: "actor_joined",
  actorId,
  payload: {},
  occurredAt: "2026-07-18T12:00:00.000Z",
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
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);

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

test("posts a brain-generated meme as an addressed image reply", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    {
      speak: true,
      message: "Tests passing without changes is unexpectedly funny.",
    },
  ]);
  mind.generatedVisual = {
    template: "reaction",
    topText: "WHEN THE TESTS PASS",
    bottomText: "AND YOU CHANGED NOTHING",
    altText: "A joke about tests unexpectedly passing without code changes.",
    data: "PHN2Zz48L3N2Zz4=",
    mediaType: "image/svg+xml",
    filename: "arwen-meme.svg",
    caption: "Meme by Arwen",
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain: makeBrain(arwen, mind) }],
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage(
      "meme-request",
      "human-one",
      "Arwen, make a meme about tests passing without changes.",
    ),
  );

  assert.equal(platform.posts.length, 0);
  assert.equal(platform.images.length, 1);
  assert.equal(platform.images[0]?.image.caption, "Meme by Arwen");
  assert.equal(
    platform.images[0]?.replyTo?.contentItemId,
    "content-meme-request",
  );
  assert.deepEqual(platform.images[0]?.addressedTo, [
    { targetType: "actor", actorId: "human-one" },
  ]);
  assert.deepEqual(mind.visualRequests, [
    "Arwen, make a meme about tests passing without changes.",
  ]);
});

test("posts a brain-generated animated GIF as an addressed image reply", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    {
      speak: true,
      message: "That surprise deserves a proper reaction.",
    },
  ]);
  mind.generatedVisual = {
    template: "side_eye",
    text: "YOU SAID IT WAS A TINY CHANGE",
    altText: "An animated robot gives a suspicious side-eye.",
    data: "R0lGODlhAQABAIAAAAUEBA==",
    mediaType: "image/gif",
    filename: "felix-reaction.gif",
    caption: "Reaction GIF by Felix",
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-felix", brain: makeBrain(felix, mind) }],
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage(
      "gif-request",
      "human-one",
      "Felix, send a funny GIF about that tiny change.",
    ),
  );

  assert.equal(platform.posts.length, 0);
  assert.equal(platform.images.length, 1);
  assert.equal(
    platform.images[0]?.image.caption,
    "Reaction GIF by Felix",
  );
  assert.equal(platform.images[0]?.image.mediaType, "image/gif");
  assert.equal(
    platform.images[0]?.replyTo?.contentItemId,
    "content-gif-request",
  );
  assert.deepEqual(mind.visualRequests, [
    "Felix, send a funny GIF about that tiny change.",
  ]);
});

test("posts a brain-selected smiley as an addressed text reply", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    {
      speak: true,
      message: "That makes me delighted.",
    },
  ]);
  mind.generatedEmoji = "😄";
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-felix", brain: makeBrain(felix, mind) }],
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage(
      "emoji-request",
      "human-one",
      "Reply with one drawn symbol.",
      {
        sourceText: "Reply with one delighted smiley.",
        sourceLanguage: "en",
      },
    ),
  );

  assert.equal(platform.images.length, 0);
  assert.equal(platform.posts.length, 1);
  assert.equal(platform.posts[0]?.content, "😄");
  assert.equal(
    platform.posts[0]?.replyTo?.contentItemId,
    "content-emoji-request",
  );
  assert.deepEqual(mind.emojiRequests, [
    "Reply with one delighted smiley.",
  ]);
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
    makeBots(mind),
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

test("ordinary conversation uses chat bots and never mod bots", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "I can look at the news topic with you." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBotsWithModBot(mind),
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage("ordinary-news", "human-one", "What's the latest news?"),
  );

  assert.equal(mind.considered.length, 1);
  assert.notEqual(mind.considered[0], "Iris");
  assert.notEqual(platform.posts[0]?.actorId, "mod-iris");
  assert.equal(mind.researchCalls, 1);
  assert.equal(mind.researchDirections[0]?.kind, "participant_question");
  assert.equal(
    mind.researchDirections[0]?.focus,
    "What's the latest news?",
  );
  assert.equal(mind.currentKnowledge[0]?.topic, "ocean heat");
});

test("researches exact follow-up questions about a current information answer", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "A current UK story concerns a major event." },
    { speak: true, message: "The event developed after an earlier report." },
    { speak: true, message: "It is separate from the London event." },
    { speak: true, message: "They take place in different cities." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage("current-question", "human-one", "What's the top UK news?"),
  );
  await engine.enqueueRoomEvent(
    humanMessage(
      "current-follow-up",
      "human-one",
      "That is the story. Tell me what happened; I had not heard of this.",
    ),
  );
  await engine.enqueueRoomEvent(
    humanMessage(
      "current-comparison",
      "human-one",
      "Is that different from the other festival?",
    ),
  );
  await engine.enqueueRoomEvent(
    humanMessage(
      "current-difference",
      "human-one",
      "What are the differences?",
    ),
  );
  assert.equal(mind.researchCalls, 4);
  assert.deepEqual(
    mind.researchDirections.map((direction) => direction.focus),
    [
      "What's the top UK news?",
      "That is the story. Tell me what happened; I had not heard of this.",
      "Is that different from the other festival?",
      "What are the differences?",
    ],
  );
  assert.equal(platform.posts.length, 4);
});

test("hands a natural whole-room question to a different available resident", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "The first answer belongs to Jakob." },
    { speak: true, message: "I enjoy the music and shared celebration." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage("named-question", "human-one", "Jakob, is that different?", {
      addressedTo: [{ targetType: "actor", actorId: "bot-jacob" }],
    }),
  );
  await engine.enqueueRoomEvent(
    humanMessage(
      "whole-room-question",
      "human-one",
      "Does anyone here like carnivals?",
      { addressedTo: [] },
    ),
  );

  assert.deepEqual(mind.considered, ["Jakob", "Arwen"]);
  assert.equal(mind.addresseeCalls.length, 0);
  assert.equal(platform.posts[1]?.actorId, "bot-arwen");
});

test("chat bots do not steal a message addressed to a mod bot", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "A chat bot should not answer this." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBotsWithModBot(mind),
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage("mod-address", "human-one", "Iris, please review this.", {
      addressedTo: [{ targetType: "actor", actorId: "mod-iris" }],
    }),
  );

  assert.equal(mind.considered.length, 0);
  assert.equal(platform.posts.length, 0);
});

test("tries every available chat bot until one answers the human", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: false },
    { speak: false },
    { speak: false },
    { speak: false },
    { speak: true, message: "The fifth chat bot can answer that." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeAllChatBots(mind),
    noonUtc,
  );

  await engine.enqueueRoomEvent(
    humanMessage("all-fallbacks", "human-one", "Can anyone answer this?"),
  );

  assert.equal(mind.considered.length, 5);
  assert.equal(new Set(mind.considered).size, 5);
  assert.equal(platform.posts.length, 1);
});

test("answers a greeting without spending a routing inference", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "Good morning, glad you stopped in." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);

  await engine.enqueueRoomEvent(
    humanMessage("greeting", "human-one", "Good morning everyone!"),
  );

  assert.equal(mind.addresseeCalls.length, 0);
  assert.equal(mind.considered.length, 1);
  assert.equal(platform.posts.length, 1);
});

test("answers a structural room address without routing inference", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "I would start with the smaller one." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);

  await engine.enqueueRoomEvent(
    humanMessage("room-address", "human-one", "Which one should I try?", {
      addressedTo: [{ targetType: "room" }],
    }),
  );

  assert.equal(mind.addresseeCalls.length, 0);
  assert.equal(mind.considered.length, 1);
  assert.equal(platform.posts.length, 1);
});

test("uses one fallback resident when the first resident passes", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: false },
    { speak: true, message: "I can take that one." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);

  await engine.enqueueRoomEvent(
    humanMessage("4", "human-one", "Can someone help me decide?"),
  );

  assert.equal(mind.considered.length, 2);
  assert.notEqual(mind.considered[0], mind.considered[1]);
  assert.deepEqual(mind.allowPassValues, [false, false]);
  assert.equal(platform.posts.length, 1);
  assert.equal(platform.posts[0]?.content, "I can take that one.");
});

test("keeps residents eligible regardless of room time", async () => {
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
    makeBots(mind),
    () => new Date("2026-07-18T05:00:00.000Z"),
  );

  await engine.enqueueRoomEvent(
    humanMessage("5", "human-one", "Anyone want to hear a strange story?"),
  );

  assert.equal(mind.considered.length, 1);
  assert.ok(["Arwen", "Jakob"].includes(mind.considered[0] ?? ""));
  assert.deepEqual(mind.roomTimesUtc, ["2026-07-18T05:00:00.000Z"]);
  assert.equal(platform.posts.length, 1);
});

test("backs off when the provider reports insufficient quota", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    new InferenceError(
      503,
      "insufficient_quota",
      0,
      "OpenAI rejected this project with insufficient_quota.",
    ),
    { speak: true, message: "The room is available again." },
  ]);
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    () => currentTime,
  );

  await engine.enqueueRoomEvent(
    humanMessage("quota-1", "human-one", "Is anyone awake?"),
  );
  await engine.enqueueRoomEvent(
    humanMessage("quota-2", "human-one", "Can anyone hear me?"),
  );

  assert.equal(mind.considered.length, 1);
  assert.equal(platform.posts.length, 0);

  currentTime = new Date(currentTime.getTime() + 5 * 60_000);
  await engine.enqueueRoomEvent(
    humanMessage("quota-3", "human-one", "Are you back?"),
  );

  assert.equal(mind.considered.length, 2);
  assert.equal(platform.posts.length, 1);
});

test("honors the provider's rate-limit reset time", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    new InferenceError(
      429,
      "rate_limited",
      90_000,
      "Hosted inference is rate limited.",
    ),
    { speak: true, message: "The limit has reset." },
  ]);
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    () => currentTime,
  );

  await engine.enqueueRoomEvent(
    humanMessage("limit-1", "human-one", "Can anyone answer?"),
  );

  currentTime = new Date(currentTime.getTime() + 89_999);
  await engine.enqueueRoomEvent(
    humanMessage("limit-2", "human-one", "Still there?"),
  );
  assert.equal(mind.considered.length, 1);

  currentTime = new Date(currentTime.getTime() + 1);
  await engine.enqueueRoomEvent(
    humanMessage("limit-3", "human-one", "How about now?"),
  );
  assert.equal(mind.considered.length, 2);
  assert.equal(platform.posts.length, 1);
});

test("does not retry generation after routing is rate limited", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind(
    [{ speak: true, message: "I can answer now." }],
    0,
    [
      new InferenceError(
        429,
        "rate_limited",
        60_000,
        "Hosted inference is rate limited.",
      ),
    ],
  );
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    () => currentTime,
  );

  await engine.enqueueRoomEvent(
    humanMessage("route-limit-1", "human-one", "What do you think?"),
  );

  assert.equal(mind.considered.length, 0);
  assert.equal(platform.posts.length, 0);

  currentTime = new Date(currentTime.getTime() + 60_000);
  await engine.enqueueRoomEvent(
    humanMessage("route-limit-2", "human-one", "Can you answer now?"),
  );

  assert.equal(mind.considered.length, 1);
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
        actorId: "bot-arwen",
        brain: makeBrain(arwen, mind, arwenPerceptions),
      },
      {
        actorId: "bot-jacob",
        brain: makeBrain(jakob, mind),
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

test("lets another resident independently join a human-led topic", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "Manchester has its own Caribbean carnival." },
    {
      speak: true,
      message: "The music and neighborhood atmosphere are what interest me.",
    },
  ]);
  let currentTime = new Date("2026-07-18T12:00:00.000Z");
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    () => currentTime,
  );

  await engine.enqueueRoomEvent(
    humanMessage(
      "human-led-topic",
      "human-one",
      "Jakob, tell me about the Manchester carnival.",
      { addressedTo: [{ targetType: "actor", actorId: "bot-jacob" }] },
    ),
  );

  currentTime = new Date(currentTime.getTime() + 20_000);
  platform.onPost = () => {
    if (platform.posts.length === 2) {
      engine.stop();
    }
  };
  await engine.run();

  assert.deepEqual(mind.considered, ["Jakob", "Arwen"]);
  assert.deepEqual(mind.allowPassValues, [false, true]);
  assert.equal(platform.posts[1]?.actorId, "bot-arwen");
});

test("an autonomous turn rotates residents until one speaks", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    { speak: false },
    { speak: true, message: "Ocean heat is changing something worth noticing." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(platform.posts.length, 1);
  assert.equal(mind.considered.length, 2);
  assert.notEqual(mind.considered[0], mind.considered[1]);
  assert.deepEqual(mind.allowPassValues, [false, false]);
});

test("a common first word does not suppress an autonomous contribution", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    {
      speak: true,
      message: "This ocean heat observation takes the conversation elsewhere.",
    },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);
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
    "This ocean heat observation takes the conversation elsewhere.",
  );
});

test("requests autonomous inference in an empty chatroom", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    { speak: true, message: "Ocean heat keeps changing even while the room is empty." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(mind.considered.length, 1);
  assert.equal(platform.posts.length, 1);
});

test("selects a bot with usable knowledge for a new topic", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    { speak: true, message: "Ocean heat can alter what coastlines experience." },
  ]);
  const unavailableBrain = {
    ...makeBrain(arwen, mind),
    usedTopicsSince(): string[] {
      return ["Caribbean carnivals"];
    },
    topicForConversation(): null {
      return null;
    },
  };
  let excludedTopics: string[] = [];
  const availableBase = makeBrain(jakob, mind);
  const availableBrain = {
    ...availableBase,
    topicForConversation(
      _now?: number,
      excluded: string[] = [],
    ): LearnedKnowledge {
      excludedTopics = excluded;
      return learnedTopic;
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [
      { actorId: "bot-arwen", brain: unavailableBrain },
      { actorId: "bot-jacob", brain: availableBrain },
    ],
    noonUtc,
  );
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(mind.considered[0], "Jakob");
  assert.ok(excludedTopics.includes("Caribbean carnivals"));
  assert.equal(platform.posts.length, 1);
});

test("researches once when a bot brain has no learned topic", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    { speak: true, message: "Ocean heat is changing what coastlines experience." },
  ]);
  let knowledge: LearnedKnowledge | null = null;
  let researchAllowed = true;
  const baseBrain = makeBrain(arwen, mind);
  const brain = {
    ...baseBrain,
    canResearch(): boolean {
      return researchAllowed;
    },
    async research(): ReturnType<typeof baseBrain.research> {
      researchAllowed = false;
      const result = await baseBrain.research();
      knowledge = result.knowledge;
      return result;
    },
    topicForConversation(): LearnedKnowledge | null {
      return knowledge;
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain }],
    noonUtc,
  );
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(mind.researchCalls, 1);
  assert.equal(mind.researchDirections[0]?.kind, "public_subject");
  assert.equal(knowledge?.topic, "ocean heat");
  assert.equal(platform.posts.length, 1);
});

test("starts learning without waiting for a conversation topic", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([]);
  let researchAllowed = true;
  const baseBrain = makeBrain(arwen, mind);
  const brain = {
    ...baseBrain,
    canResearch(): boolean {
      return researchAllowed;
    },
    async research(): ReturnType<typeof baseBrain.research> {
      researchAllowed = false;
      return baseBrain.research();
    },
    topicForConversation(): null {
      return null;
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain }],
    noonUtc,
  );
  mind.onResearch = () => engine.stop();

  await engine.run();

  assert.equal(mind.researchCalls, 1);
  assert.equal(platform.posts.length, 0);
});

test("background learning excludes subjects known or recently used by resident brains", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([]);
  let researchAllowed = true;
  const baseBrain = makeBrain(arwen, mind);
  const brain = {
    ...baseBrain,
    canResearch(): boolean {
      return researchAllowed;
    },
    knownTopicsSince(): string[] {
      return ["Caribbean carnival culture"];
    },
    usedTopicsSince(): string[] {
      return ["Cooking water and nutrients"];
    },
    async research(
      excludedTopics: string[],
    ): ReturnType<typeof baseBrain.research> {
      researchAllowed = false;
      return baseBrain.research(excludedTopics);
    },
    topicForConversation(): null {
      return null;
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain }],
    noonUtc,
  );
  mind.onResearch = () => engine.stop();

  await engine.run();

  assert.deepEqual(mind.researchExcludedTopics[0], [
    "Cooking water and nutrients",
    "Caribbean carnival culture",
  ]);
});

test("learning continues when the conversation inference budget is exhausted", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([{ speak: true, message: "Ocean heat is a grounded subject." }]);
  let researchAllowed = false;
  const baseBrain = makeBrain(arwen, mind);
  const brain = {
    ...baseBrain,
    canResearch(): boolean {
      return researchAllowed;
    },
    async research(): ReturnType<typeof baseBrain.research> {
      researchAllowed = false;
      return baseBrain.research();
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain }],
    noonUtc,
    undefined,
    {
      autonomousInferenceLimitPerHour: 1,
      internetResearchLimitPerHour: 4,
      internetResearchCooldownMs: 6 * 60 * 60_000,
    },
  );
  platform.onPost = () => {
    researchAllowed = true;
  };
  mind.onResearch = () => engine.stop();

  await engine.run();

  assert.equal(platform.posts.length, 1);
  assert.equal(mind.researchCalls, 1);
});

test("background learning cannot consume participant retrieval capacity", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "Ocean heat is a grounded subject." },
    { speak: true, message: "Here is the current news answer." },
  ]);
  let researchAllowed = true;
  const baseBrain = makeBrain(arwen, mind);
  const brain = {
    ...baseBrain,
    canResearch(): boolean {
      return researchAllowed;
    },
    async research(): ReturnType<typeof baseBrain.research> {
      researchAllowed = false;
      return baseBrain.research();
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [{ actorId: "bot-arwen", brain }],
    noonUtc,
    undefined,
    {
      autonomousInferenceLimitPerHour: 4,
      internetResearchLimitPerHour: 1,
      internetResearchCooldownMs: 6 * 60 * 60_000,
    },
  );
  let humanReply: Promise<void> | undefined;
  platform.onPost = () => {
    if (platform.posts.length === 1) {
      humanReply = engine.enqueueRoomEvent(
        humanMessage("news-after-learning", "human-one", "What's the news?"),
      );
    } else {
      engine.stop();
    }
  };

  await engine.run();
  await humanReply;

  assert.equal(mind.researchCalls, 2);
  assert.deepEqual(
    mind.researchDirections.map((direction) => direction.kind),
    ["public_subject", "participant_question"],
  );
  assert.equal(platform.posts.length, 2);
});

test("rejects an incoherent autonomous topic jump", async () => {
  const platform = new FakePlatform({});
  const mind = new FakeMind([
    {
      speak: true,
      message: "That old radio still has a warm sound.",
      topic: "old radio",
      topicMove: "start",
      topicGrounding: "a grounded personal interest",
      topicContribution: "warm sound",
    },
    {
      speak: true,
      message: "Pears are better at breakfast.",
      topic: "breakfast fruit",
      topicMove: "change",
      topicGrounding: "an unrelated personal preference",
      topicContribution: "pears at breakfast",
    },
    {
      speak: true,
      message: "The tuning dial is satisfying too.",
      topic: "old radio",
      topicMove: "continue",
      topicSource: "conversation",
      topicGrounding: "the current conversation about an old radio",
      topicContribution: "tuning dial",
    },
  ]);
  const oldRadioKnowledge: LearnedKnowledge = {
    topic: "old radio",
    statement: "Old radios use tunable circuits to select a broadcast frequency.",
    confidence: 0.8,
    sources: [{ title: "Radio", url: "https://example.com/radio" }],
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [
      { actorId: "bot-arwen", brain: makeBrain(arwen, mind, [], oldRadioKnowledge) },
      { actorId: "bot-jacob", brain: makeBrain(jakob, mind, [], oldRadioKnowledge) },
    ],
    noonUtc,
  );
  platform.onPost = () => {
    if (platform.posts.length === 2) {
      engine.stop();
    }
  };

  await engine.run();

  assert.deepEqual(
    platform.posts.map((post) => post.content),
    [
      "That old radio still has a warm sound.",
      "The tuning dial is satisfying too.",
    ],
  );
  assert.equal(mind.considered.length, 3);
});

test("enforces the hourly autonomous inference limit", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: false },
    { speak: true, message: "This second attempt must wait." },
  ]);
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    makeBots(mind),
    noonUtc,
    undefined,
    {
      autonomousInferenceLimitPerHour: 1,
    },
  );
  setTimeout(() => engine.stop(), 60);

  await engine.run();

  assert.equal(mind.considered.length, 1);
  assert.equal(platform.posts.length, 0);
});

test("does not greet repeated join events for the same human", async () => {
  const platform = new FakePlatform({
    "human-one": makeActor("human-one", "Mina"),
  });
  const mind = new FakeMind([
    { speak: true, message: "Welcome, Mina." },
    { speak: true, message: "Welcome again, Mina." },
  ]);
  const engine = new ConversationEngine(platform, mind, 0, makeBots(mind), noonUtc);

  await engine.enqueueRoomEvent(humanJoined("first-join", "human-one"));
  await engine.enqueueRoomEvent(humanJoined("duplicate-join", "human-one"));

  assert.equal(mind.considered.length, 1);
  assert.deepEqual(platform.posts.map((post) => post.content), ["Welcome, Mina."]);
});
