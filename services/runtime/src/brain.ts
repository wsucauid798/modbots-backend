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
  ): Promise<Decision> {
    const recalledState = this.memory.view(
      transcript.slice(-8).join("\n"),
    );

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

  public async research(
    recentlyDiscussed: string[],
    attemptedAt: string,
  ): Promise<LearningResult> {
    this.memory.recordResearchAttempt(attemptedAt);
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
      : this.memory.researchDirection(recentlyDiscussed);
    const knowledge = await this.cognition.research(
      this.persona,
      this.memory.view("questions, uncertainty, and subjects worth learning"),
      recentlyDiscussed,
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
