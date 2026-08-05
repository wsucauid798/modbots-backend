import type { Decision } from "./mind.js";
import type { LearnedKnowledge } from "./experience.js";

export type TurnTrigger = "autonomous" | "human" | "room";

export interface TopicTurnContext {
  eligible: boolean;
  questionAllowed: boolean;
  guidance: string;
  activeTopic: string | null;
  botTurnsOnTopic: number;
  learnedKnowledge?: LearnedKnowledge;
}

interface ActiveTopic {
  label: string;
  lastAdvancedAt: number;
  botTurnsSinceHuman: number;
  botQuestionsSinceHuman: number;
  consecutivePasses: number;
  coveredAngles: string[];
  recentMessages: string[];
}

interface ClosedTopic {
  label: string;
  closedAt: number;
}

export interface TopicDecisionResult {
  accepted: boolean;
  message?: string;
  reason?: string;
}

const topicCooldownMs = 30 * 60_000;
const maximumBotTurnsWithoutHuman = 3;
const maximumTopicIdleMs = 15 * 60_000;
const humanConversationYieldMs = 15_000;
const relatedTopicSimilarity = 0.3;

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stopWords.has(word))
    .map((word) =>
      word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word,
    );

const similarity = (left: string, right: string): number => {
  const leftWords = new Set(words(left));
  const rightWords = new Set(words(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }

  return overlap / new Set([...leftWords, ...rightWords]).size;
};

const asksQuestion = (message: string): boolean => message.includes("?");

const withoutQuestions = (message: string): string =>
  message
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !asksQuestion(sentence))
    .join(" ")
    .trim();

export class TopicCoordinator {
  private active: ActiveTopic | null = null;
  private readonly recentlyClosed: ClosedTopic[] = [];
  private lastRoomActivityAt = 0;
  private yieldToHumanUntil = 0;

  public observeHistoricalMessage(_type: string, occurredAt: number): void {
    if (Number.isFinite(occurredAt)) {
      this.lastRoomActivityAt = Math.max(this.lastRoomActivityAt, occurredAt);
    }
  }

  public noteHumanMessage(occurredAt: number): void {
    const effectiveTime = Number.isFinite(occurredAt)
      ? occurredAt
      : this.lastRoomActivityAt;
    this.lastRoomActivityAt = Math.max(this.lastRoomActivityAt, effectiveTime);
    this.yieldToHumanUntil = Math.max(
      this.yieldToHumanUntil,
      effectiveTime + humanConversationYieldMs,
    );

    // A human contribution owns the conversation. End any autonomous subject
    // so one resident answers the human without the other bots extending that
    // answer into another bot-only chain.
    this.closeActive(effectiveTime);
  }

  public turnContext(
    trigger: TurnTrigger,
    now: number,
    learnedKnowledge?: LearnedKnowledge,
  ): TopicTurnContext {
    this.pruneClosed(now);

    if (
      this.active !== null &&
      now - this.active.lastAdvancedAt >= maximumTopicIdleMs
    ) {
      this.closeActive(now);
    }

    if (
      trigger === "autonomous" &&
      this.active !== null &&
      this.active.botTurnsSinceHuman >= maximumBotTurnsWithoutHuman
    ) {
      this.closeActive(now);
    }

    if (trigger === "autonomous" && now < this.yieldToHumanUntil) {
      return {
        eligible: false,
        questionAllowed: false,
        activeTopic: this.active?.label ?? null,
        botTurnsOnTopic: this.active?.botTurnsSinceHuman ?? 0,
        guidance: "A human just spoke. Give the human conversation room and stay silent.",
      };
    }

    if (this.active === null) {
      const recentlyCompleted = this.recentlyClosed
        .slice(-12)
        .map((topic) => topic.label)
        .join("; ");

      return {
        eligible: trigger !== "autonomous" || learnedKnowledge !== undefined,
        questionAllowed: true,
        activeTopic: null,
        botTurnsOnTopic: 0,
        learnedKnowledge,
        guidance:
          trigger === "autonomous"
            ? learnedKnowledge === undefined
              ? "There is no learned subject available. Stay silent."
              : `There is no active topic. Start from knowledge already held in your brain. Keep TOPIC exactly '${learnedKnowledge.topic}', use SOURCE=knowledge, and use MOVE=start. What you learned: ${learnedKnowledge.statement} Why it matters: ${learnedKnowledge.learningValue ?? "It addresses a real knowledge gap."} Your remaining curiosity: ${learnedKnowledge.curiosity ?? "none"}. Research sources are private internal provenance. Do not mention, cite, or link them in the message. Share one natural conversational thought, question, or reaction that follows from what you actually learned. ` +
              (recentlyCompleted.length > 0
                ? `Recently completed topics: ${recentlyCompleted}. Do not rename, revisit, or choose a close variation of them.`
                : "")
            : "There is no active topic. Ground the new topic in the event that triggered this turn.",
      };
    }

    const questionAllowed = this.active.botQuestionsSinceHuman === 0;
    return {
      eligible: true,
      questionAllowed,
      activeTopic: this.active.label,
      botTurnsOnTopic: this.active.botTurnsSinceHuman,
      guidance:
        `The room's active topic is ${this.active.label}. ` +
        `Keep TOPIC exactly '${this.active.label}', use SOURCE=conversation, ` +
        `and choose MOVE=reply or MOVE=continue. Respond to the central ` +
        `subject, not an incidental word, metaphor, or joke. Do not change ` +
        `the subject or create a bridge to another one. ` +
        `A reaction or personal response is enough, but it must name the real ` +
        `point clearly and make literal sense. Do not summarize a concrete ` +
        `point with poetic imagery or wordplay. Do not turn the exchange into a sequence of tips, refinements, or recommendations. ` +
        (questionAllowed
          ? "At most one useful question may be asked."
          : "The bot question budget is already used. Do not ask another question."),
    };
  }

