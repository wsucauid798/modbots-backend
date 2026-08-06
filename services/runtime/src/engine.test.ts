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
  public readonly addresseeCalls: string[] = [];
  public researchCalls = 0;
  public readonly researchDirections: ResearchDirection[] = [];
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
    _recentlyDiscussed: string[],
    direction: ResearchDirection,
  ): Promise<LearnedKnowledge> {
    this.researchCalls += 1;
    this.researchDirections.push(direction);
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
  ): Promise<Decision> {
    return mind.consider(
      persona,
      roster,
      transcript,
      "No established experience yet.",
      hint,
      topicContext,
      allowPass,
    );
  },
  canResearch(): boolean {
    return false;
  },
  async research(): Promise<{
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

test("a scheduled activity turn rotates residents until one speaks", async () => {
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

test("a common first word does not suppress a scheduled contribution", async () => {
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
    topicForConversation(): null {
      return null;
    },
  };
  const engine = new ConversationEngine(
    platform,
    mind,
    0,
    [
      { actorId: "bot-arwen", brain: unavailableBrain },
      { actorId: "bot-jacob", brain: makeBrain(jakob, mind) },
    ],
    noonUtc,
  );
  platform.onPost = () => engine.stop();

  await engine.run();

  assert.equal(mind.considered[0], "Jakob");
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
