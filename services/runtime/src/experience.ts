import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Persona } from "./personas.js";

interface WeightedMemory {
  weight: number;
  lastSeenAt: string;
}

interface PersonMemory extends WeightedMemory {
  type: string;
}

interface ExperienceState {
  version: 1;
  handle: string;
  displayName: string;
  people: Record<string, PersonMemory>;
  interests: Record<string, WeightedMemory>;
  curiosities: Record<string, WeightedMemory>;
  responsiveTopics: Record<string, WeightedMemory>;
  quietTopics: Record<string, WeightedMemory>;
  confusingTopics: Record<string, WeightedMemory>;
  impressions: string[];
  pendingAttempt?: {
    topics: string[];
    spokenAt: string;
  };
}

interface WeightedTopic {
  topic: string;
  weight: number;
}

export interface PerceivedMessage {
  speaker: string;
  type: string;
  content: string;
  occurredAt: string;
  addressedToSelf: boolean;
  addressedToRoom: boolean;
  fromSelf: boolean;
}

const stopWords = new Set([
  "about",
  "after",
  "again",
  "because",
  "before",
  "being",
  "could",
  "every",
  "going",
  "maybe",
  "people",
  "really",
  "right",
  "should",
  "someone",
  "something",
  "their",
  "there",
  "thing",
  "think",
  "those",
  "would",
]);

const clamp = (value: number, max: number): number =>
  Math.min(max, Math.max(0, value));

const safeFilePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "_");

const topicsFrom = (content: string): string[] => {
  const counts = new Map<string, number>();

  for (const word of
    content.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
    const normalized = word.replace(/^'+|'+$/g, "");

    if (normalized.length < 5 || stopWords.has(normalized)) {
      continue;
    }

    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([word]) => word);
};

const asksQuestion = (content: string): boolean =>
  content.includes("?") ||
  /^(who|what|when|where|why|how|which|can|could|would|should|do|does|did|is|are|am|was|were|has|have|had)\b/i.test(
    content.trim(),
  );

const signalsConfusion = (content: string): boolean => {
  const text = content.toLowerCase();

  return (
    /\b(confused|confusing|unclear|lost|explain|clarify|clarification)\b/.test(
      text,
    ) ||
    /\b(what do you mean|what does that mean|i do not understand|i don't understand|not following|say more|huh)\b/.test(
      text,
    )
  );
};

