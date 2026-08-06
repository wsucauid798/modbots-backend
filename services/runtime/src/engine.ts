import { InferenceError } from "./mind.js";
import type { Persona } from "./personas.js";
import {
  autonomousDelayRange,
  isOnClockAtUtc,
  millisecondsUntilNextShiftBoundary,
  roomActivityLevelAtUtc,
} from "./activity.js";
import { PlatformError } from "./platform.js";
import type { PlatformClient } from "./platform.js";
import type { ContentAddress, RoomEvent } from "./platform.js";
import type { RoomContentPart } from "./platform.js";
import type { LearnedKnowledge } from "./experience.js";
import type { BotBrain } from "./brain.js";
import type { RoomInterpreter } from "./room-interpreter.js";
import { ConversationPolicy } from "./conversation-policy.js";
import { TopicCoordinator } from "./topic-coordinator.js";
import type { TurnTrigger } from "./topic-coordinator.js";

type ConversationPlatform = Pick<
  PlatformClient,
  "getActor" | "inferenceParts" | "join" | "leave" | "postMessage"
>;
type ConversationRoomInterpreter = Pick<
  RoomInterpreter,
  "addressee" | "observe"
>;
type ConversationBrain = Pick<
  BotBrain,
  | "persona"
  | "perceive"
  | "consider"
  | "canResearch"
  | "research"
  | "researchForParticipant"
  | "topicForConversation"
  | "markTopicUsed"
>;
type ConversationLearningPolicy = Pick<
  ConversationPolicy,
  | "chooseSpeaker"
  | "chooseDirection"
  | "recordTurn"
  | "observeHumanMessage"
  | "recordModeration"
  | "recordRejected"
  | "recordPass"
>;

interface BotState {
  persona: Persona;
  actorId: string;
  brain: ConversationBrain;
  muted: boolean;
  lastSpokeAt: number;
  lastAttemptedAt: number;
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

export interface RuntimeCostControls {
  autonomousInferenceLimitPerHour: number;
  internetResearchLimitPerHour?: number;
  internetResearchCooldownMs?: number;
}

const defaultCostControls: RuntimeCostControls = {
  autonomousInferenceLimitPerHour: 12,
  internetResearchLimitPerHour: 4,
  internetResearchCooldownMs: 6 * 60 * 60_000,
};

const pick = <Item>(items: Item[]): Item =>
  items[Math.floor(Math.random() * items.length)];

// The residents' life in the room. Nothing here scripts what a bot says:
// on each turn a bot perceives the recent conversation and its mind decides
// whether to speak, whom to address, and whether to change the subject.
// The engine keeps the resident loop running and obeys hard room state such
// as muting. Room activity sets the beat between autonomous turns. That room
// pacing is separate from the work clock followed only by mod bots.
export class ConversationEngine {
  private readonly bots: BotState[];
  private readonly transcript: string[] = [];
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private readonly actorInfo = new Map<string, ActorInfo>();
  // Humans known to be in the room, by display, so a mind only ever
  // speaks to people who actually exist.
  private readonly humansPresent = new Set<string>();
  private eventWork: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastBotMessageAt = 0;
  private humanRepliesPending = 0;
  private inferenceBackoffMs = 0;
  private inferencePausedUntil = 0;
  private readonly autonomousInferenceAttempts: number[] = [];
  private readonly internetResearchAttempts: number[] = [];
  private nextLearningBotIndex = 0;
  private autonomousPauseReason: "budget" | null = null;
  private readonly topics: TopicCoordinator;
  private readonly workingModBotIds = new Set<string>();
  private workClockStarted = false;
  private workShiftTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly client: ConversationPlatform,
    private readonly roomInterpreter: ConversationRoomInterpreter,
    private readonly tempo: number,
    bots: Array<{
      actorId: string;
      brain: ConversationBrain;
    }>,
    private readonly now: () => Date = () => new Date(),
    topics: TopicCoordinator = new TopicCoordinator(),
    private readonly costControls: RuntimeCostControls = defaultCostControls,
    private readonly policy: ConversationLearningPolicy = ConversationPolicy.inMemory(),
  ) {
    this.topics = topics;
    this.bots = bots.map((bot) => ({
      ...bot,
      persona: bot.brain.persona,
      muted: false,
      lastSpokeAt: 0,
      lastAttemptedAt: 0,
    }));

    for (const bot of this.bots) {
      this.actorInfo.set(bot.actorId, {
        type: bot.persona.type,
        display: bot.persona.displayName,
      });
    }
  }

