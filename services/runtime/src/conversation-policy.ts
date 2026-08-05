import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnTrigger } from "./topic-coordinator.js";

export type ConversationIntent =
  | "answer_human"
  | "respond_human"
  | "acknowledge_room"
  | "respond_topic"
  | "react_topic"
  | "ask_follow_up"
  | "start_question"
  | "start_opinion"
  | "start_playful"
  | "start_personal"
  | "wait";

export interface ConversationDirection {
  intent: ConversationIntent;
  instruction: string;
  learnedGuidance: string;
}

interface LearnedStat {
  attempts: number;
  reward: number;
  humanResponses: number;
  botResponses: number;
  negativeOutcomes: number;
}

interface PendingTurn {
  speaker: string;
  intent: ConversationIntent;
  topic: string;
  occurredAt: number;
  humanCredited: boolean;
  botCredited: boolean;
}

interface PolicyState {
  version: 1;
  actions: Partial<Record<ConversationIntent, LearnedStat>>;
  speakers: Record<string, LearnedStat>;
  topics: Record<string, LearnedStat>;
  pending: PendingTurn[];
}

export interface SpeakerCandidate {
  displayName: string;
  lastAttemptedAt: number;
  lastSpokeAt: number;
}

export interface DirectionContext {
  trigger: TurnTrigger;
  activeTopic: string | null;
  questionAllowed: boolean;
  botTurnsOnTopic?: number;
  directQuestion?: boolean;
}

const emptyStat = (): LearnedStat => ({
  attempts: 0,
  reward: 0,
  humanResponses: 0,
  botResponses: 0,
  negativeOutcomes: 0,
});

const cleanStat = (value: unknown): LearnedStat => {
  if (typeof value !== "object" || value === null) {
    return emptyStat();
  }

  const raw = value as Partial<LearnedStat>;
  const number = (candidate: unknown): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;

  return {
    attempts: Math.max(0, number(raw.attempts)),
    reward: number(raw.reward),
    humanResponses: Math.max(0, number(raw.humanResponses)),
    botResponses: Math.max(0, number(raw.botResponses)),
    negativeOutcomes: Math.max(0, number(raw.negativeOutcomes)),
  };
};

const normalizeTopic = (topic: string): string =>
  topic.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);

const signalsConfusion = (content: string): boolean =>
  /\b(confused|confusing|unclear|lost|clarify|clarification|what do you mean|i do not understand|i don't understand|not following|nonsense|no sense|irrelevant|wrong)\b/i.test(
    content,
  );

const instructionFor: Record<ConversationIntent, string> = {
  answer_human:
    "Answer the human's exact question directly in the first sentence. Do not continue the bots' previous subject.",
  respond_human:
    "Respond to the human's actual words and meaning. Do not replace their subject with an associated subject.",
  acknowledge_room:
    "Acknowledge the real room event briefly and naturally without starting an unrelated discussion.",
  respond_topic:
    "Respond to the active topic's central point in literal language. Add one relevant contribution and do not change the subject.",
  react_topic:
    "Give a brief, clear reaction that names the actual point you are reacting to. It may simply agree, disagree, or show interest.",
  ask_follow_up:
    "Ask one specific follow-up question about the active topic. Do not introduce a new subject.",
  start_question:
    "Use the supplied knowledge from your brain to ask one honest, specific question.",
  start_opinion:
    "Use the supplied knowledge from your brain to share one considered opinion and a natural reason.",
  start_playful:
    "Use the supplied knowledge from your brain for a light but literal conversational observation. Do not invent a premise or replace meaning with wordplay.",
  start_personal:
    "Connect the supplied knowledge to a genuine interest without inventing a memory or experience.",
  wait: "Stay silent this turn.",
};

const priors: Record<ConversationIntent, number> = {
  answer_human: 2,
  respond_human: 1.8,
  acknowledge_room: 1.4,
  respond_topic: 1.3,
  react_topic: 1.05,
  ask_follow_up: 0.85,
  start_question: 1.25,
  start_opinion: 1.15,
  start_playful: 0.95,
  start_personal: 0.9,
  wait: 0.15,
};