export class AgentExperience {
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly state: ExperienceState,
  ) {}

  public static async load(
    directory: string,
    persona: Persona,
  ): Promise<AgentExperience> {
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${safeFilePart(persona.handle)}.json`);

    try {
      const parsed = JSON.parse(
        await readFile(filePath, "utf8"),
      ) as Partial<ExperienceState>;

      if (
        parsed.version === 1 &&
        typeof parsed.handle === "string" &&
        typeof parsed.displayName === "string" &&
        typeof parsed.people === "object" &&
        parsed.people !== null &&
        typeof parsed.interests === "object" &&
        parsed.interests !== null &&
        typeof parsed.curiosities === "object" &&
        parsed.curiosities !== null &&
        Array.isArray(parsed.impressions)
      ) {
        return new AgentExperience(filePath, {
          version: 1,
          handle: persona.handle,
          displayName: persona.displayName,
          people: parsed.people as Record<string, PersonMemory>,
          interests: parsed.interests as Record<string, WeightedMemory>,
          curiosities: parsed.curiosities as Record<string, WeightedMemory>,
          responsiveTopics:
            typeof parsed.responsiveTopics === "object" &&
            parsed.responsiveTopics !== null
              ? (parsed.responsiveTopics as Record<string, WeightedMemory>)
              : {},
          quietTopics:
            typeof parsed.quietTopics === "object" &&
            parsed.quietTopics !== null
              ? (parsed.quietTopics as Record<string, WeightedMemory>)
              : {},
          confusingTopics:
            typeof parsed.confusingTopics === "object" &&
            parsed.confusingTopics !== null
              ? (parsed.confusingTopics as Record<string, WeightedMemory>)
              : {},
          impressions: parsed.impressions.filter(
            (entry): entry is string => typeof entry === "string",
          ),
          pendingAttempt:
            typeof parsed.pendingAttempt === "object" &&
            parsed.pendingAttempt !== null &&
            Array.isArray(parsed.pendingAttempt.topics) &&
            typeof parsed.pendingAttempt.spokenAt === "string"
              ? {
                  topics: parsed.pendingAttempt.topics.filter(
                    (topic): topic is string => typeof topic === "string",
                  ),
                  spokenAt: parsed.pendingAttempt.spokenAt,
                }
              : undefined,
        });
      }
    } catch {
      // A missing or unreadable experience file starts a fresh life.
    }

    return new AgentExperience(filePath, {
      version: 1,
      handle: persona.handle,
      displayName: persona.displayName,
      people: {},
      interests: {},
      curiosities: {},
      responsiveTopics: {},
      quietTopics: {},
      confusingTopics: {},
      impressions: [],
    });
  }

  public perceive(message: PerceivedMessage): void {
    const occurredAt = Date.parse(message.occurredAt);
    const now = Number.isFinite(occurredAt)
      ? new Date(occurredAt).toISOString()
      : new Date().toISOString();
    const topics = topicsFrom(message.content);
    const attention =
      message.fromSelf || message.addressedToSelf || message.addressedToRoom
        ? 2
        : 1;

    if (message.fromSelf) {
      this.rememberAttempt(topics, now);
    } else {
      this.readAttemptOutcome(message, topics, now);
      const person = this.state.people[message.speaker] ?? {
        type: message.type,
        weight: 0,
        lastSeenAt: now,
      };
      person.type = message.type;
      person.weight = clamp(person.weight + attention, 100);
      person.lastSeenAt = now;
      this.state.people[message.speaker] = person;
    }

    for (const topic of topics) {
      const memory = this.state.interests[topic] ?? {
        weight: 0,
        lastSeenAt: now,
      };
      memory.weight = clamp(memory.weight + attention, 100);
      memory.lastSeenAt = now;
      this.state.interests[topic] = memory;

      if (asksQuestion(message.content) && !message.fromSelf) {
        const curiosity = this.state.curiosities[topic] ?? {
          weight: 0,
          lastSeenAt: now,
        };
        curiosity.weight = clamp(curiosity.weight + 2, 100);
        curiosity.lastSeenAt = now;
        this.state.curiosities[topic] = curiosity;
      }
    }

    if (topics.length > 0) {
      const address =
        message.addressedToSelf
          ? " to me"
          : message.addressedToRoom
            ? " to the room"
            : "";
      const impression = message.fromSelf
        ? `I talked about ${topics.join(", ")}.`
        : `${message.speaker} talked${address} about ${topics.join(", ")}.`;
      this.state.impressions.push(impression);
    }

    while (this.state.impressions.length > 40) {
      this.state.impressions.shift();
    }

    this.fade(now);
    this.saveSoon();
  }

  public view(): string {
    const familiarPeople = this.top(this.state.people, 5);
    const interests = this.top(this.state.interests, 8);
    const curiosities = this.top(this.state.curiosities, 5);
    const responsiveTopics = this.top(this.state.responsiveTopics, 4);
    const quietTopics = this.top(this.state.quietTopics, 4);
    const confusingTopics = this.top(this.state.confusingTopics, 4);
    const impressions = this.state.impressions.slice(-8);
    const lines = [
      familiarPeople.length === 0
        ? "People feel mostly unfamiliar so far."
        : `People I am becoming familiar with: ${familiarPeople.join(", ")}.`,
      interests.length === 0
        ? "My interests are still forming from the room."
        : `Topics I have been drawn toward: ${interests.join(", ")}.`,
      curiosities.length === 0
        ? "I do not have a strong curiosity gap right now."
        : `Things I am curious about: ${curiosities.join(", ")}.`,
      responsiveTopics.length === 0
        ? "I am still learning what gets people talking."
        : `Topics that have drawn replies: ${responsiveTopics.join(", ")}.`,
      quietTopics.length === 0
        ? "I do not have a strong sense of topics that fall flat yet."
        : `Topics that have often gone quiet: ${quietTopics.join(", ")}.`,
      confusingTopics.length === 0
        ? "I do not have a strong sense of what I have made confusing yet."
        : `Topics I may need to explain more clearly: ${confusingTopics.join(", ")}.`,
      impressions.length === 0
        ? "I do not have many lived impressions from this room yet."
        : `Recent impressions: ${impressions.join(" ")}`,
    ];

    return lines.join("\n");
  }

  public openTurnImpulse(): string | null {
    const confusing = this.weightedTop(this.state.confusingTopics, 1)[0];

    if (confusing !== undefined && confusing.weight >= 2) {
      return (
        `Something about ${confusing.topic} may have confused people. ` +
        `If the conversation allows it, repair it plainly from your own ` +
        `point of view. If it no longer fits, pass.`
      );
    }

    const curiosity = this.weightedTop(this.state.curiosities, 1)[0];

    if (curiosity !== undefined && curiosity.weight >= 4) {
      return (
        `Your own curiosity keeps returning to ${curiosity.topic}. ` +
        `If it fits the room, ask about it naturally or connect it to what ` +
        `people have been saying. If it does not fit, pass.`
      );
    }

    const interest =
      this.weightedTop(this.state.responsiveTopics, 1)[0] ??
      this.weightedTop(this.state.interests, 1)[0];

    if (interest !== undefined && interest.weight >= 6) {
      return (
        `You have become familiar with ${interest.topic} in this room. ` +
        `If the conversation is open, you may bring it up from your own ` +
        `point of view. If the timing is wrong, pass.`
      );
    }

    return null;
  }

  public async flush(): Promise<void> {
    await this.saveChain;
  }

  private top(
    entries: Record<string, WeightedMemory>,
    limit: number,
  ): string[] {
    return this.weightedTop(entries, limit).map((entry) => entry.topic);
  }

  private weightedTop(
    entries: Record<string, WeightedMemory>,
    limit: number,
  ): WeightedTopic[] {
    return Object.entries(entries)
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([topic, memory]) => ({ topic, weight: memory.weight }));
  }

  private fade(now: string): void {
    for (const bucket of [
      this.state.people,
      this.state.interests,
      this.state.curiosities,
      this.state.responsiveTopics,
      this.state.quietTopics,
      this.state.confusingTopics,
    ]) {
      for (const [key, memory] of Object.entries(bucket)) {
        memory.weight = clamp(memory.weight * 0.995, 100);

        if (memory.weight < 0.2) {
          delete bucket[key];
        } else {
          memory.lastSeenAt = memory.lastSeenAt || now;
        }
      }
    }
  }

  private rememberAttempt(topics: string[], now: string): void {
    if (topics.length === 0) {
      this.state.pendingAttempt = undefined;
      return;
    }

    this.state.pendingAttempt = {
      topics,
      spokenAt: now,
    };
  }

  private readAttemptOutcome(
    message: PerceivedMessage,
    topics: string[],
    now: string,
  ): void {
    const attempt = this.state.pendingAttempt;

    if (attempt === undefined) {
      return;
    }

    const ageMs = Date.parse(now) - Date.parse(attempt.spokenAt);

    if (!Number.isFinite(ageMs)) {
      this.state.pendingAttempt = undefined;
      return;
    }

    const overlap = attempt.topics.filter((topic) =>
      topics.includes(topic),
    );
    const confused =
      ageMs <= 5 * 60_000 &&
      signalsConfusion(message.content) &&
      (message.addressedToSelf ||
        message.addressedToRoom ||
        overlap.length > 0 ||
        asksQuestion(message.content));
    const responded =
      ageMs <= 5 * 60_000 &&
      (message.addressedToSelf ||
        message.addressedToRoom ||
        overlap.length > 0);

    if (confused) {
      for (const topic of overlap.length === 0 ? attempt.topics : overlap) {
        this.bump(this.state.confusingTopics, topic, 4, now);
        this.bump(this.state.curiosities, topic, 1, now);
      }

      this.state.impressions.push(
        `My last point may have confused the room around ${
          (overlap.length === 0 ? attempt.topics : overlap).join(", ")
        }.`,
      );
      this.state.pendingAttempt = undefined;
      return;
    }

    if (responded) {
      for (const topic of overlap.length === 0 ? attempt.topics : overlap) {
        this.bump(this.state.responsiveTopics, topic, 3, now);
        this.bump(this.state.interests, topic, 1, now);

        if (this.state.curiosities[topic] !== undefined) {
          this.state.curiosities[topic].weight = clamp(
            this.state.curiosities[topic].weight - 2,
            100,
          );
        }
      }

      this.state.pendingAttempt = undefined;
      return;
    }

    if (ageMs > 5 * 60_000) {
      for (const topic of attempt.topics) {
        this.bump(this.state.quietTopics, topic, 2, now);
      }

      this.state.pendingAttempt = undefined;
    }
  }

  private bump(
    bucket: Record<string, WeightedMemory>,
    topic: string,
    amount: number,
    now: string,
  ): void {
    const memory = bucket[topic] ?? {
      weight: 0,
      lastSeenAt: now,
    };
    memory.weight = clamp(memory.weight + amount, 100);
    memory.lastSeenAt = now;
    bucket[topic] = memory;
  }

  private saveSoon(): void {
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() =>
        writeFile(
          this.filePath,
          `${JSON.stringify(this.state, null, 2)}\n`,
          "utf8",
        ),
      )
      .catch((error) => {
        console.error(
          `Could not preserve ${this.state.displayName}'s experience: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
