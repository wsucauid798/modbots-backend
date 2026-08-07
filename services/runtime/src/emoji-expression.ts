export type EmojiMood =
  | "delighted"
  | "laughing"
  | "warm"
  | "sad"
  | "surprised"
  | "thinking"
  | "supportive"
  | "playful"
  | "approval";

const emojis: Record<EmojiMood, string> = {
  delighted: "😄",
  laughing: "😂",
  warm: "😊",
  sad: "😔",
  surprised: "😮",
  thinking: "🤔",
  supportive: "🫶",
  playful: "😜",
  approval: "👍",
};

const moods = new Set<EmojiMood>(Object.keys(emojis) as EmojiMood[]);
const emojiMoods = new Map(
  Object.entries(emojis).map(([mood, emoji]) => [emoji, mood as EmojiMood]),
);

export const parseEmojiMood = (raw: string): EmojiMood | null => {
  const trimmed = raw.trim();

  if (/^PASS$/i.test(trimmed)) {
    return null;
  }

  const directMood = emojiMoods.get(trimmed);
  if (directMood !== undefined) {
    return directMood;
  }

  let candidate = trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(trimmed.slice(start, end + 1)) as Record<
        string,
        unknown
      >;
      candidate = typeof value.mood === "string" ? value.mood : "";
    } catch {
      return null;
    }
  }

  const normalized = candidate.trim().toLowerCase().replace(/[^a-z]+/g, "_")
    .replace(/^_|_$/g, "");
  return moods.has(normalized as EmojiMood)
    ? normalized as EmojiMood
    : null;
};

export const emojiForMood = (mood: EmojiMood): string => emojis[mood];

export const requestedEmojiMood = (request: string): EmojiMood | null => {
  const patterns: Array<[EmojiMood, RegExp]> = [
    ["delighted", /\b(?:delighted|delight|joyful|happy)\b/i],
    ["laughing", /\b(?:laughing|laughter|hilarious)\b/i],
    ["warm", /\b(?:warm|friendly|gentle)\b/i],
    ["sad", /\b(?:sad|unhappy|downcast)\b/i],
    ["surprised", /\b(?:surprised|surprise|shocked)\b/i],
    ["thinking", /\b(?:thinking|thoughtful|pondering)\b/i],
    ["supportive", /\b(?:supportive|support|comforting)\b/i],
    ["playful", /\b(?:playful|cheeky|silly)\b/i],
    ["approval", /\b(?:approval|approve|agreeing|thumbs? up)\b/i],
  ];

  return patterns.find(([, pattern]) => pattern.test(request))?.[0] ?? null;
};