export class ConversationPolicy {
  private saveChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string | null,
    private readonly state: PolicyState,
    private readonly random: () => number,
  ) {}

  public static inMemory(random: () => number = Math.random): ConversationPolicy {
    return new ConversationPolicy(null, {
      version: 1,
      actions: {},
      speakers: {},
      topics: {},
      pending: [],
    }, random);
  }

  public static async load(
    directory: string,
    random: () => number = Math.random,
  ): Promise<ConversationPolicy> {
    await mkdir(directory, { recursive: true });
    const filePath = join(directory, "conversation-policy.json");

    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const actions: PolicyState["actions"] = {};
      const speakers: Record<string, LearnedStat> = {};
      const topics: Record<string, LearnedStat> = {};

      if (typeof parsed.actions === "object" && parsed.actions !== null) {
        for (const [key, value] of Object.entries(parsed.actions)) {
          actions[key as ConversationIntent] = cleanStat(value);
        }
      }
      if (typeof parsed.speakers === "object" && parsed.speakers !== null) {
        for (const [key, value] of Object.entries(parsed.speakers)) speakers[key] = cleanStat(value);
      }
      if (typeof parsed.topics === "object" && parsed.topics !== null) {
        for (const [key, value] of Object.entries(parsed.topics)) topics[key] = cleanStat(value);
      }

      return new ConversationPolicy(filePath, {
        version: 1,
        actions,
        speakers,
        topics,
        pending: [],
      }, random);
    } catch {
      return new ConversationPolicy(filePath, {
        version: 1,
        actions: {},
        speakers: {},
        topics: {},
        pending: [],
      }, random);
    }
  }

  public chooseSpeaker<T extends SpeakerCandidate>(candidates: T[], now: number): T | undefined {
    return [...candidates].sort((left, right) =>
      this.speakerScore(right, now) - this.speakerScore(left, now) ||
      left.lastAttemptedAt - right.lastAttemptedAt ||
      left.displayName.localeCompare(right.displayName)
    )[0];
  }

  public chooseDirection(context: DirectionContext): ConversationDirection {
    let candidates: ConversationIntent[];

    if (context.trigger === "human") {
      candidates = [context.directQuestion ? "answer_human" : "respond_human"];
    } else if (context.trigger === "room") {
      candidates = ["acknowledge_room"];
    } else if (context.activeTopic !== null) {
      candidates = ["respond_topic", "react_topic"];
      if (context.questionAllowed) candidates.push("ask_follow_up");
      if ((context.botTurnsOnTopic ?? 0) >= 2) candidates.push("wait");
    } else {
      candidates = ["start_question", "start_opinion", "start_playful", "start_personal", "wait"];
    }

    const intent = [...candidates].sort((left, right) =>
      this.actionScore(right) - this.actionScore(left)
    )[0] ?? "wait";

    return {
      intent,
      instruction: instructionFor[intent],
      learnedGuidance: this.learnedGuidance(),
    };
  }

  public recordTurn(
    speaker: string,
    intent: ConversationIntent,
    topic: string,
    occurredAt: number,
  ): void {
    const normalizedTopic = normalizeTopic(topic);
    const previous = [...this.state.pending].reverse().find((turn) =>
      turn.speaker !== speaker &&
      !turn.botCredited &&
      occurredAt - turn.occurredAt <= 5 * 60_000
    );

    if (previous !== undefined) {
      previous.botCredited = true;
      this.reward(previous, 0.2, "bot");
    }

    this.stat(this.state.actions, intent).attempts += 1;
    this.stat(this.state.speakers, speaker).attempts += 1;
    this.stat(this.state.topics, normalizedTopic).attempts += 1;
    this.state.pending.push({
      speaker,
      intent,
      topic: normalizedTopic,
      occurredAt,
      humanCredited: false,
      botCredited: false,
    });
    this.prunePending(occurredAt);
    this.saveSoon();
  }

  public observeHumanMessage(content: string, occurredAt: number, addressedTo?: string): void {
    this.prunePending(occurredAt);
    const eligible = [...this.state.pending].reverse().filter((turn) =>
      !turn.humanCredited && occurredAt >= turn.occurredAt
    );
    const turn = eligible.find((candidate) => candidate.speaker === addressedTo) ?? eligible[0];

    if (turn === undefined) return;
    turn.humanCredited = true;
    this.reward(turn, signalsConfusion(content) ? -4 : 3, signalsConfusion(content) ? "negative" : "human");
    this.saveSoon();
  }

  public recordModeration(speaker: string, occurredAt: number): void {
    const turn = [...this.state.pending].reverse().find((candidate) =>
      candidate.speaker === speaker && occurredAt - candidate.occurredAt <= 10 * 60_000
    );
    if (turn !== undefined) this.reward(turn, -5, "negative");
    this.saveSoon();
  }

  public recordRejected(intent: ConversationIntent): void {
    const stat = this.stat(this.state.actions, intent);
    stat.attempts += 1;
    stat.reward -= 0.25;
    stat.negativeOutcomes += 1;
    this.saveSoon();
  }

  public recordPass(intent: ConversationIntent): void {
    this.stat(this.state.actions, intent).attempts += 1;
    this.saveSoon();
  }

  public async flush(): Promise<void> {
    await this.saveChain;
  }

  private actionScore(intent: ConversationIntent): number {
    const stat = this.stat(this.state.actions, intent);
    const learned = stat.reward / Math.max(1, stat.attempts);
    const totalAttempts = Object.values(this.state.actions).reduce(
      (total, action) => total + (action?.attempts ?? 0),
      0,
    );
    const exploration = Math.sqrt(
      (2 * Math.log(totalAttempts + 1)) / (stat.attempts + 1),
    );
    return priors[intent] + learned + exploration + this.random() * 0.05;
  }

  private speakerScore(candidate: SpeakerCandidate, now: number): number {
    const stat = this.stat(this.state.speakers, candidate.displayName);
    const learned = stat.reward / Math.max(1, stat.attempts);
    const idleMinutes = Math.min(30, Math.max(0, now - candidate.lastAttemptedAt) / 60_000);
    return idleMinutes * 0.2 + learned * 0.25 + this.random() * 0.05;
  }

  private learnedGuidance(): string {
    const ranked = Object.entries(this.state.topics)
      .sort((a, b) => b[1].reward - a[1].reward);
    const engaging = ranked
      .filter(([, stat]) => stat.humanResponses > 0 && stat.reward > 0)
      .slice(0, 3)
      .map(([topic]) => topic);
    const confusing = ranked
      .filter(([, stat]) => stat.negativeOutcomes > 0)
      .slice(-2)
      .map(([topic]) => topic);
    const parts: string[] = [];
    if (engaging.length > 0) parts.push(`Human responses have been strongest around: ${engaging.join(", ")}.`);
    if (confusing.length > 0) parts.push(`Use extra clarity around: ${confusing.join(", ")}.`);
    return parts.join(" ");
  }

  private reward(turn: PendingTurn, amount: number, kind: "human" | "bot" | "negative"): void {
    for (const stat of [
      this.stat(this.state.actions, turn.intent),
      this.stat(this.state.speakers, turn.speaker),
      this.stat(this.state.topics, turn.topic),
    ]) {
      stat.reward += amount;
      if (kind === "human") stat.humanResponses += 1;
      if (kind === "bot") stat.botResponses += 1;
      if (kind === "negative") stat.negativeOutcomes += 1;
    }
  }

  private stat<Key extends string>(bucket: Partial<Record<Key, LearnedStat>>, key: Key): LearnedStat {
    const current = bucket[key];
    if (current !== undefined) return current;
    const created = emptyStat();
    bucket[key] = created;
    return created;
  }

  private prunePending(now: number): void {
    this.state.pending = this.state.pending.filter((turn) => now - turn.occurredAt <= 10 * 60_000);
  }

  private saveSoon(): void {
    if (this.filePath === null) return;
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => writeFile(this.filePath as string, `${JSON.stringify(this.state, null, 2)}\n`, "utf8"));
  }
}