  public stop(): void {
    this.stopped = true;
    if (this.workShiftTimer !== undefined) {
      clearTimeout(this.workShiftTimer);
      this.workShiftTimer = undefined;
    }
  }

  private async syncModBotWorkShifts(): Promise<void> {
    const now = this.now();
    const modBots = this.bots.filter(
      (bot) => bot.persona.type === "mod_bot",
    );

    for (const bot of modBots) {
      const onClock =
        bot.persona.type === "mod_bot" &&
        isOnClockAtUtc(now, bot.persona.workShift);
      const wasWorking = this.workingModBotIds.has(bot.actorId);

      if (onClock && !wasWorking) {
        await this.client.join(bot.actorId);
        this.workingModBotIds.add(bot.actorId);
        console.log(`${bot.persona.displayName} started work.`);
      } else if (!onClock && (!this.workClockStarted || wasWorking)) {
        await this.client.leave(bot.actorId);
        this.workingModBotIds.delete(bot.actorId);
        console.log(`${bot.persona.displayName} is off the clock.`);
      }
    }
  }

  private scheduleNextWorkShiftChange(retryInMs?: number): void {
    if (this.stopped) {
      return;
    }

    const shifts = this.bots.flatMap((bot) =>
      bot.persona.type === "mod_bot" ? [bot.persona.workShift] : [],
    );

    if (shifts.length === 0) {
      return;
    }

    const delay =
      retryInMs ?? millisecondsUntilNextShiftBoundary(this.now(), shifts);
    this.workShiftTimer = setTimeout(() => {
      void this.advanceWorkClock();
    }, delay);
    this.workShiftTimer.unref?.();
  }

