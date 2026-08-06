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

export interface KnowledgeSource {
  title: string;
  url: string;
}

export interface LearnedKnowledge {
  topic: string;
  statement: string;
  confidence: number;
  sources: KnowledgeSource[];
  curiosity?: string;
  learningValue?: string;
}

export interface ResearchDirection {
  kind:
    | "participant_question"
    | "participant_subject"
    | "deepen"
    | "public_subject";
  focus: string;
  reason: string;
}

interface KnowledgeMemory extends LearnedKnowledge {
  learnedAt: string;
  lastRecalledAt: string;
  recallCount: number;
  lastUsedAt?: string;
  useCount: number;
  researchCount: number;
}

interface Episode {
  speaker: string;
  type: string;
  content: string;
  occurredAt: string;
  salience: number;
}

interface Curiosity {
  question: string;
  subject: string;
  createdAt: string;
  weight: number;
}

interface BrainState {
  version: 3;
  handle: string;
  displayName: string;
  people: Record<string, PersonMemory>;
  workingMemory: Episode[];
  episodes: Episode[];
  knowledge: KnowledgeMemory[];
  curiosities: Curiosity[];
  lastResearchAt?: string;
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
  followedSelf?: boolean;
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

// Reduce plural forms so "potatoes" matches "potato" across topic labels,
// knowledge statements, and room messages.
const stem = (word: string): string => {
  let normalized = word;

  if (
    normalized.length > 8 &&
    (normalized.startsWith("over") || normalized.startsWith("under"))
  ) {
    normalized = normalized.startsWith("over")
      ? normalized.slice(4)
      : normalized.slice(5);
  }

  if (normalized.length > 5 && normalized.endsWith("ing")) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.length > 4 && normalized.endsWith("ed")) {
    normalized = normalized.slice(0, -2);
  }

  if (normalized.length > 4 && normalized.endsWith("ies")) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (normalized.length > 4 && normalized.endsWith("oes")) {
    return normalized.slice(0, -2);
  }

  if (
    normalized.length > 3 &&
    normalized.endsWith("s") &&
    !normalized.endsWith("ss")
  ) {
    return normalized.slice(0, -1);
  }

  return normalized;
};

const words = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter(
        (word) =>
          !new Set([
            "about",
            "after",
            "again",
            "because",
            "been",
            "before",
            "could",
            "from",
            "have",
            "into",
            "just",
            "more",
            "that",
            "their",
            "there",
            "they",
            "this",
            "what",
            "when",
            "where",
            "which",
            "with",
            "would",
          ]).has(word),
      )
      .map(stem) ?? [],
  );

const relevance = (query: Set<string>, value: string): number => {
  if (query.size === 0) {
    return 0;
  }

  const candidate = words(value);
  let matches = 0;
  for (const word of query) {
    if (candidate.has(word)) {
      matches += 1;
    }
  }
  return matches / query.size;
};

const relatedness = (left: string, right: string): number =>
  Math.max(relevance(words(left), right), relevance(words(right), left));

const knowledgeText = (content: string): string => {
  const flattened = content.replace(/\s+/g, " ").trim();
  return flattened.length <= 1_800
    ? flattened
    : `${flattened.slice(0, 1_797).trimEnd()}...`;
};

const isSubstantiveRoomSubject = (content: string): boolean => {
  const flattened = content.replace(/\s+/g, " ").trim();

  return (
    words(flattened).size >= 4 &&
    !/^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening)|thanks?|thank\s+you|bye)[!.?]*\s*$/i.test(
      flattened,
    )
  );
};

const cleanSources = (value: unknown): KnowledgeSource[] =>
  Array.isArray(value)
    ? value.flatMap((entry): KnowledgeSource[] => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const source = entry as Record<string, unknown>;
        return typeof source.title === "string" &&
          typeof source.url === "string" &&
          /^https?:\/\//i.test(source.url)
          ? [{ title: source.title, url: source.url }]
          : [];
      })
    : [];

