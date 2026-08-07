import type { GeneratedMeme, MemeIdea, MemeTemplate } from "./memegen.js";
import { MemeGenerator } from "./memegen.js";
import type {
  GeneratedReactionGif,
  ReactionGifIdea,
  ReactionGifTemplate,
} from "./reaction-gif.js";
import { ReactionGifGenerator } from "./reaction-gif.js";

export type VisualRequest = "meme" | "gif";
export type VisualIdea =
  | ({ kind: "meme" } & MemeIdea)
  | ({ kind: "gif" } & ReactionGifIdea);
export type GeneratedVisual = GeneratedMeme | GeneratedReactionGif;

const memeTemplates = new Set<MemeTemplate>([
  "reaction",
  "contrast",
  "announcement",
]);
const gifTemplates = new Set<ReactionGifTemplate>([
  "celebrate",
  "laugh",
  "side_eye",
  "facepalm",
]);

const text = (
  value: unknown,
  maximum: number,
): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value
      .trim()
      .replace(/\s*[\u2013\u2014]\s*/g, ", ")
      .slice(0, maximum)
    : null;

export const parseVisualIdea = (raw: string): VisualIdea | null => {
  const trimmed = raw.trim();

  if (/^PASS$/i.test(trimmed)) {
    return null;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return null;
  }

  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    let kind = typeof value.kind === "string"
      ? value.kind.trim().toLowerCase()
      : value.kind;
    let template = typeof value.template === "string"
      ? value.template.trim().toLowerCase()
      : value.template;
    const altText = text(value.altText, 500);

    if (
      typeof kind === "string" &&
      gifTemplates.has(kind as ReactionGifTemplate)
    ) {
      template = kind;
      kind = "gif";
    } else if (
      typeof kind === "string" &&
      memeTemplates.has(kind as MemeTemplate)
    ) {
      template = kind;
      kind = "meme";
    }

    if (kind === "meme" && typeof template === "string" && altText !== null) {
      const topText = text(value.topText, 180);
      const bottomText = text(value.bottomText, 180);

      if (
        memeTemplates.has(template as MemeTemplate) &&
        topText !== null &&
        bottomText !== null
      ) {
        return {
          kind,
          template: template as MemeTemplate,
          topText,
          bottomText,
          altText,
        };
      }
    }

    if (kind === "gif" && typeof template === "string" && altText !== null) {
      const reactionText = text(value.text, 120);

      if (
        gifTemplates.has(template as ReactionGifTemplate) &&
        reactionText !== null
      ) {
        return {
          kind,
          template: template as ReactionGifTemplate,
          text: reactionText,
          altText,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
};

export class VisualExpressionGenerator {
  private readonly memes: MemeGenerator;
  private readonly gifs: ReactionGifGenerator;

  public constructor(mlUrl: string) {
    this.memes = new MemeGenerator(mlUrl);
    this.gifs = new ReactionGifGenerator(mlUrl);
  }

  public render(author: string, idea: VisualIdea): Promise<GeneratedVisual> {
    return idea.kind === "meme"
      ? this.memes.render(author, idea)
      : this.gifs.render(author, idea);
  }
}
