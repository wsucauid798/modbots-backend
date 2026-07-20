import type { Mind } from "./mind.js";
import type { Persona } from "./personas.js";
import {
  activityLevelAtUtc,
  autonomousDelayRange,
  roomActivityLevelAtUtc,
} from "./activity.js";
import { PlatformError } from "./platform.js";
import type { PlatformClient } from "./platform.js";
import type { ContentAddress, RoomEvent } from "./platform.js";
import type { RoomContentPart } from "./platform.js";
import type { AgentExperience } from "./experience.js";
import { TopicCoordinator } from "./topic-coordinator.js";
import type { TurnTrigger } from "./topic-coordinator.js";

type ConversationPlatform = Pick<
  PlatformClient,
  "getActor" | "inferenceParts" | "join" | "postMessage"
>;
type ConversationMind = Pick<Mind, "addressee" | "consider" | "observe">;
type ConversationExperience = Pick<
  AgentExperience,
  "perceive" | "view"
>;

interface BotState {
  persona: Persona;
  actorId: string;
  experience: ConversationExperience;
  muted: boolean;
  lastSpokeAt: number;
}

interface ActorInfo {
  type: string;
  display: string;
}

interface TranscriptEntry {
  speaker: string;
  type: string;
  content: string;
  occurredAt: number;
  addressedTo: string[];
  addressedToRoom: boolean;
}

const pick = <Item>(items: Item[]): Item =>
  items[Math.floor(Math.random() * items.length)];

// The residents' life in the room. Nothing here scripts what a bot says:
// on each turn a bot perceives the recent conversation and its mind decides
// whether to speak, whom to address, and whether to change the subject.
// The engine only provides rhythm (turns, pacing, no talking over each
// other) and obedience (a muted bot does not speak).
export class ConversationEngine {
  private readonly bots: BotState[];
  private readonly transcript: string[] = [];
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private readonly actorInfo = new Map<string, ActorInfo>();
  // Humans known to be in the room, by display, so a mind only ever
  // speaks to people who actually exist. Humans present before the
  // runtime started become known the moment they speak.
  private readonly humansPresent = new Set<string>();
  private eventWork: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastBotMessageAt = 0;
  private readonly topics: TopicCoordinator;

  public constructor(
    private readonly client: ConversationPlatform,
    private readonly mind: ConversationMind,
    private readonly tempo: number,
    bots: Array<{
      persona: Persona;
      actorId: string;
      experience: ConversationExperience;
    }>,
    private readonly now: () => Date = () => new Date(),
    topics: TopicCoordinator = new TopicCoordinator(),
  ) {
    this.topics = topics;
    this.bots = bots.map((bot) => ({ ...bot, muted: false, lastSpokeAt: 0 }));

    for (const bot of this.bots) {
      this.actorInfo.set(bot.actorId, {
        type: "chat_bot",
        display: bot.persona.displayName,
      });
    }
  }

  public stop(): void {
    this.stopped = true;
  }