  private async advanceWorkClock(): Promise<void> {
    let retryInMs: number | undefined;

    try {
      await this.syncModBotWorkShifts();
    } catch (error) {
      retryInMs = 30_000;
      console.error(
        `Could not change mod bot work shifts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.scheduleNextWorkShiftChange(retryInMs);
    }
  }

  private async startWorkClock(): Promise<void> {
    if (this.workClockStarted) {
      return;
    }

    await this.syncModBotWorkShifts();
    this.workClockStarted = true;
    this.scheduleNextWorkShiftChange();
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

  private pause(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private pruneAutonomousInferenceAttempts(now: number): void {
    const hourAgo = now - 60 * 60_000;

    while ((this.autonomousInferenceAttempts[0] ?? now) <= hourAgo) {
      this.autonomousInferenceAttempts.shift();
    }
  }

  private autonomousPauseAt(now: number): "budget" | null {
    this.pruneAutonomousInferenceAttempts(now);

    if (
      this.autonomousInferenceAttempts.length >=
      this.costControls.autonomousInferenceLimitPerHour
    ) {
      return "budget";
    }

    return null;
  }

  private logAutonomousPause(reason: "budget" | null): void {
    if (reason === this.autonomousPauseReason) {
      return;
    }

    this.autonomousPauseReason = reason;

    if (reason === "budget") {
      console.log(
        "Autonomous inference paused because the hourly limit was reached.",
      );
    } else {
      console.log("Autonomous inference resumed.");
    }
  }

  private pruneInternetResearchAttempts(now: number): void {
    const hourAgo = now - 60 * 60_000;
    while ((this.internetResearchAttempts[0] ?? now) <= hourAgo) {
      this.internetResearchAttempts.shift();
    }
  }

  private async learnOneEligibleBot(now: number): Promise<boolean> {
    this.pruneInternetResearchAttempts(now);
    const hourlyLimit = this.costControls.internetResearchLimitPerHour ?? 4;
    const autonomousLimit = Math.max(0, hourlyLimit - 1);
    const cooldownMs =
      this.costControls.internetResearchCooldownMs ?? 6 * 60 * 60_000;

    // Background learning must leave one lookup available for a participant
    // who asks for current public information.
    if (this.internetResearchAttempts.length >= autonomousLimit) {
      return false;
    }

    let selected: BotState | undefined;
    for (let offset = 0; offset < this.bots.length; offset += 1) {
      const index = (this.nextLearningBotIndex + offset) % this.bots.length;
      const candidate = this.bots[index];
      const canWork =
        candidate?.persona.type === "chat_bot" ||
        (candidate?.persona.type === "mod_bot" &&
          isOnClockAtUtc(new Date(now), candidate.persona.workShift));

      if (canWork && candidate?.brain.canResearch(now, cooldownMs)) {
        selected = candidate;
        this.nextLearningBotIndex = (index + 1) % this.bots.length;
        break;
      }
    }

    if (selected === undefined) {
      return false;
    }

    const attemptedAt = this.now().toISOString();
    this.internetResearchAttempts.push(now);
    const recentlyCompleted = this.topics.recentlyCompletedTopics();
    const result = await selected.brain.research(
      recentlyCompleted,
      attemptedAt,
    );
    console.log(
      `${selected.persona.displayName} researched ${result.direction.kind}: ${result.direction.focus}`,
    );
    console.log(
      `${selected.persona.displayName} learned about '${result.knowledge.topic}' from ` +
        `${result.knowledge.sources.length} internet source${result.knowledge.sources.length === 1 ? "" : "s"}.`,
    );
    return true;
  }

  private async continueLearning(): Promise<void> {
    if (this.stopped || this.inferencePausedUntil > this.now().getTime()) {
      return;
    }

    try {
      await this.learnOneEligibleBot(this.now().getTime());
    } catch (error) {
      this.deferForInferenceFailure(error);
      console.error(
        `A bot brain could not learn from the internet: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async currentKnowledgeFor(
    bot: BotState,
    publicFocus: string,
  ): Promise<LearnedKnowledge | undefined> {
    const now = this.now().getTime();
    this.pruneInternetResearchAttempts(now);
    const hourlyLimit = this.costControls.internetResearchLimitPerHour ?? 4;

    if (this.internetResearchAttempts.length >= hourlyLimit) {
      return undefined;
    }

    const attemptedAt = this.now().toISOString();
    this.internetResearchAttempts.push(now);

    try {
      const result = await bot.brain.researchForParticipant(
        publicFocus,
        attemptedAt,
      );
      console.log(
        `${bot.persona.displayName} researched a participant's current ` +
          `question and learned '${result.knowledge.topic}' from ` +
          `${result.knowledge.sources.length} internet source${
            result.knowledge.sources.length === 1 ? "" : "s"
          }.`,
      );
      return result.knowledge;
    } catch (error) {
      this.deferForInferenceFailure(error);
      console.error(
        `${bot.persona.displayName} could not research the participant's ` +
          `current question: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return undefined;
    }
  }

  private deferForInferenceFailure(error: unknown): boolean {
    if (
      !(error instanceof InferenceError) ||
      (error.status !== 429 &&
        error.code !== "rate_limited" &&
        error.code !== "insufficient_quota")
    ) {
      return false;
    }

    const minimumBackoffMs =
      error.code === "insufficient_quota" ? 5 * 60_000 : 15_000;
    this.inferenceBackoffMs = Math.min(
      Math.max(
        minimumBackoffMs,
        error.retryAfterMs,
        this.inferenceBackoffMs * 2,
      ),
      5 * 60_000,
    );
    this.inferencePausedUntil = this.now().getTime() + this.inferenceBackoffMs;
    return true;
  }

  private availableChatBots(): BotState[] {
    return this.bots.filter(
      (bot) => !bot.muted && bot.persona.type === "chat_bot",
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
    const previousSpeaker = this.transcriptEntries.at(-1)?.speaker;
    this.transcript.push(`${display}: ${content}`);
    this.transcriptEntries.push({
      speaker: display,
      type,
      content,
      occurredAt: Date.parse(standardizedTime),
      ...resolvedAddresses,
    });

    for (const bot of this.bots) {
      if (
        bot.persona.type === "mod_bot" &&
        !isOnClockAtUtc(new Date(standardizedTime), bot.persona.workShift)
      ) {
        continue;
      }

      bot.brain.perceive({
        speaker: display,
        type,
        content,
        occurredAt: standardizedTime,
        fromSelf: bot.persona.displayName === display,
        addressedToSelf: resolvedAddresses.addressedTo.includes(
          bot.persona.displayName,
        ),
        addressedToRoom: resolvedAddresses.addressedToRoom,
        followedSelf:
          previousSpeaker === bot.persona.displayName &&
          bot.persona.displayName !== display,
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

  // The room can converge on a sentence shape and then imitate it forever.
  // Match short phrases rather than a single common word so ordinary openers
  // such as "This" do not suppress otherwise distinct contributions.
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

      const openerLength = Math.min(2, words.length, recentWords.length);
      const closerLength = Math.min(2, words.length, recentWords.length);

      if (
        recentWords.slice(0, openerLength).join(" ") ===
        words.slice(0, openerLength).join(" ")
      ) {
        openerMatches += 1;
      }

      if (
        recentWords.slice(-closerLength).join(" ") ===
        words.slice(-closerLength).join(" ")
      ) {
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

  private static currentInformationFocus(content: string): string | null {
    const text = content.trim().toLowerCase();

    if (/\b(news|headlines?|breaking news|current events?)\b/.test(text)) {
      return "Major public news headlines reported today";
    }

    return null;
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

      if (entry.type === "chat_bot" || entry.type === "mod_bot") {
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
    const recentOpenings = this.transcriptEntries
      .filter(
        (entry) => entry.type === "chat_bot" || entry.type === "mod_bot",
      )
      .slice(-3)
      .map((entry) =>
        ConversationEngine.normalizedWords(entry.content).slice(0, 2).join(" "),
      )
      .filter((opening) => opening.length > 0);
    const styleGuidance =
      recentOpenings.length === 0
        ? ""
        : ` Use a different sentence opening from these recent openings: ${recentOpenings.join(", ")}.`;
    const unanswered = this.recentHumanQuestionWithoutBotReply();

    if (
      unanswered !== undefined &&
      this.now().getTime() - unanswered.occurredAt < 90_000
    ) {
      return (
        `${unanswered.speaker} asked a question and no resident has answered ` +
        `yet: ${unanswered.content} Answer it directly first, then add at ` +
        `most one small thought of your own.${styleGuidance}`
      );
    }

    return styleGuidance.trim().length > 0 ? styleGuidance.trim() : null;
  }

  private addressedBot(content: string): BotState | undefined {
    const addresses = this.addressesIn(content);

    if (addresses.addressedTo.length === 0) {
      return undefined;
    }

    return this.availableChatBots().find((bot) =>
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
    await this.startWorkClock();

    while (!this.stopped) {
      await this.continueLearning();

      if (this.stopped) {
        continue;
      }

      const now = this.now().getTime();
      const pausedFor = Math.max(0, this.inferencePausedUntil - now);

      if (pausedFor > 0) {
        await this.pause(pausedFor);
      } else {
        const pauseReason = this.autonomousPauseAt(now);
        this.logAutonomousPause(pauseReason);

        if (pauseReason !== null) {
          await this.pause(Math.max(25, 15_000 * this.tempo));
          continue;
        }

        const activityLevel = roomActivityLevelAtUtc(this.now());
        const [minimumWait, maximumWait] = autonomousDelayRange(activityLevel);
        await this.sleep(minimumWait, maximumWait);
      }

      if (this.humanRepliesPending > 0) {
        continue;
      }

      const pauseReason = this.autonomousPauseAt(this.now().getTime());
      this.logAutonomousPause(pauseReason);

      if (pauseReason !== null) {
        continue;
      }

      const available = this.availableChatBots();
      let candidates = available;
      const topicContext = this.topics.turnContext(
        "autonomous",
        this.now().getTime(),
      );

      if (topicContext.activeTopic === null) {
        const recentlyCompleted = this.topics.recentlyCompletedTopics();
        candidates = candidates.filter(
          (candidate) =>
            candidate.brain.topicForConversation(
              this.now().getTime(),
              recentlyCompleted,
            ) !== null,
        );
      }

      if (candidates.length === 0) {
        continue;
      }

      const selected = this.policy.chooseSpeaker(
        candidates.map((candidate) => ({
          displayName: candidate.persona.displayName,
          lastAttemptedAt: candidate.lastAttemptedAt,
          lastSpokeAt: candidate.lastSpokeAt,
        })),
        this.now().getTime(),
      );
      const first = candidates.find(
        (candidate) => candidate.persona.displayName === selected?.displayName,
      );
      if (first !== undefined) {
        await this.takeTurn(
          first,
          this.guidanceForOpenTurn(),
          "autonomous",
          true,
        );
      }
    }
  }

  private async takeTurn(
    bot: BotState,
    hint: string | null,
    trigger: TurnTrigger,
    mustSpeak = false,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
    directQuestion = false,
    currentKnowledge?: LearnedKnowledge,
  ): Promise<boolean> {
    // This is the conversation engine. Mod bot speech must enter through an
    // explicit moderation-purpose path, never ordinary reply or autonomous
    // chat selection.
    if (bot.persona.type !== "chat_bot" || bot.muted || this.stopped) {
      return false;
    }

    if (this.inferencePausedUntil > this.now().getTime()) {
      return false;
    }

    let topicContext = this.topics.turnContext(
      trigger,
      this.now().getTime(),
    );

    if (trigger === "autonomous" && topicContext.activeTopic === null) {
      const learnedKnowledge = bot.brain.topicForConversation(
        this.now().getTime(),
        this.topics.recentlyCompletedTopics(),
      );
      topicContext = this.topics.turnContext(
        trigger,
        this.now().getTime(),
        learnedKnowledge ?? undefined,
      );
    }

    if (!topicContext.eligible) {
      return false;
    }

    const direction = this.policy.chooseDirection({
      trigger,
      activeTopic: topicContext.activeTopic,
      questionAllowed: topicContext.questionAllowed,
      botTurnsOnTopic: topicContext.botTurnsOnTopic,
      directQuestion,
    });

    if (direction.intent === "wait") {
      this.policy.recordPass(direction.intent);
      bot.lastAttemptedAt = this.now().getTime();
      if (trigger === "autonomous") {
        this.topics.recordPass(
          this.availableChatBots().length,
          this.now().getTime(),
        );
      }
      return false;
    }

    try {
      bot.lastAttemptedAt = this.now().getTime();

      if (trigger === "autonomous") {
        this.autonomousInferenceAttempts.push(this.now().getTime());
      }

      const decision = await bot.brain.consider(
        {
          residents: this.availableChatBots().map(
            (entry) => entry.persona.displayName,
          ),
          humans: [...this.humansPresent],
          roomTimeUtc: this.now().toISOString(),
        },
        [...this.transcript],
        hint,
        topicContext,
        !mustSpeak,
        direction,
        currentKnowledge,
      );
      this.inferenceBackoffMs = 0;
      this.inferencePausedUntil = 0;

      // A human may speak while an autonomous inference is in flight. Honor
      // the coordinator's yield before posting the completed bot turn.
      if (
        trigger === "autonomous" &&
        !this.topics.turnContext(
          trigger,
          this.now().getTime(),
          topicContext.learnedKnowledge,
        ).eligible
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
            this.topics.recordPass(
              this.availableChatBots().length,
              this.now().getTime(),
            );
          }

          return false;
        }

        if (trigger !== "autonomous" && this.echoesTranscript(decision.message)) {
          console.log(
            `${bot.persona.displayName} stayed silent because the message ` +
              `echoed the recent transcript.`,
          );

          return false;
        }

        if (trigger !== "autonomous" && this.clonesPattern(decision.message)) {
          console.log(
            `${bot.persona.displayName} cloned the room's sentence ` +
              `shape, staying silent: ${decision.message.slice(0, 60)}`,
          );

          return false;
        }

        const evaluated = this.topics.evaluate(
          decision,
          decision.message,
          trigger,
          this.now().getTime(),
          topicContext,
        );

        if (!evaluated.accepted || evaluated.message === undefined) {
          this.policy.recordRejected(direction.intent);
          console.log(
            `${bot.persona.displayName} stayed silent because ${evaluated.reason ?? "the topic did not advance"}.`,
          );

          if (trigger === "autonomous") {
            this.topics.recordPass(
              this.availableChatBots().length,
              this.now().getTime(),
            );
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
          this.policy.recordTurn(
            bot.persona.displayName,
            direction.intent,
            decision.topic ?? topicContext.activeTopic ?? "conversation",
            this.now().getTime(),
          );
          if (
            trigger === "autonomous" &&
            topicContext.learnedKnowledge !== undefined
          ) {
            bot.brain.markTopicUsed(
              topicContext.learnedKnowledge.topic,
              this.now().toISOString(),
            );
          }
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
        this.topics.recordPass(
          this.availableChatBots().length,
          this.now().getTime(),
        );
      }
    } catch (error) {
      this.deferForInferenceFailure(error);

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

    try {
      await this.client.postMessage(bot.actorId, content, replyTo, addressedTo);
      this.lastBotMessageAt = this.now().getTime();
      bot.lastSpokeAt = this.now().getTime();
      return true;
    } catch (error) {
      if (error instanceof PlatformError) {
        if (error.code === "actor_muted") {
          bot.muted = true;
          this.policy.recordModeration(
            bot.persona.displayName,
            this.now().getTime(),
          );
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
        this.policy.recordModeration(
          bot.persona.displayName,
          Date.parse(event.occurredAt),
        );
      } else if (event.type === "actor_unmuted") {
        bot.muted = false;
        void this.sleep(1_000, 3_000).then(() =>
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
          bot.persona.type,
          event.payload.content,
          event.occurredAt,
          this.addressesFromEvent(event.payload, event.payload.content),
        );

        if (!options.react) {
          this.topics.observeHistoricalMessage(
            bot.persona.type,
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
      const alreadyPresent = this.humansPresent.has(info.display);
      this.humansPresent.add(info.display);

      if (alreadyPresent) {
        return;
      }

      if (!options.react) {
        return;
      }

      this.topics.noteHumanMessage(this.now().getTime());

      const greetingPool = this.availableChatBots();
      const greeter = pick(greetingPool);

      if (greeter !== undefined) {
        const hint =
          `A human named ${info.display} just walked into the room. ` +
          `Greet them briefly without recapping or extending the bots' existing topic.`;
        await this.sleep(1_000, 3_000);
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
      const addresses = this.addressesFromEvent(
        event.payload,
        event.payload.content,
      );
      this.remember(
        info.display,
        info.type,
        event.payload.content,
        event.occurredAt,
        addresses,
      );

      if (info.type === "human") {
        this.policy.observeHumanMessage(
          event.payload.content,
          Date.parse(event.occurredAt),
          addresses.addressedTo[0],
        );
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
        this.humanRepliesPending += 1;

        try {
          await this.replyToHuman(
            info.display,
            event.payload.content,
            typeof event.payload.contentItemId === "string"
              ? { contentItemId: event.payload.contentItemId }
              : undefined,
            event.actorId,
          );
        } finally {
          this.humanRepliesPending -= 1;
        }
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
          ? await this.roomInterpreter.observe(await this.client.inferenceParts(parts))
          : parts
              .map((part) =>
                part.kind === "text"
                  ? part.text
                  : `[${part.kind}: ${part.caption ?? "shared media"}]`,
              )
              .join("\n");
      } catch (error) {
        this.deferForInferenceFailure(error);
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

      if (info.type === "human") {
        const addresses = this.addressesFromEvent(event.payload, content);
        this.policy.observeHumanMessage(
          content,
          Date.parse(event.occurredAt),
          addresses.addressedTo[0],
        );
      }

      if (info.type === "human" && !options.react) {
        this.topics.observeHistoricalMessage(
          "human",
          Date.parse(event.occurredAt),
        );
      }

      if (info.type === "human" && options.react) {
        this.humanRepliesPending += 1;

        try {
          await this.replyToHuman(
            info.display,
            content,
            typeof event.payload.contentItemId === "string"
              ? { contentItemId: event.payload.contentItemId }
              : undefined,
            event.actorId,
          );
        } finally {
          this.humanRepliesPending -= 1;
        }
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
    const available = this.availableChatBots();

    if (available.length === 0) {
      return;
    }

    const responsePool = available;

    const lower = content.toLowerCase();
    const greeting =
      /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))(?:\s+(?:everyone|everybody|all|folks|there))?[!.?]*\s*$/i.test(
        content,
      );
    const latest = this.transcriptEntries.at(-1);
    const addressedToRoom =
      (latest?.speaker === display &&
        latest.content === content &&
        latest.addressedToRoom) ||
      this.addressesIn(content).addressedToRoom;
    const addressedModBot = this.bots.some((entry) => {
      if (entry.persona.type !== "mod_bot") {
        return false;
      }

      const structurallyAddressed =
        latest?.speaker === display &&
        latest.content === content &&
        latest.addressedTo.includes(entry.persona.displayName);
      const namedAtStart = new RegExp(
        `^\\s*@?${entry.persona.displayName.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}\\b`,
        "i",
      ).test(content);

      return structurallyAddressed || namedAtStart;
    });

    // A message structurally addressed to a mod bot belongs to moderation.
    // Chat bots must not steal it, and this conversation engine must not make
    // the mod bot answer it as ordinary chat.
    if (addressedModBot) {
      return;
    }

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

    if (
      target === undefined &&
      !greeting &&
      !addressedToRoom &&
      responsePool.length > 1
    ) {
      try {
        const name = await this.roomInterpreter.addressee(
          responsePool.map((entry) => entry.persona.displayName),
          [...this.transcript],
          display,
          content,
        );
        target = responsePool.find(
          (entry) => entry.persona.displayName === name,
        );
      } catch (error) {
        if (this.deferForInferenceFailure(error)) {
          console.error(
            `Could not route ${display}'s message: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }

        // Routing failure falls back to an open reply.
      }
    }

    await this.sleep(350, 900);
    const first = target ?? pick(responsePool);
    const directQuestion = ConversationEngine.asksQuestion(content);
    const currentInformationFocus =
      ConversationEngine.currentInformationFocus(content);
    const addressedTo =
      humanActorId === undefined
        ? undefined
        : [{ targetType: "actor", actorId: humanActorId } satisfies ContentAddress];
    const candidates = [
      first,
      ...responsePool.filter((entry) => entry !== first),
    ];

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];

      if (candidate === undefined) {
        continue;
      }

      const currentKnowledge = currentInformationFocus === null
        ? undefined
        : await this.currentKnowledgeFor(candidate, currentInformationFocus);
      const hint = index === 0
        ? `The human ${display} just said: ${content}` +
          `${target !== undefined ? " They are speaking to you." : ""}` +
          (greeting
            ? " This is a greeting. Greet them briefly without recapping or extending the bots' existing topic."
            : directQuestion
            ? " They asked a direct question, so answer the question first."
            : " Respond to what they actually said before changing the subject.") +
          " Reply to them."
        : `The human ${display} just said: ${content} No chat bot has ` +
          `answered them yet. ${
            directQuestion ? "Answer the question first. " : ""
          }Reply to them.`;
      const spoke = await this.takeTurn(
        candidate,
        hint,
        "human",
        true,
        replyTo,
        addressedTo,
        directQuestion,
        currentKnowledge,
      );

      if (spoke) {
        return;
      }
    }
  }
}
