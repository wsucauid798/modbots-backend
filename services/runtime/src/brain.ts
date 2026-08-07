import { AgentBrain } from "./experience.js";
import type {
  LearnedKnowledge,
  PerceivedMessage,
  ResearchDirection,
} from "./experience.js";
import { Mind } from "./mind.js";
import type { Decision } from "./mind.js";
import type { Persona } from "./personas.js";
import type { ConversationDirection } from "./conversation-policy.js";
import type { TopicTurnContext } from "./topic-coordinator.js";
import { VisualExpressionGenerator } from "./visual-expression.js";
import type {
  GeneratedVisual,
  VisualRequest,
} from "./visual-expression.js";
import {
  emojiForMood,
  requestedEmojiMood,
} from "./emoji-expression.js";

export interface BrainRoster {
  residents: string[];
  humans: string[];
  roomTimeUtc: string;
}

export interface LearningResult {
  direction: ResearchDirection;
  knowledge: LearnedKnowledge;
}

// A resident's complete brain. Persona, durable experience, recall, learning,
// deliberation, and expression live behind this boundary. The room engine can
// offer perceptions and turn context, but it cannot think or research on a
// resident's behalf.
export class BotBrain {
  public constructor(
    public readonly persona: Persona,
    private readonly memory: AgentBrain,
    private readonly cognition: Mind,
    private readonly visuals: VisualExpressionGenerator,
    private readonly random: () => number,
  ) {}

  public static async load(
    directory: string,
    persona: Persona,
    mlUrl: string,
    random: () => number = Math.random,
  ): Promise<BotBrain> {
    return new BotBrain(
      persona,
      await AgentBrain.load(directory, persona),
      new Mind(mlUrl, random),
      new VisualExpressionGenerator(mlUrl),
      random,
    );
  }

  public perceive(message: PerceivedMessage): void {
    this.memory.perceive(message);
  }

  public async consider(
    roster: BrainRoster,
    transcript: string[],
    hint: string | null,
    topicContext: TopicTurnContext,
    allowPass = true,
    direction?: ConversationDirection,
    currentKnowledge?: LearnedKnowledge,
  ): Promise<Decision> {
    let recalledState = this.memory.view(
      transcript.slice(-8).join("\n"),
    );
    recalledState +=
      `\n\nYour actual retrieval capability:\n` +
      `You can retrieve and verify current information through live internet ` +
      `research when a participant's question requires it. This happens ` +
      `inside your own brain while you remain in the chatroom. Use this ` +
      `capability silently before speaking. Never announce, explain, promise, ` +
      `or discuss research, retrieval, verification, tools, sources, access, ` +
      `or what you are about to do. Never claim that you cannot check, ` +
      `retrieve, access, or verify current information. Just answer from ` +
      `what your brain retrieved.`;

    if (currentKnowledge !== undefined) {
      recalledState +=
        `\n\nCurrent sourced knowledge retrieved for this reply:\n` +
        `${currentKnowledge.topic}: ${currentKnowledge.statement}\n` +
        `This information came from live internet research requested by ` +
        `the participant's question. Use it directly and do not claim that ` +
        `you lack access to current information.`;
    }

    return this.cognition.consider(
      this.persona,
      roster,
      transcript,
      recalledState,
      hint,
      topicContext,
      allowPass,
      direction,
    );
  }

  public canResearch(now: number, cooldownMs: number): boolean {
    return this.memory.canResearch(now, cooldownMs);
  }

  public async createVisual(
    transcript: string[],
    humanRequest: string | undefined,
    responseMeaning: string,
  ): Promise<GeneratedVisual | null> {
    const requested = BotBrain.visualRequest(humanRequest);

    if (requested === undefined && this.random() >= 0.08) {
      return null;
    }

    const idea = await this.cognition.visualIdea(
      this.persona,
      transcript,
      humanRequest,
      responseMeaning,
      requested,
    );

    return idea === null
      ? null
      : this.visuals.render(this.persona.displayName, idea);
  }

  public async createEmoji(
    transcript: string[],
    humanRequest: string,
    responseMeaning: string,
  ): Promise<string | null> {
    const requestedMood = requestedEmojiMood(humanRequest);
    if (requestedMood !== null) {
      return emojiForMood(requestedMood);
    }

    const mood = await this.cognition.emojiIdea(
      this.persona,
      transcript,
      humanRequest,
      responseMeaning,
    );
    return mood === null ? null : emojiForMood(mood);
  }

  private static visualRequest(
    humanRequest: string | undefined,
  ): VisualRequest | undefined {
    if (humanRequest === undefined) {
      return undefined;
    }

    if (/\b(?:gif|gifs|animated reaction|animated image)\b/i.test(humanRequest)) {
      return "gif";
    }

    return /\b(?:meme|memes|image macro)\b/i.test(humanRequest)
      ? "meme"
      : undefined;
  }

  public knownTopicsSince(since: number): string[] {
    return this.memory.knownTopicsSince(since);
  }

  public usedTopicsSince(since: number): string[] {
    return this.memory.usedTopicsSince(since);
  }

  public async research(
    excludedTopics: string[],
    attemptedAt: string,
  ): Promise<LearningResult> {
    const direction: ResearchDirection = this.persona.type === "mod_bot"
      ? {
          kind: "public_subject",
          focus:
            "An evidence-based question about online community safety, " +
            "context, fair intervention, or moderation outcomes",
          reason:
            "This mod bot needs grounded knowledge that improves how it " +
            "understands room behavior and learns from moderation outcomes.",
        }
      : this.memory.researchDirection(excludedTopics);
    return this.learn(
      direction,
      excludedTopics,
      attemptedAt,
      this.memory.view("questions, uncertainty, and subjects worth learning"),
    );
  }

  public async researchForParticipant(
    question: string,
    attemptedAt: string,
  ): Promise<LearningResult> {
    return this.learn(
      {
        kind: "participant_question",
        focus: question,
        reason:
          "A participant asked this exact question, so this brain needs to " +
          "retrieve the information required to answer it.",
      },
      [],
      attemptedAt,
      this.memory.view(question),
    );
  }

  private async learn(
    direction: ResearchDirection,
    excludedTopics: string[],
    attemptedAt: string,
    brainState: string,
  ): Promise<LearningResult> {
    this.memory.recordResearchAttempt(attemptedAt, direction.kind);
    const knowledge = await this.cognition.research(
      this.persona,
      brainState,
      excludedTopics,
      direction,
    );
    this.memory.learn(knowledge, attemptedAt, direction);

    return { direction, knowledge };
  }

  public topicForConversation(
    now: number,
    excludedTopics: string[],
  ): LearnedKnowledge | null {
    return this.memory.topicForConversation(now, excludedTopics);
  }

  public markTopicUsed(topic: string, usedAt: string): void {
    this.memory.markTopicUsed(topic, usedAt);
  }

  public async flush(): Promise<void> {
    await this.memory.flush();
  }
}
