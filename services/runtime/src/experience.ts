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
  impressions: string[];
}

export interface PerceivedMessage {
  speaker: string;
  type: string;
  content: string;
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
          impressions: parsed.impressions.filter(
            (entry): entry is string => typeof entry === "string",
          ),
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
      impressions: [],
    });
  }

  public perceive(message: PerceivedMessage): void {
    const now = new Date().toISOString();
    const attention =
      message.fromSelf || message.addressedToSelf || message.addressedToRoom
        ? 2
        : 1;

    if (!message.fromSelf) {
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

    const topics = topicsFrom(message.content);

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
      impressions.length === 0
        ? "I do not have many lived impressions from this room yet."
        : `Recent impressions: ${impressions.join(" ")}`,
    ];

    return lines.join("\n");
  }

  public async flush(): Promise<void> {
    await this.saveChain;
  }

  private top(
    entries: Record<string, WeightedMemory>,
    limit: number,
  ): string[] {
    return Object.entries(entries)
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([key]) => key);
  }

  private fade(now: string): void {
    for (const bucket of [
      this.state.people,
      this.state.interests,
      this.state.curiosities,
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