const cleanEpisodes = (value: unknown): Episode[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Episode[] => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const episode = entry as Record<string, unknown>;
        return typeof episode.speaker === "string" &&
          typeof episode.type === "string" &&
          typeof episode.content === "string" &&
          typeof episode.occurredAt === "string" &&
          typeof episode.salience === "number"
          ? [episode as unknown as Episode]
          : [];
      })
    : [];

const cleanKnowledge = (value: unknown): KnowledgeMemory[] =>
  Array.isArray(value)
    ? value.flatMap((entry): KnowledgeMemory[] => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const memory = entry as Record<string, unknown>;
        return typeof memory.topic === "string" &&
          typeof memory.statement === "string" &&
          typeof memory.confidence === "number" &&
          typeof memory.learnedAt === "string" &&
          typeof memory.lastRecalledAt === "string" &&
          typeof memory.recallCount === "number"
          ? [
              {
                topic: memory.topic,
                statement: memory.statement,
                confidence: clamp(memory.confidence, 1),
                sources: cleanSources(memory.sources),
                learnedAt: memory.learnedAt,
                lastRecalledAt: memory.lastRecalledAt,
                recallCount: Math.max(0, memory.recallCount),
                lastUsedAt:
                  typeof memory.lastUsedAt === "string"
                    ? memory.lastUsedAt
                    : undefined,
                curiosity:
                  typeof memory.curiosity === "string"
                    ? memory.curiosity
                    : undefined,
                learningValue:
                  typeof memory.learningValue === "string"
                    ? memory.learningValue
                    : undefined,
                useCount:
                  typeof memory.useCount === "number"
                    ? Math.max(0, memory.useCount)
                    : 0,
                researchCount:
                  typeof memory.researchCount === "number"
                    ? Math.max(1, memory.researchCount)
                    : 1,
              },
            ]
          : [];
      })
    : [];

const cleanCuriosities = (value: unknown): Curiosity[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Curiosity[] => {
        if (typeof entry !== "object" || entry === null) {
          return [];
        }
        const curiosity = entry as Record<string, unknown>;
        return typeof curiosity.question === "string" &&
          typeof curiosity.subject === "string" &&
          typeof curiosity.createdAt === "string" &&
          typeof curiosity.weight === "number"
          ? [curiosity as unknown as Curiosity]
          : [];
      })
    : [];

