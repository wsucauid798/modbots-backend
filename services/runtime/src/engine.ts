import type { Mind } from "./mind.js";
import type { Persona } from "./personas.js";
import { PlatformError } from "./platform.js";
import type { PlatformClient } from "./platform.js";
import type { ContentAddress, RoomEvent } from "./platform.js";
import type { RoomContentPart } from "./platform.js";
import type { AgentExperience } from "./experience.js";

type ConversationPlatform = Pick<
  PlatformClient,
  "getActor" | "inferenceParts" | "join" | "postMessage"
>;
type ConversationMind = Pick<Mind, "addressee" | "consider" | "observe">;
type ConversationExperience = Pick<
  AgentExperience,
  "openTurnImpulse" | "perceive" | "view"
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

  public constructor(
    private readonly client: ConversationPlatform,
    private readonly mind: ConversationMind,
    private readonly tempo: number,
    bots: Array<{
      persona: Persona;
      actorId: string;
      experience: ConversationExperience;
    }>,
  ) {
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

  private activeBots(): BotState[] {
    return this.bots.filter((bot) => !bot.muted);
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
    addresses?: { addressedTo: string[]; addressedToRoom: boolean },
  ): void {
    const resolvedAddresses = addresses ?? this.addressesIn(content);
    this.transcript.push(`${display}: ${content}`);
    this.transcriptEntries.push({
      speaker: display,
      type,
      content,
      occurredAt: Date.now(),
      ...resolvedAddresses,
    });

    for (const bot of this.bots) {
      bot.experience.perceive({
        speaker: display,
        type,
        content,
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

  // Detects the conversation circling: most of the recent messages sharing
  // an opener or a closer means the room is stuck on one shape, and the
  // next speaker should be told to move on rather than fed more of it.
  private conversationCircling(): boolean {
    const recents = this.recentContents(4);

    if (recents.length < 4) {
      return false;
    }

    const openers = new Map<string, number>();
    const closers = new Map<string, number>();

    for (const recent of recents) {
      const words = ConversationEngine.normalizedWords(recent);

      if (words.length === 0) {
        continue;
      }

      openers.set(words[0], (openers.get(words[0]) ?? 0) + 1);
      closers.set(
        words[words.length - 1],
        (closers.get(words[words.length - 1]) ?? 0) + 1,
      );
    }

    return (
      Math.max(0, ...openers.values()) >= 3 ||
      Math.max(0, ...closers.values()) >= 3
    );
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

  private guidanceForOpenTurn(bot: BotState): string | null {
    const unanswered = this.recentHumanQuestionWithoutBotReply();

    if (
      unanswered !== undefined &&
      Date.now() - unanswered.occurredAt < 90_000
    ) {
      return (
        `${unanswered.speaker} asked a question and no resident has answered ` +
        `yet: ${unanswered.content} Answer it directly first, then add at ` +
        `most one small thought of your own.`
      );
    }

    if (this.conversationCircling()) {
      return (
        "The conversation has been circling the same thing. Change the " +
        "subject to something completely new."
      );
    }

    const last = this.transcriptEntries.at(-1);

    if (last?.type === "chat_bot" && Date.now() - last.occurredAt < 45_000) {
      return (
        `${last.speaker} just spoke. Do not simply agree with them. Add a ` +
        `different angle, ask a useful follow-up, or pass.`
      );
    }

    return bot.experience.openTurnImpulse();
  }

  private addressedBot(content: string): BotState | undefined {
    const addresses = this.addressesIn(content);

    if (addresses.addressedTo.length === 0) {
      return undefined;
    }

    return this.activeBots().find((bot) =>
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
      await this.sleep(25_000, 70_000);

      const candidates = this.activeBots();

      if (candidates.length === 0) {
        continue;
      }

      // The quietest residents get their turn first, with some chance.
      candidates.sort((a, b) => a.lastSpokeAt - b.lastSpokeAt);
      const bot = Math.random() < 0.7 ? candidates[0] : pick(candidates);

      await this.takeTurn(bot, this.guidanceForOpenTurn(bot));
    }
  }

  private async takeTurn(
    bot: BotState,
    hint: string | null,
    mustSpeak = false,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
  ): Promise<boolean> {
    if (bot.muted || this.stopped) {
      return false;
    }

    try {
      const decision = await this.mind.consider(
        bot.persona,
        {
          residents: this.bots.map((entry) => entry.persona.displayName),
          humans: [...this.humansPresent],
        },
        [...this.transcript],
        bot.experience.view(),
        hint,
        !mustSpeak,
      );

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
          return false;
        }

        if (this.echoesTranscript(decision.message)) {
          if (hint !== null) {
            console.log(
              `${bot.persona.displayName} echoed the transcript on a ` +
                `hinted turn: ${hint.slice(0, 80)}`,
            );
          }

          return false;
        }

        if (this.clonesPattern(decision.message)) {
          console.log(
            `${bot.persona.displayName} cloned the room's sentence ` +
              `shape, staying silent: ${decision.message.slice(0, 60)}`,
          );
          return false;
        }

        await this.say(bot, decision.message, replyTo, addressedTo);
        return true;
      }

      if (hint !== null) {
        console.log(
          `${bot.persona.displayName} passed on a hinted turn: ` +
            hint.slice(0, 80),
        );
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
  ): Promise<void> {
    if (bot.muted || this.stopped) {
      return;
    }

    // Never talk over another resident.
    const sinceLast = Date.now() - this.lastBotMessageAt;
    const minimumGap = 6_000 * this.tempo;

    if (sinceLast < minimumGap) {
      await new Promise((resolve) =>
        setTimeout(resolve, minimumGap - sinceLast),
      );
    }

    try {
      await this.client.postMessage(bot.actorId, content, replyTo, addressedTo);
      this.lastBotMessageAt = Date.now();
      bot.lastSpokeAt = Date.now();
    } catch (error) {
      if (error instanceof PlatformError) {
        if (error.code === "actor_muted") {
          bot.muted = true;
          return;
        }

        if (error.code === "actor_not_in_room") {
          await this.client.join(bot.actorId);
          await this.client.postMessage(
            bot.actorId,
            content,
            replyTo,
            addressedTo,
          );
          this.lastBotMessageAt = Date.now();
          bot.lastSpokeAt = Date.now();
          return;
        }
      }

      console.error(
        `${bot.persona.displayName} could not speak: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
          this.addressesFromEvent(event.payload, event.payload.content),
        );
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

      const greeter = pick(this.activeBots());

      if (greeter !== undefined) {
        const hint = `A human named ${info.display} just walked into the room. Greet them.`;
        await this.sleep(5_000, 14_000);
        const addressedTo: ContentAddress[] = [
          { targetType: "actor", actorId: event.actorId },
        ];

        const spoke = await this.takeTurn(
          greeter,
          hint,
          true,
          undefined,
          addressedTo,
        );

        if (!spoke) {
          const second = pick(
            this.activeBots().filter((entry) => entry !== greeter),
          );

          if (second !== undefined) {
            await this.takeTurn(second, hint, true, undefined, addressedTo);
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
        this.addressesFromEvent(event.payload, event.payload.content),
      );

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
        this.addressesFromEvent(event.payload, content),
      );

      if (info.type === "human" && options.react) {
        this.humansPresent.add(info.display);
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
    const active = this.activeBots();

    if (active.length === 0) {
      return;
    }

    const lower = content.toLowerCase();
    const latest = this.transcriptEntries.at(-1);
    let target = active.find(
      (entry) =>
        latest?.speaker === display &&
        latest.content === content &&
        latest.addressedTo.includes(entry.persona.displayName),
    );
    target ??= active.find((entry) =>
      lower.includes(entry.persona.displayName.toLowerCase()),
    );
    target = target ?? this.addressedBot(content);

    if (target === undefined) {
      try {
        const name = await this.mind.addressee(
          active.map((entry) => entry.persona.displayName),
          [...this.transcript],
          display,
          content,
        );
        target = active.find((entry) => entry.persona.displayName === name);
      } catch {
        // Routing failure falls back to an open reply.
      }
    }

    await this.sleep(3_000, 9_000);
    const first = target ?? pick(active);
    const directQuestion = ConversationEngine.asksQuestion(content);
    const addressedTo =
      humanActorId === undefined
        ? undefined
        : [{ targetType: "actor", actorId: humanActorId } satisfies ContentAddress];
    const spoke = await this.takeTurn(
      first,
      `The human ${display} just said: ${content}` +
        `${target !== undefined ? " They are speaking to you." : ""}` +
        (directQuestion
          ? " They asked a direct question, so answer the question first."
          : " Respond to what they actually said before changing the subject.") +
        ` Reply to them.`,
      false,
      replyTo,
      addressedTo,
    );

    if (!spoke) {
      const second = pick(active.filter((entry) => entry !== first));

      if (second !== undefined) {
        await this.takeTurn(
          second,
          `The human ${display} just said: ${content} No one has answered ` +
            `them yet. Reply to them.`,
          true,
          replyTo,
          addressedTo,
        );
      }
    }
  }
}
