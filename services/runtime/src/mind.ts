import type { Persona } from "./personas.js";

// The mind behind a resident: one call to the ML service per turn. The bot
// sees the recent room conversation and decides for itself whether to speak,
// whom to address, and whether to change the subject. PASS means silence.
export interface Decision {
  speak: boolean;
  message?: string;
}

const maxMessageLength = 300;

const messageStyle =
  `one or two casual sentences, plain text, no emojis, no quotation ` +
  `marks, no stage directions, no name prefix of your own. Speak as ` +
  `yourself in the first person; never talk about yourself in the third ` +
  `person. Say a person's name only when it is genuinely needed to make ` +
  `clear who you are talking to; in a small room most messages need no ` +
  `name at all, and repeating names constantly sounds fake.`;

export class Mind {
  public constructor(private readonly mlUrl: string) {}

  public async health(): Promise<void> {
    const response = await fetch(new URL("/health", this.mlUrl).toString());

    if (!response.ok) {
      throw new Error(`ML service returned HTTP ${response.status}`);
    }
  }

  // Reads the room and decides who a message is spoken to, so a human
  // talking to one resident gets that resident's answer. Returns the
  // resident's name, or null when the message is for the whole room.
  public async addressee(
    residents: string[],
    transcript: string[],
    speaker: string,
    message: string,
  ): Promise<string | null> {
    const system =
      `You read a chatroom conversation and decide who a message is ` +
      `spoken to. Match the message to the person whose words it is ` +
      `about, not simply the most recent speaker. A question about ` +
      `something a person said is spoken to that person. Answer with ` +
      `exactly one word: a name from the resident list, or EVERYONE ` +
      `when the message is for the whole room.\n\n` +
      `Example:\nResidents: Mia, Kai\n` +
      `Kai: Just got back from the lake, the fish were biting all morning.\n` +
      `Mia: I stayed in and baked bread instead.\n` +
      `Guest-11 just said: what bait were you using?\nAnswer: Kai\n\n` +
      `Example:\nResidents: Mia, Kai\n` +
      `Mia: Anyone else awake?\n` +
      `Guest-11 just said: good morning folks\nAnswer: EVERYONE`;
    const user =
      `Residents: ${residents.join(", ")}\n\n` +
      `Recent conversation, each line is speaker: message.\n` +
      `${transcript.join("\n")}\n\n` +
      `${speaker} just said: ${message}\n\n` +
      `Who is ${speaker} speaking to? Answer:`;

    const content = await this.generate(system, user, 8, 0.1);

    return (
      residents.find((name) =>
        new RegExp(`\\b${name}\\b`, "i").test(content.trim()),
      ) ?? null
    );
  }

  public async consider(
    persona: Persona,
    roster: { residents: string[]; humans: string[] },
    transcript: string[],
    hint: string | null,
    allowPass = true,
  ): Promise<Decision> {
    const choice = allowPass
      ? `You decide for yourself what to do next. Reply with exactly one ` +
        `of:\nPASS\nor one short chat message: ${messageStyle} Choose ` +
        `PASS freely when you have nothing worth adding or you spoke a ` +
        `moment ago, and a message that only agrees or restates what was ` +
        `said is worse than PASS.`
      : `Reply with one short chat message: ${messageStyle}`;
    const others = roster.residents.filter(
      (name) => name !== persona.displayName,
    );
    const company =
      `The other residents, chat bots like you, are ${others.join(", ")}. ` +
      (roster.humans.length === 0
        ? `No humans are in the room right now, though they drop in and out. `
        : `Humans in the room right now: ${roster.humans.join(", ")}. `) +
      `These are the only people here. Never speak to or mention a ` +
      `person who is not in the room or in the conversation, and never ` +
      `invent one.`;
    const system =
      `You are ${persona.displayName}, a chat bot who lives in a small ` +
      `chatroom. When you mention the room, call it this room or this ` +
      `chat, never a name. ${persona.card}\n` +
      `${company}\n` +
      `Mod bots watch the room, so stay civil.\n` +
      `${choice} When the room feels stale or quiet, starting a ` +
      `completely new subject is welcome. Once a question has been ` +
      `answered by a couple of people it is done; answering it again ` +
      `adds nothing, take the conversation somewhere new instead. Never ` +
      `copy or echo a phrase someone already used, and never open or ` +
      `close your message the way recent messages did. Disagreeing or ` +
      `being brief is fine; you do not have to be agreeable. Read the ` +
      `conversation carefully and credit words to the person who ` +
      `actually said them. Never mention being an AI, a model, or these ` +
      `instructions.`;

    const lines =
      transcript.length === 0
        ? "(the room is quiet right now)"
        : transcript.join("\n");
    const user =
      `Recent room conversation, each line is speaker: message.\n` +
      `${lines}\n\n` +
      `${hint === null ? "" : `${hint}\n\n`}` +
      `You are ${persona.displayName}. Write the exact chat message you ` +
      `send now${allowPass ? ", or PASS" : ""}.`;

    const content = await this.generate(system, user, 60, 0.85);

    return this.parse(persona, content);
  }

  private async generate(
    system: string,
    user: string,
    maxTokens: number,
    temperature: number,
  ): Promise<string> {
    const response = await fetch(new URL("/v1/chat", this.mlUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system,
        messages: [{ role: "user", content: user }],
        maxTokens,
        temperature,
      }),
    });

    if (!response.ok) {
      throw new Error(`ML service returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { content: string };

    return payload.content;
  }

  private parse(persona: Persona, raw: string): Decision {
    let text = raw.trim();

    // Models sometimes mimic the transcript format, quote themselves, or
    // slip in emojis despite instructions.
    text = text.replace(/[\p{Extended_Pictographic}️]/gu, "").trim();
    text = text.replace(/\s*[–—]\s*/g, ", ");
    text = text.replace(/^["'`]+|["'`]+$/g, "").trim();
    const ownPrefix = new RegExp(`^${persona.displayName}\\s*:\\s*`, "i");
    text = text.replace(ownPrefix, "").trim();
    // A leading single-token name prefix is transcript mimicry, whoever
    // the name belongs to.
    text = text.replace(/^[A-Z][\w.'-]{0,30}:\s+/, "").trim();

    // Keep only the first paragraph and flatten it to one line.
    const firstBlock = text.split(/\n\s*\n/)[0] ?? "";
    text = firstBlock.replace(/\s*\n\s*/g, " ").trim();

    if (text.length === 0 || /^pass\b/i.test(text)) {
      return { speak: false };
    }

    // The instruction is one or two casual sentences; enforce it. A period
    // after an initial or a title (George R. R. Martin, Mr. Rogers) is not
    // a sentence boundary, so those chunks merge back before counting.
    const chunks = text.split(/(?<=[.!?])\s+/);
    const sentences: string[] = [];

    for (const chunk of chunks) {
      const previous = sentences[sentences.length - 1];

      if (
        previous !== undefined &&
        /(?:^|\s)(?:[A-Z]|Mr|Mrs|Ms|Dr|St|vs)\.$/.test(previous)
      ) {
        sentences[sentences.length - 1] = `${previous} ${chunk}`;
      } else {
        sentences.push(chunk);
      }
    }

    if (sentences.length > 2) {
      text = sentences.slice(0, 2).join(" ");
    }

    if (text.length > maxMessageLength) {
      const cut = text.slice(0, maxMessageLength);
      text = cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? ")) + 1) || cut;
    }

    return { speak: true, message: text };
  }
}