export class AgentBrain {
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private readonly state: BrainState,
  ) {}

  public static async load(
    directory: string,
    persona: Persona,
  ): Promise<AgentBrain> {
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

      if (parsed.version === 3) {
        const pending = parsed.pendingAttempt as
          | Record<string, unknown>
          | undefined;

        return new AgentBrain(filePath, {
          version: 3,
          handle: persona.handle,
          displayName: persona.displayName,
          people,
          workingMemory: cleanEpisodes(parsed.workingMemory).slice(-24),
          episodes: cleanEpisodes(parsed.episodes).slice(-240),
          knowledge: cleanKnowledge(parsed.knowledge).slice(-160),
          curiosities: cleanCuriosities(parsed.curiosities).slice(-40),
          lastResearchAt:
            typeof parsed.lastResearchAt === "string"
              ? parsed.lastResearchAt
              : undefined,
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

      if (parsed.version === 2) {
        const pending = parsed.pendingAttempt as
          | Record<string, unknown>
          | undefined;

        return new AgentBrain(filePath, {
          version: 3,
          handle: persona.handle,
          displayName: persona.displayName,
          people,
          workingMemory: [],
          episodes: [],
          knowledge: [],
          curiosities: [],
          lastResearchAt: undefined,
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
        return new AgentBrain(filePath, {
          version: 3,
          handle: persona.handle,
          displayName: persona.displayName,
          people,
          workingMemory: [],
          episodes: [],
          knowledge: [],
          curiosities: [],
          lastResearchAt: undefined,
          impressions: [],
          responsiveMoments: [],
          confusingMoments: [],
          quietMoments: [],
        });
      }
    } catch {
      // A missing or unreadable experience file starts a fresh life.
    }

    return new AgentBrain(filePath, {
      version: 3,
      handle: persona.handle,
      displayName: persona.displayName,
      people: {},
      workingMemory: [],
      episodes: [],
      knowledge: [],
      curiosities: [],
      lastResearchAt: undefined,
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
      message.fromSelf ||
      message.addressedToSelf ||
      message.addressedToRoom ||
      message.followedSelf
        ? 2
        : 1;
    const episode: Episode = {
      speaker: message.speaker,
      type: message.type,
      content: excerpt(message.content),
      occurredAt: now,
      salience: attention,
    };

    this.state.workingMemory.push(episode);
    this.state.workingMemory.splice(
      0,
      Math.max(0, this.state.workingMemory.length - 24),
    );

    if (attention > 1 || message.type === "human") {
      this.state.episodes.push(episode);
      this.state.episodes.splice(
        0,
        Math.max(0, this.state.episodes.length - 240),
      );
    }

    if (!message.fromSelf && /\?\s*$/.test(message.content.trim())) {
      this.rememberCuriosity({
        question: excerpt(message.content),
        subject: message.speaker,
        createdAt: now,
        weight: attention,
      });
    }

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

  public researchDirection(excludedTopics: string[] = []): ResearchDirection {
    const participantSubject = [...this.state.workingMemory]
      .reverse()
      .find(
        (episode) =>
          episode.speaker !== this.state.displayName &&
          // Only a human's subject is worth a participant-driven search.
          // Bot questions are generated chatter: researching them feeds the
          // room's own words back into every brain until the whole room
          // circles one subject forever.
          episode.type === "human" &&
          isSubstantiveRoomSubject(episode.content) &&
          // A subject the room already talked through is not a knowledge
          // gap either, even when a human brings it back up.
          excludedTopics.every(
            (topic) => relatedness(episode.content, topic) < 0.3,
          ) &&
          this.state.knowledge.every(
            (memory) =>
              relatedness(
                episode.content,
                `${memory.topic} ${memory.statement}`,
              ) < 0.35,
          ),
      );

    if (participantSubject !== undefined) {
      return {
        kind: "participant_subject",
        focus: excerpt(participantSubject.content),
        reason:
          `${participantSubject.speaker} raised this subject in the chatroom and this brain does not yet know enough to understand it well.`,
      };
    }

    const openQuestion = [...this.state.curiosities]
      .sort(
        (left, right) =>
          right.weight - left.weight ||
          Date.parse(right.createdAt) - Date.parse(left.createdAt),
      )
      .find((curiosity) => {
        const memory = this.state.knowledge.find(
          (candidate) =>
            relatedness(curiosity.subject, candidate.topic) >= 0.7,
        );
        return memory !== undefined && memory.researchCount < 3;
      });

    if (openQuestion !== undefined) {
      return {
        kind: "deepen",
        focus: `${openQuestion.subject}: ${openQuestion.question}`,
        reason:
          "This is an unresolved question from existing knowledge, so answering it will deepen understanding instead of collecting another disconnected fact.",
      };
    }

    return {
      kind: "public_subject",
      focus:
        "A consequential subject people are currently discussing in public",
      reason:
        "The brain has no unresolved room subject or useful follow-up question, so it should broaden into a real subject with current human significance.",
    };
  }

  public learn(
    learned: LearnedKnowledge,
    learnedAt = new Date().toISOString(),
    direction?: ResearchDirection,
  ): void {
    const topic = learned.topic.replace(/\s+/g, " ").trim().slice(0, 120);
    const statement = knowledgeText(learned.statement);
    const sources = cleanSources(learned.sources).slice(0, 8);

    if (topic.length === 0 || statement.length === 0 || sources.length === 0) {
      return;
    }

    const directedExisting =
      direction?.kind === "deepen"
        ? this.state.knowledge.find(
            (memory) =>
              relatedness(direction.focus, memory.topic) >= 0.5,
          )
        : undefined;
    const existing =
      directedExisting ??
      this.state.knowledge.find(
        (memory) =>
          relatedness(topic, memory.topic) >= 0.8 ||
          relatedness(statement, memory.statement) >= 0.8,
      );

    if (existing === undefined) {
      this.state.knowledge.push({
        topic,
        statement,
        confidence: clamp(learned.confidence, 1),
        sources,
        learnedAt,
        lastRecalledAt: learnedAt,
        recallCount: 0,
        lastUsedAt: undefined,
        useCount: 0,
        researchCount: 1,
        curiosity: learned.curiosity?.trim()
          ? excerpt(learned.curiosity)
          : undefined,
        learningValue: learned.learningValue?.trim()
          ? excerpt(learned.learningValue)
          : undefined,
      });
    } else {
      existing.statement =
        direction?.kind === "deepen"
          ? knowledgeText(`${existing.statement} ${statement}`)
          : statement;
      existing.confidence = clamp(
        Math.max(existing.confidence, learned.confidence),
        1,
      );
      existing.sources = cleanSources([...existing.sources, ...sources]).slice(-8);
      existing.learnedAt = learnedAt;
      existing.researchCount += 1;
      existing.curiosity = learned.curiosity?.trim()
        ? excerpt(learned.curiosity)
        : existing.curiosity;
      existing.learningValue = learned.learningValue?.trim()
        ? excerpt(learned.learningValue)
        : existing.learningValue;
    }

    if (direction?.kind === "deepen") {
      const selected = words(direction.focus);
      this.state.curiosities = this.state.curiosities.filter(
        (curiosity) =>
          Math.max(
            relevance(selected, `${curiosity.subject} ${curiosity.question}`),
            relevance(
              words(`${curiosity.subject} ${curiosity.question}`),
              direction.focus,
            ),
          ) < 0.5,
      );
    }

    if (learned.curiosity?.trim()) {
      this.rememberCuriosity({
        question: excerpt(learned.curiosity),
        subject: topic,
        createdAt: learnedAt,
        weight: 3,
      });
    }

    this.state.lastResearchAt = learnedAt;

    this.state.knowledge.splice(
      0,
      Math.max(0, this.state.knowledge.length - 160),
    );
    this.saveSoon();
  }

  public canResearch(now: number, cooldownMs: number): boolean {
    const last = Date.parse(this.state.lastResearchAt ?? "");
    return !Number.isFinite(last) || now - last >= cooldownMs;
  }

  public recordResearchAttempt(now: string): void {
    this.state.lastResearchAt = now;
    this.saveSoon();
  }

  public topicForConversation(
    now = Date.now(),
    excludedTopics: string[] = [],
  ): LearnedKnowledge | null {
    // A subject the room has finished stays finished for the rest of the
    // day. Returning to it after half an hour reads as a broken record.
    const reuseAfterMs = 24 * 60 * 60_000;
    const recentRoomMessages = this.state.workingMemory
      .filter((episode) => {
        const occurredAt = Date.parse(episode.occurredAt);
        return Number.isFinite(occurredAt) && now - occurredAt < reuseAfterMs;
      })
      .map((episode) => episode.content);
    const available = this.state.knowledge
      .filter((memory) => {
        const lastUsed = Date.parse(memory.lastUsedAt ?? "");
        const subject = `${memory.topic} ${memory.statement}`;
        const wasRecentlyDiscussed =
          excludedTopics.some((topic) => relatedness(topic, subject) >= 0.3) ||
          recentRoomMessages.some(
            (message) => relatedness(message, subject) >= 0.25,
          );
        return (
          memory.confidence >= 0.5 &&
          memory.sources.length > 0 &&
          !wasRecentlyDiscussed &&
          (!Number.isFinite(lastUsed) || now - lastUsed >= reuseAfterMs)
        );
      })
      .sort(
        (left, right) =>
          left.useCount - right.useCount ||
          Date.parse(right.learnedAt) - Date.parse(left.learnedAt),
      );
    const selected = available[0];

    return selected === undefined
      ? null
      : {
          topic: selected.topic,
          statement: selected.statement,
          confidence: selected.confidence,
          sources: selected.sources,
          curiosity: selected.curiosity,
        };
  }

  public markTopicUsed(topic: string, usedAt: string): void {
    const selected = this.state.knowledge.find(
      (memory) => relevance(words(topic), memory.topic) >= 0.7,
    );

    if (selected === undefined) {
      return;
    }

    selected.lastUsedAt = usedAt;
    selected.useCount += 1;
    this.saveSoon();
  }

  public view(subject = ""): string {
    const familiarPeople = Object.entries(this.state.people)
      .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([person]) => person);
    // Retrieval stays selective even though the durable experience keeps a
    // much deeper history. Every inference turn gets the most useful recent
    // examples instead of repeatedly re-reading the full working set.
    const query = words(subject);
    const workingMemory = this.state.workingMemory
      .map((episode, index) => ({
        episode,
        score:
          relevance(query, `${episode.speaker} ${episode.content}`) +
          episode.salience * 0.1 +
          index / Math.max(1, this.state.workingMemory.length) / 10,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 4)
      .map(({ episode }) => `${episode.speaker}: "${episode.content}"`);
    const episodes = this.state.episodes
      .map((episode, index) => ({
        episode,
        score:
          relevance(query, `${episode.speaker} ${episode.content}`) +
          index / Math.max(1, this.state.episodes.length) / 10,
      }))
      .filter(({ score }) => query.size === 0 || score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ episode }) =>
        `${episode.speaker} said "${episode.content}" on ${episode.occurredAt}`,
      );
    const knowledge = this.state.knowledge
      .map((memory) => ({
        memory,
        score:
          relevance(query, `${memory.topic} ${memory.statement}`) +
          memory.confidence * 0.2,
      }))
      .filter(({ score }) => query.size === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          Date.parse(right.memory.learnedAt) - Date.parse(left.memory.learnedAt),
      )
      .slice(0, 4);
    const curiosities = this.state.curiosities
      .map((curiosity) => ({
        curiosity,
        score:
          relevance(query, `${curiosity.subject} ${curiosity.question}`) +
          curiosity.weight * 0.1,
      }))
      .filter(({ score }) => query.size === 0 || score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ curiosity }) => curiosity.question);
    const impressions = this.state.impressions.slice(-4);
    const responsive = this.state.responsiveMoments.slice(-2);
    const confusing = this.state.confusingMoments.slice(-1);
    const quiet = this.state.quietMoments.slice(-1);
    const lines = [
      familiarPeople.length === 0
        ? "People feel mostly unfamiliar so far."
        : `People I am becoming familiar with: ${familiarPeople.join(", ")}.`,
      workingMemory.length === 0
        ? "Working memory is quiet."
        : `What is active in my working memory:\n- ${workingMemory.join("\n- ")}`,
      episodes.length === 0
        ? "No older episode is especially relevant right now."
        : `Relevant experiences I recall:\n- ${episodes.join("\n- ")}`,
      knowledge.length === 0
        ? "I have no sourced long-term knowledge relevant to this thought yet."
        : `Sourced knowledge I recall:\n- ${knowledge
            .map(({ memory }) =>
              `${memory.topic}: ${memory.statement}` +
              (memory.learningValue === undefined
                ? ""
                : ` Why it matters: ${memory.learningValue}`),
            )
            .join("\n- ")}`,
      curiosities.length === 0
        ? "I have no active question relevant to this thought."
        : `Questions I remain curious about:\n- ${curiosities.join("\n- ")}`,
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

    for (const { memory } of knowledge) {
      memory.lastRecalledAt = new Date().toISOString();
      memory.recallCount += 1;
    }
    if (knowledge.length > 0) {
      this.saveSoon();
    }

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
    const addressed =
      message.addressedToSelf || message.addressedToRoom || message.followedSelf;

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

  private rememberCuriosity(curiosity: Curiosity): void {
    const existing = this.state.curiosities.find(
      (candidate) =>
        relevance(words(curiosity.question), candidate.question) >= 0.8,
    );

    if (existing === undefined) {
      this.state.curiosities.push(curiosity);
    } else {
      existing.weight = clamp(existing.weight + curiosity.weight, 20);
      existing.createdAt = curiosity.createdAt;
    }

    this.state.curiosities.splice(
      0,
      Math.max(0, this.state.curiosities.length - 40),
    );
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
          `Could not preserve ${this.state.displayName}'s brain: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
