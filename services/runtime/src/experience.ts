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
  version: 2;
  handle: string;
  displayName: string;
  people: Record<string, PersonMemory>;
  impressions: string[];
  responsiveMoments: string[];
  confusingMoments: string[];
  quietMoments: string[];
  pendingAttempt?: {
    content: string;
    spokenAt: string;
  };
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

const clamp = (value: number, max: number): number =>
  Math.min(max, Math.max(0, value));

const safeFilePart = (value: string): string =>
  value.replace(/[^A-Za-z0-9._-]/g, "_");

const excerpt = (content: string): string => {
  const flattened = content.replace(/\s+/g, " ").trim();

  return flattened.length <= 220
    ? flattened
    : `${flattened.slice(0, 217).trimEnd()}...`;
};

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

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

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
      ) as Record<string, unknown>;
      const people =
        typeof parsed.people === "object" && parsed.people !== null
          ? (parsed.people as Record<string, PersonMemory>)
          : {};

      if (parsed.version === 2) {
        const pending = parsed.pendingAttempt as
          | Record<string, unknown>
          | undefined;

        return new AgentExperience(filePath, {
          version: 2,
          handle: persona.handle,
          displayName: persona.displayName,
          people,
          impressions: stringList(parsed.impressions),
          responsiveMoments: stringList(parsed.responsiveMoments),
          confusingMoments: stringList(parsed.confusingMoments),
          quietMoments: stringList(parsed.quietMoments),
          pendingAttempt:
            pending !== undefined &&
            typeof pending.content === "string" &&
            typeof pending.spokenAt === "string"
              ? { content: pending.content, spokenAt: pending.spokenAt }
              : undefined,
        });
      }

      // Version 1 stored guessed topic words, including in impressions.
      // Preserve familiar people, but let room replay rebuild real moments.
      if (parsed.version === 1) {
        return new AgentExperience(filePath, {
          version: 2,
          handle: persona.handle,
          displayName: persona.displayName,
          people,
          impressions: [],
          responsiveMoments: [],
          confusingMoments: [],
          quietMoments: [],
        });
      }
    } catch {
      // A missing or unreadable experience file starts a fresh life.
    }

    return new AgentExperience(filePath, {
      version: 2,
      handle: persona.handle,
      displayName: persona.displayName,
      people: {},
      impressions: [],
      responsiveMoments: [],
      confusingMoments: [],
      quietMoments: [],
    });
  }

  public perceive(message: PerceivedMessage): void {
    const occurredAt = Date.parse(message.occurredAt);
    const now = Number.isFinite(occurredAt)
      ? new Date(occurredAt).toISOString()
      : new Date().toISOString();
    const attention =
      message.fromSelf || message.addressedToSelf || message.addressedToRoom
        ? 2
        : 1;

    if (message.fromSelf) {
      this.state.pendingAttempt = {
        content: excerpt(message.content),
        spokenAt: now,
      };
    } else {
      this.readAttemptOutcome(message, now);
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

    const address = message.addressedToSelf
      ? " to me"
      : message.addressedToRoom
        ? " to the room"
        : "";
    const impression = message.fromSelf
      ? `I said: "${excerpt(message.content)}"`
      : `${message.speaker} said${address}: "${excerpt(message.content)}"`;
    this.remember(this.state.impressions, impression, 40);

    this.fadePeople();
    this.saveSoon();
  }

  public view(): string {
    const familiarPeople = Object.entries(this.state.people)
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([person]) => person);
    const impressions = this.state.impressions.slice(-10);
    const responsive = this.state.responsiveMoments.slice(-4);
    const confusing = this.state.confusingMoments.slice(-3);
    const quiet = this.state.quietMoments.slice(-3);
    const lines = [
      familiarPeople.length === 0
        ? "People feel mostly unfamiliar so far."
        : `People I am becoming familiar with: ${familiarPeople.join(", ")}.`,
      impressions.length === 0
        ? "I do not have many lived impressions from this room yet."
        : `Recent lived moments:\n- ${impressions.join("\n- ")}`,
      responsive.length === 0
        ? "I am still learning what gets people talking."
        : `Exchanges that drew a response:\n- ${responsive.join("\n- ")}`,
      confusing.length === 0
        ? "I do not have a recent confusing exchange to repair."
        : `Exchanges that may need a clearer explanation:\n- ${confusing.join("\n- ")}`,
      quiet.length === 0
        ? "I do not have a strong recent example of a subject falling flat."
        : `Things I said that did not draw a response:\n- ${quiet.join("\n- ")}`,
    ];

    return lines.join("\n");
  }

  public async flush(): Promise<void> {
    await this.saveChain;
  }

  private readAttemptOutcome(message: PerceivedMessage, now: string): void {
    const attempt = this.state.pendingAttempt;

    if (attempt === undefined) {
      return;
    }

    const ageMs = Date.parse(now) - Date.parse(attempt.spokenAt);

    if (!Number.isFinite(ageMs)) {
      this.state.pendingAttempt = undefined;
      return;
    }

    const response = `${message.speaker} replied: "${excerpt(message.content)}"`;
    const addressed = message.addressedToSelf || message.addressedToRoom;

    if (ageMs <= 5 * 60_000 && addressed && signalsConfusion(message.content)) {
      this.remember(
        this.state.confusingMoments,
        `I said "${attempt.content}". ${response}`,
        12,
      );
      this.state.pendingAttempt = undefined;
      return;
    }

    if (ageMs <= 5 * 60_000 && addressed) {
      this.remember(
        this.state.responsiveMoments,
        `I said "${attempt.content}". ${response}`,
        16,
      );
      this.state.pendingAttempt = undefined;
      return;
    }

    if (ageMs > 5 * 60_000) {
      this.remember(this.state.quietMoments, `I said "${attempt.content}".`, 12);
      this.state.pendingAttempt = undefined;
    }
  }

  private remember(bucket: string[], value: string, limit: number): void {
    bucket.push(value);

    while (bucket.length > limit) {
      bucket.shift();
    }
  }

  private fadePeople(): void {
    for (const [person, memory] of Object.entries(this.state.people)) {
      memory.weight = clamp(memory.weight * 0.995, 100);

      if (memory.weight < 0.2) {
        delete this.state.people[person];
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