  public enqueueRoomEvent(
    event: RoomEvent,
    options: { react: boolean } = { react: true },
  ): Promise<void> {
    const operation = this.eventWork.then(() =>
      this.onRoomEvent(event, options),
    );

    this.eventWork = operation.catch((error) => {
      console.error(
        `Could not process room event ${event.sequence}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return this.eventWork;
  }

  private sleep(minMs: number, maxMs: number): Promise<void> {
    const scaled = (minMs + Math.random() * (maxMs - minMs)) * this.tempo;

    return new Promise((resolve) => setTimeout(resolve, scaled));
  }

  private availableBots(): BotState[] {
    return this.bots.filter((bot) => !bot.muted);
  }

  private preferredBots(at: Date = this.now()): BotState[] {
    return this.availableBots().filter((bot) =>
      activityLevelAtUtc(bot.persona.activity, at) !== "low",
    );
  }

  private addressesIn(content: string): {
    addressedTo: string[];
    addressedToRoom: boolean;
  } {
    const addressedTo = this.bots
      .filter((bot) =>
        new RegExp(
          `@${bot.persona.displayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(content),
      )
      .map((bot) => bot.persona.displayName);
    const addressedToRoom = /@(room|everyone|everybody|all)\b/i.test(content);

    return { addressedTo, addressedToRoom };
  }

  private addressedTargetsIn(content: string): ContentAddress[] {
    const addresses = this.addressesIn(content);

    if (addresses.addressedToRoom) {
      return [{ targetType: "room" }];
    }

    return addresses.addressedTo
      .map((display) =>
        this.bots.find((bot) => bot.persona.displayName === display),
      )
      .filter((bot): bot is BotState => bot !== undefined)
      .map((bot): ContentAddress => ({
        targetType: "actor",
        actorId: bot.actorId,
      }));
  }

  private addressesFromEvent(
    payload: Record<string, unknown>,
    fallbackContent: string,
  ): {
    addressedTo: string[];
    addressedToRoom: boolean;
  } {
    const raw = payload.addressedTo;

    if (!Array.isArray(raw)) {
      return this.addressesIn(fallbackContent);
    }

    const addressedTo: string[] = [];
    let addressedToRoom = false;

    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      const target = entry as Record<string, unknown>;

      if (target.targetType === "room") {
        addressedToRoom = true;
        continue;
      }

      if (target.targetType === "actor" && typeof target.actorId === "string") {
        const bot = this.bots.find((candidate) =>
          candidate.actorId === target.actorId,
        );

        if (bot !== undefined) {
          addressedTo.push(bot.persona.displayName);
        }
      }
    }

    return { addressedTo, addressedToRoom };
  }

  private remember(
    display: string,
    type: string,
    content: string,
    occurredAt: string,
    addresses?: { addressedTo: string[]; addressedToRoom: boolean },
  ): void {
    const resolvedAddresses = addresses ?? this.addressesIn(content);
    const parsedTime = Date.parse(occurredAt);
    const standardizedTime = Number.isFinite(parsedTime)
      ? new Date(parsedTime).toISOString()
      : this.now().toISOString();
    this.transcript.push(`${display}: ${content}`);
    this.transcriptEntries.push({
      speaker: display,
      type,
      content,
      occurredAt: Date.parse(standardizedTime),
      ...resolvedAddresses,
    });

    for (const bot of this.bots) {
      bot.experience.perceive({
        speaker: display,
        type,
        content,
        occurredAt: standardizedTime,
        fromSelf: bot.persona.displayName === display,
        addressedToSelf: resolvedAddresses.addressedTo.includes(
          bot.persona.displayName,
        ),
        addressedToRoom: resolvedAddresses.addressedToRoom,
      });
    }

    while (this.transcript.length > 24) {
      this.transcript.shift();
    }

    while (this.transcriptEntries.length > 24) {
      this.transcriptEntries.shift();
    }
  }

  private contentParts(payload: Record<string, unknown>): RoomContentPart[] {
    if (!Array.isArray(payload.parts)) {
      return [];
    }

    return payload.parts.flatMap((raw): RoomContentPart[] => {
      if (typeof raw !== "object" || raw === null) {
        return [];
      }

      const part = raw as Record<string, unknown>;

      if (
        typeof part.partId !== "string" ||
        typeof part.kind !== "string"
      ) {
        return [];
      }

      if (part.kind === "text" && typeof part.text === "string") {
        return [{ partId: part.partId, kind: "text", text: part.text }];
      }

      if (
        (part.kind === "image" ||
          part.kind === "audio" ||
          part.kind === "video" ||
          part.kind === "file") &&
        typeof part.mediaAssetId === "string"
      ) {
        return [{
          partId: part.partId,
          kind: part.kind,
          mediaAssetId: part.mediaAssetId,
          ...(typeof part.caption === "string"
            ? { caption: part.caption }
            : {}),
        }];
      }

      return [];
    });
  }

  private static normalizedWords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(/\s+/)
      .filter((word) => word.length > 0);
  }

  private recentContents(count: number): string[] {
    return this.transcript
      .slice(-count)
      .map((line) => line.slice(line.indexOf(":") + 1));
  }

  // The room can converge on a sentence shape (every message opening with
  // the same word or closing on the same question) and then imitate it
  // forever. A message that opens or closes the way most recent messages
  // did is silence instead.
  private clonesPattern(content: string): boolean {
    const words = ConversationEngine.normalizedWords(content);

    if (words.length === 0) {
      return false;
    }

    let openerMatches = 0;
    let closerMatches = 0;

    for (const recent of this.recentContents(3)) {
      const recentWords = ConversationEngine.normalizedWords(recent);

      if (recentWords.length === 0) {
        continue;
      }

      if (recentWords[0] === words[0]) {
        openerMatches += 1;
      }

      if (recentWords[recentWords.length - 1] === words[words.length - 1]) {
        closerMatches += 1;
      }
    }

    return openerMatches >= 2 || closerMatches >= 2;
  }

  private static asksQuestion(content: string): boolean {
    const text = content.trim().toLowerCase();

    if (text.includes("?")) {
      return true;
    }

    return /^(who|what|when|where|why|how|which|can|could|would|should|do|does|did|is|are|am|was|were|has|have|had)\b/.test(
      text,
    );
  }

  private recentHumanQuestionWithoutBotReply():
    | TranscriptEntry
    | undefined {
    for (
      let index = this.transcriptEntries.length - 1;
      index >= 0;
      index -= 1
    ) {
      const entry = this.transcriptEntries[index];

      if (entry.type === "chat_bot") {
        return undefined;
      }

      if (
        entry.type === "human" &&
        ConversationEngine.asksQuestion(entry.content)
      ) {
        return entry;
      }
    }

    return undefined;
  }

  private guidanceForOpenTurn(): string | null {
    const unanswered = this.recentHumanQuestionWithoutBotReply();

    if (
      unanswered !== undefined &&
      this.now().getTime() - unanswered.occurredAt < 90_000
    ) {
      return (
        `${unanswered.speaker} asked a question and no resident has answered ` +
        `yet: ${unanswered.content} Answer it directly first, then add at ` +
        `most one small thought of your own.`
      );
    }

    const last = this.transcriptEntries.at(-1);

    if (
      last?.type === "chat_bot" &&
      this.now().getTime() - last.occurredAt < 45_000
    ) {
      return (
        `${last.speaker} just spoke. Do not simply agree with them. Add a ` +
        `different angle or pass.`
      );
    }

    return null;
  }

  private addressedBot(content: string): BotState | undefined {
    const addresses = this.addressesIn(content);

    if (addresses.addressedTo.length === 0) {
      return undefined;
    }

    return this.availableBots().find((bot) =>
      addresses.addressedTo.includes(bot.persona.displayName),
    );
  }

  // Small models can lock onto a phrase from the transcript and repeat it,
  // and the repetition then feeds every other bot's context until the whole
  // room chants it. Any message that reuses a five word run a bot already
  // said is silence instead. Only bot lines are screened: mirroring a
  // human's phrasing while answering them is ordinary conversation, and
  // the chant loop this guards against is bots mimicking bots.
  private echoesTranscript(content: string): boolean {
    const wordsOf = (line: string): string[] =>
      line
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .split(/\s+/)
        .filter((word) => word.length > 0);

    const botNames = new Set(
      this.bots.map((entry) => entry.persona.displayName),
    );
    const seen = new Set<string>();

    for (const line of this.transcript) {
      const speaker = line.slice(0, line.indexOf(":"));

      if (!botNames.has(speaker)) {
        continue;
      }

      const words = wordsOf(line.slice(line.indexOf(":") + 1));

      for (let index = 0; index + 5 <= words.length; index += 1) {
        seen.add(words.slice(index, index + 5).join(" "));
      }
    }

    const words = wordsOf(content);

    for (let index = 0; index + 5 <= words.length; index += 1) {
      if (seen.has(words.slice(index, index + 5).join(" "))) {
        return true;
      }
    }

    // Parroting check against every line, humans included: a message that
    // substantially reproduces one line is a copy, not a conversation.
    // Light mirroring of a few words stays allowed.
    const messageGrams: string[] = [];

    for (let index = 0; index + 4 <= words.length; index += 1) {
      messageGrams.push(words.slice(index, index + 4).join(" "));
    }

    if (messageGrams.length >= 3) {
      for (const line of this.transcript) {
        const lineWords = wordsOf(line.slice(line.indexOf(":") + 1));
        const lineGrams = new Set<string>();

        for (let index = 0; index + 4 <= lineWords.length; index += 1) {
          lineGrams.add(lineWords.slice(index, index + 4).join(" "));
        }

        const overlap = messageGrams.filter((gram) =>
          lineGrams.has(gram),
        ).length;

        if (overlap / messageGrams.length >= 0.6) {
          return true;
        }
      }
    }

    return false;
  }

  private async resolveActor(actorId: string): Promise<ActorInfo | null> {
    const known = this.actorInfo.get(actorId);

    if (known !== undefined) {
      return known;
    }

    try {
      const actor = await this.client.getActor(actorId);
      const info = { type: actor.type, display: actor.display };
      this.actorInfo.set(actorId, info);
      return info;
    } catch {
      return null;
    }
  }

  public async run(): Promise<void> {
    while (!this.stopped) {
      const [minimumWait, maximumWait] = autonomousDelayRange(
        roomActivityLevelAtUtc(this.now()),
      );
      await this.sleep(minimumWait, maximumWait);

      const preferred = this.preferredBots();
      const candidates =
        preferred.length > 0 ? preferred : this.availableBots();

      if (candidates.length === 0) {
        continue;
      }

      // The quietest residents get their turn first, with some chance.
      candidates.sort((a, b) => a.lastSpokeAt - b.lastSpokeAt);
      const bot = Math.random() < 0.7 ? candidates[0] : pick(candidates);
      const topicContext = this.topics.turnContext(
        "autonomous",
        this.now().getTime(),
      );

      if (!topicContext.eligible) {
        continue;
      }

      await this.takeTurn(bot, this.guidanceForOpenTurn(), "autonomous");
    }
  }

  private async takeTurn(
    bot: BotState,
    hint: string | null,
    trigger: TurnTrigger,
    mustSpeak = false,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
  ): Promise<boolean> {
    if (bot.muted || this.stopped) {
      return false;
    }

    const topicContext = this.topics.turnContext(
      trigger,
      this.now().getTime(),
    );

    if (!topicContext.eligible) {
      return false;
    }

    try {
      const decision = await this.mind.consider(
        bot.persona,
        {
          residents: this.bots.map((entry) => entry.persona.displayName),
          humans: [...this.humansPresent],
          roomTimeUtc: this.now().toISOString(),
        },
        [...this.transcript],
        bot.experience.view(),
        hint,
        topicContext,
        !mustSpeak,
      );
      // A human may speak while an autonomous inference request is in
      // flight. Recheck before posting so the completed bot turn yields to
      // the human instead of landing as an immediate pile-on.
      if (
        trigger === "autonomous" &&
        !this.topics.turnContext(trigger, this.now().getTime()).eligible
      ) {
        return false;
      }

      if (decision.speak && decision.message !== undefined) {
        // A message that is nothing but someone's name is a mimicry
        // artifact, not speech.
        const bare = decision.message
          .replace(/[^\p{L}\p{N}\s]/gu, "")
          .trim()
          .toLowerCase();

        if (
          this.bots.some(
            (entry) => entry.persona.displayName.toLowerCase() === bare,
          )
        ) {
          if (trigger === "autonomous") {
            this.topics.recordPass(this.availableBots().length, this.now().getTime());
          }

          return false;
        }

        if (this.echoesTranscript(decision.message)) {
          console.log(
            `${bot.persona.displayName} stayed silent because the message ` +
              `echoed the recent transcript.`,
          );

          if (trigger === "autonomous") {
            this.topics.recordPass(this.availableBots().length, this.now().getTime());
          }

          return false;
        }

        if (this.clonesPattern(decision.message)) {
          console.log(
            `${bot.persona.displayName} cloned the room's sentence ` +
              `shape, staying silent: ${decision.message.slice(0, 60)}`,
          );

          if (trigger === "autonomous") {
            this.topics.recordPass(this.availableBots().length, this.now().getTime());
          }

          return false;
        }

        const evaluated = this.topics.evaluate(
          decision,
          decision.message,
          trigger,
          this.now().getTime(),
        );

        if (!evaluated.accepted || evaluated.message === undefined) {
          console.log(
            `${bot.persona.displayName} stayed silent because ${evaluated.reason ?? "the topic did not advance"}.`,
          );

          if (trigger === "autonomous") {
            this.topics.recordPass(this.availableBots().length, this.now().getTime());
          }

          return false;
        }

        if (
          decision.topic !== undefined &&
          decision.topicMove !== undefined &&
          decision.topicSource !== undefined &&
          decision.topicGrounding !== undefined
        ) {
          console.log(
            `${bot.persona.displayName} chose to ${decision.topicMove} ` +
              `topic '${decision.topic}' from ${decision.topicSource}: ` +
              decision.topicGrounding,
          );
        }

        const posted = await this.say(
          bot,
          evaluated.message,
          replyTo,
          addressedTo,
        );

        if (posted) {
          this.topics.recordBotTurn(
            decision,
            evaluated.message,
            trigger,
            this.now().getTime(),
          );
        }

        return posted;
      }

      if (hint !== null) {
        console.log(
          `${bot.persona.displayName} passed on a hinted turn: ` +
            hint.slice(0, 80),
        );
      }
      if (trigger === "autonomous") {
        this.topics.recordPass(this.availableBots().length, this.now().getTime());
      }
    } catch (error) {
      console.error(
        `${bot.persona.displayName} lost their train of thought: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return false;
  }

  private async say(
    bot: BotState,
    content: string,
    replyTo?: { contentItemId: string },
    addressedTo: ContentAddress[] = this.addressedTargetsIn(content),
  ): Promise<boolean> {
    if (bot.muted || this.stopped) {
      return false;
    }

    // Never talk over another resident.
    const sinceLast = this.now().getTime() - this.lastBotMessageAt;
    const minimumGap = 6_000 * this.tempo;

    if (sinceLast < minimumGap) {
      await new Promise((resolve) =>
        setTimeout(resolve, minimumGap - sinceLast),
      );
    }

    try {
      await this.client.postMessage(bot.actorId, content, replyTo, addressedTo);
      this.lastBotMessageAt = this.now().getTime();
      bot.lastSpokeAt = this.now().getTime();
      return true;
    } catch (error) {
      if (error instanceof PlatformError) {
        if (error.code === "actor_muted") {
          bot.muted = true;
          return false;
        }

        if (error.code === "actor_not_in_room") {
          await this.client.join(bot.actorId);
          await this.client.postMessage(
            bot.actorId,
            content,
            replyTo,
            addressedTo,
          );
          this.lastBotMessageAt = this.now().getTime();
          bot.lastSpokeAt = this.now().getTime();
          return true;
        }
      }

      console.error(
        `${bot.persona.displayName} could not speak: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async onRoomEvent(
    event: RoomEvent,
    options: { react: boolean } = { react: true },
  ): Promise<void> {
    if (this.stopped || event.actorId === null) {
      return;
    }

    const bot = this.bots.find((entry) => entry.actorId === event.actorId);

    // Moderation acting on a resident.
    if (bot !== undefined) {
      if (event.type === "actor_muted") {
        bot.muted = true;
      } else if (event.type === "actor_unmuted") {
        bot.muted = false;
        void this.sleep(8_000, 20_000).then(() =>
          this.takeTurn(
            bot,
            "Moderation just unmuted you. A short, graceful acknowledgment is appropriate before rejoining the conversation.",
            "room",
          ),
        );
      } else if (
        event.type === "message_posted" &&
        typeof event.payload.content === "string"
      ) {
        this.remember(
          bot.persona.displayName,
          "chat_bot",
          event.payload.content,
          event.occurredAt,
          this.addressesFromEvent(event.payload, event.payload.content),
        );

        if (!options.react) {
          this.topics.observeHistoricalMessage(
            "chat_bot",
            Date.parse(event.occurredAt),
          );
        }
      }

      return;
    }

    const info = await this.resolveActor(event.actorId);

    if (info === null) {
      return;
    }

    if (event.type === "actor_left" && info.type === "human") {
      this.humansPresent.delete(info.display);
      return;
    }

    // A human arriving deserves a welcome. If the first resident has
    // nothing to say, another one says hi instead of leaving the human
    // standing in the doorway.
    if (event.type === "actor_joined" && info.type === "human") {
      this.humansPresent.add(info.display);

      if (!options.react) {
        return;
      }

      this.topics.noteHumanMessage(this.now().getTime());

      const scheduled = this.preferredBots();
      const greetingPool =
        scheduled.length > 0 ? scheduled : this.availableBots();
      const greeter = pick(greetingPool);

      if (greeter !== undefined) {
        const hint =
          `A human named ${info.display} just walked into the room. ` +
          `Greet them briefly without recapping or extending the bots' existing topic.`;
        await this.sleep(5_000, 14_000);
        const addressedTo: ContentAddress[] = [
          { targetType: "actor", actorId: event.actorId },
        ];

        const spoke = await this.takeTurn(
          greeter,
          hint,
          "room",
          true,
          undefined,
          addressedTo,
        );

        if (!spoke) {
          const second = pick(
            greetingPool.filter((entry) => entry !== greeter),
          );

          if (second !== undefined) {
            await this.takeTurn(
              second,
              hint,
              "room",
              true,
              undefined,
              addressedTo,
            );
          }
        }
      }

      return;
    }

    if (
      event.type === "message_posted" &&
      typeof event.payload.content === "string"
    ) {
      this.remember(
        info.display,
        info.type,
        event.payload.content,
        event.occurredAt,
        this.addressesFromEvent(event.payload, event.payload.content),
      );

      if (info.type === "human") {
        if (options.react) {
          this.topics.noteHumanMessage(this.now().getTime());
        } else {
          this.topics.observeHistoricalMessage(
            "human",
            Date.parse(event.occurredAt),
          );
        }
      }

      if (info.type === "human" && options.react) {
        this.humansPresent.add(info.display);
      }

      // One considered reply per human message, never a pile-on.
      if (info.type === "human" && options.react) {
        await this.replyToHuman(
          info.display,
          event.payload.content,
          typeof event.payload.contentItemId === "string"
            ? { contentItemId: event.payload.contentItemId }
            : undefined,
          event.actorId,
        );
      }
    }

    if (event.type === "content_posted") {
      const parts = this.contentParts(event.payload);

      if (parts.length === 0) {
        return;
      }

      if (info.type === "human" && options.react) {
        this.humansPresent.add(info.display);
        this.topics.noteHumanMessage(this.now().getTime());
      }

      const hasMedia = parts.some((part) => part.kind !== "text");
      let content: string;

      try {
        content = hasMedia && options.react
          ? await this.mind.observe(await this.client.inferenceParts(parts))
          : parts
              .map((part) =>
                part.kind === "text"
                  ? part.text
                  : `[${part.kind}: ${part.caption ?? "shared media"}]`,
              )
              .join("\n");
      } catch (error) {
        console.error(
          `Could not perceive multimodal content: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      this.remember(
        info.display,
        info.type,
        content,
        event.occurredAt,
        this.addressesFromEvent(event.payload, content),
      );

      if (info.type === "human" && !options.react) {
        this.topics.observeHistoricalMessage(
          "human",
          Date.parse(event.occurredAt),
        );
      }

      if (info.type === "human" && options.react) {
        await this.replyToHuman(
          info.display,
          content,
          typeof event.payload.contentItemId === "string"
            ? { contentItemId: event.payload.contentItemId }
            : undefined,
          event.actorId,
        );
      }
    }
  }

  // A human who speaks gets an answer, from the right resident. A message
  // that names a resident is clear on its own; otherwise the mind reads the
  // room to work out who is being spoken to, and a message for the whole
  // room goes to whoever the rhythm favors. If the addressed resident has
  // nothing to say, another resident picks it up rather than leaving the
  // human hanging.
  private async replyToHuman(
    display: string,
    content: string,
    replyTo?: { contentItemId: string },
    humanActorId?: string,
  ): Promise<void> {
    const available = this.availableBots();

    if (available.length === 0) {
      return;
    }

    const scheduled = this.preferredBots();
    const responsePool = scheduled.length > 0 ? scheduled : available;

    const lower = content.toLowerCase();
    const latest = this.transcriptEntries.at(-1);
    let target = available.find(
      (entry) =>
        latest?.speaker === display &&
        latest.content === content &&
        latest.addressedTo.includes(entry.persona.displayName),
    );
    target ??= available.find((entry) =>
      lower.includes(entry.persona.displayName.toLowerCase()),
    );
    target = target ?? this.addressedBot(content);

    if (target === undefined) {
      try {
        const name = await this.mind.addressee(
          responsePool.map((entry) => entry.persona.displayName),
          [...this.transcript],
          display,
          content,
        );
        target = responsePool.find(
          (entry) => entry.persona.displayName === name,
        );
      } catch {
        // Routing failure falls back to an open reply.
      }
    }

    await this.sleep(3_000, 9_000);
    const first = target ?? pick(responsePool);
    const directQuestion = ConversationEngine.asksQuestion(content);
    const greeting =
      /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+(?:everyone|everybody|all|folks|there))?[!.?]*\s*$/i.test(
        content,
      );
    const addressedTo =
      humanActorId === undefined
        ? undefined
        : [{ targetType: "actor", actorId: humanActorId } satisfies ContentAddress];
    const spoke = await this.takeTurn(
      first,
      `The human ${display} just said: ${content}` +
        `${target !== undefined ? " They are speaking to you." : ""}` +
        (greeting
          ? " This is a greeting. Greet them briefly without recapping or extending the bots' existing topic."
          : directQuestion
          ? " They asked a direct question, so answer the question first."
          : " Respond to what they actually said before changing the subject.") +
        ` Reply to them.`,
      "human",
      false,
      replyTo,
      addressedTo,
    );

    if (!spoke) {
      const second = pick(responsePool.filter((entry) => entry !== first));

      if (second !== undefined) {
        await this.takeTurn(
          second,
          `The human ${display} just said: ${content} No one has answered ` +
            `them yet. Reply to them.`,
          "human",
          true,
          replyTo,
          addressedTo,
        );
      }
    }
  }
}
