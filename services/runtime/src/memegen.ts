export type MemeTemplate = "reaction" | "contrast" | "announcement";

export interface MemeIdea {
  template: MemeTemplate;
  topText: string;
  bottomText: string;
  altText: string;
}

export interface GeneratedMeme extends MemeIdea {
  data: string;
  mediaType: string;
  filename: string;
  caption: string;
}

const templates = new Set<MemeTemplate>([
  "reaction",
  "contrast",
  "announcement",
]);

export const parseMemeIdea = (raw: string): MemeIdea | null => {
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
    const template = value.template;
    const topText = value.topText;
    const bottomText = value.bottomText;
    const altText = value.altText;

    if (
      typeof template !== "string" ||
      !templates.has(template as MemeTemplate) ||
      typeof topText !== "string" ||
      typeof bottomText !== "string" ||
      typeof altText !== "string"
    ) {
      return null;
    }

    const idea: MemeIdea = {
      template: template as MemeTemplate,
      topText: topText.trim().slice(0, 180),
      bottomText: bottomText.trim().slice(0, 180),
      altText: altText.trim().slice(0, 500),
    };

    return idea.topText.length === 0 ||
        idea.bottomText.length === 0 ||
        idea.altText.length === 0
      ? null
      : idea;
  } catch {
    return null;
  }
};

export class MemeGenerator {
  public constructor(private readonly mlUrl: string) {}

  public async render(author: string, idea: MemeIdea): Promise<GeneratedMeme> {
    const response = await fetch(
      new URL("/v1/memes/render", this.mlUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template: idea.template,
          topText: idea.topText,
          bottomText: idea.bottomText,
          author,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Meme renderer returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;

    if (
      typeof payload.data !== "string" ||
      payload.data.length === 0 ||
      payload.mediaType !== "image/svg+xml"
    ) {
      throw new Error("Meme renderer returned an invalid image");
    }

    const filenameAuthor = author
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "chat-bot";

    return {
      ...idea,
      data: payload.data,
      mediaType: payload.mediaType,
      filename: `${filenameAuthor}-meme-${Date.now()}.svg`,
      caption: `Meme by ${author}`,
    };
  }
}