  public evaluate(
    decision: Decision,
    message: string,
    trigger: TurnTrigger,
    now: number,
    context?: TopicTurnContext,
  ): TopicDecisionResult {
    if (
      decision.topic === undefined ||
      decision.topicMove === undefined ||
      decision.topicSource === undefined ||
      decision.topicGrounding === undefined ||
      decision.topicContribution === undefined
    ) {
      return { accepted: false, reason: "incomplete topic decision" };
    }

    let prepared = message.trim();
    const questionAllowed =
      this.active === null || this.active.botQuestionsSinceHuman === 0;

    if (!questionAllowed && asksQuestion(prepared)) {
      prepared = withoutQuestions(prepared);

      if (prepared.length === 0) {
        return { accepted: false, reason: "question budget already used" };
      }
    }

    if (trigger === "autonomous" && this.active === null) {
      if (decision.topicMove !== "start") {
        return { accepted: false, reason: "new topic did not start cleanly" };
      }

      if (decision.topicSource !== "knowledge") {
        return {
          accepted: false,
          reason: "new topic did not come from the bot's learned knowledge",
        };
      }

      if (context?.learnedKnowledge === undefined) {
        return { accepted: false, reason: "new topic had no learned knowledge" };
      }

      if (
        decision.topic.trim().toLowerCase() !==
        context.learnedKnowledge.topic.trim().toLowerCase()
      ) {
        return { accepted: false, reason: "learned topic label changed" };
      }
    }

    if (trigger === "autonomous" && this.active !== null) {
      if (
        decision.topicMove !== "reply" &&
        decision.topicMove !== "continue"
      ) {
        return {
          accepted: false,
          reason: "active topic attempted an associative change",
        };
      }

      if (
        decision.topic.trim().toLowerCase() !==
        this.active.label.trim().toLowerCase()
      ) {
        return { accepted: false, reason: "active topic label changed" };
      }

      if (decision.topicSource !== "conversation") {
        return { accepted: false, reason: "active topic lost its grounding" };
      }
    }

    if (
      this.active !== null &&
      (decision.topicMove === "reply" || decision.topicMove === "continue") &&
      this.active.coveredAngles.some(
        (angle) => similarity(angle, decision.topicContribution ?? "") >= 0.6,
      )
    ) {
      return { accepted: false, reason: "topic angle already covered" };
    }

    if (
      this.active !== null &&
      this.active.recentMessages.some(
        (recent) => similarity(recent, prepared) >= 0.72,
      )
    ) {
      return { accepted: false, reason: "message repeats a recent contribution" };
    }

    this.pruneClosed(now);

    if (
      trigger === "autonomous" &&
      this.active === null &&
      this.recentlyClosed.some(
        (topic) =>
          similarity(topic.label, decision.topic ?? "") >=
          relatedTopicSimilarity,
      )
    ) {
      return { accepted: false, reason: "topic is still on cooldown" };
    }

    return { accepted: true, message: prepared };
  }

  public recordBotTurn(
    decision: Decision,
    message: string,
    trigger: TurnTrigger,
    now: number,
  ): void {
    this.lastRoomActivityAt = now;

    if (trigger !== "autonomous") {
      return;
    }

    const label = decision.topic ?? "current conversation";
    const startsNewTopic =
      this.active === null;

    if (startsNewTopic) {
      if (this.active !== null) {
        this.closeActive(now);
      }

      this.active = {
        label,
        lastAdvancedAt: now,
        botTurnsSinceHuman: 0,
        botQuestionsSinceHuman: 0,
        consecutivePasses: 0,
        coveredAngles: [],
        recentMessages: [],
      };
    }

    if (this.active === null) {
      return;
    }

    this.active.botTurnsSinceHuman += 1;
    this.active.consecutivePasses = 0;
    this.active.lastAdvancedAt = now;
    this.active.coveredAngles.push(decision.topicContribution ?? label);
    this.active.recentMessages.push(message);

    if (asksQuestion(message)) {
      this.active.botQuestionsSinceHuman += 1;
    }

    this.active.coveredAngles.splice(0, this.active.coveredAngles.length - 8);
    this.active.recentMessages.splice(0, this.active.recentMessages.length - 5);
  }

  public recentlyCompletedTopics(): string[] {
    return this.recentlyClosed.slice(-12).map((topic) => topic.label);
  }

  public recordPass(availableBots: number, now: number): void {
    if (this.active === null) {
      return;
    }

    this.active.consecutivePasses += 1;

    if (this.active.consecutivePasses >= Math.min(2, availableBots)) {
      this.closeActive(now);
    }
  }

  private closeActive(now: number): void {
    if (this.active !== null) {
      this.recentlyClosed.push({ label: this.active.label, closedAt: now });
      this.active = null;
    }

    this.pruneClosed(now);
  }

  private pruneClosed(now: number): void {
    while (
      this.recentlyClosed.length > 0 &&
      now - (this.recentlyClosed[0]?.closedAt ?? now) > topicCooldownMs
    ) {
      this.recentlyClosed.shift();
    }

    while (this.recentlyClosed.length > 12) {
      this.recentlyClosed.shift();
    }
  }
}
