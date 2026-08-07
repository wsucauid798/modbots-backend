export type ReactionGifTemplate =
  | "celebrate"
  | "laugh"
  | "side_eye"
  | "facepalm";

export interface ReactionGifIdea {
  template: ReactionGifTemplate;
  text: string;
  altText: string;
}

export interface GeneratedReactionGif extends ReactionGifIdea {
  data: string;
  mediaType: "image/gif";
  filename: string;
  caption: string;
}

export class ReactionGifGenerator {
  public constructor(private readonly mlUrl: string) {}

  public async render(
    author: string,
    idea: ReactionGifIdea,
  ): Promise<GeneratedReactionGif> {
    const response = await fetch(
      new URL("/v1/reaction-gifs/render", this.mlUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          template: idea.template,
          text: idea.text,
          author,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Reaction GIF renderer returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;

    if (
      typeof payload.data !== "string" ||
      payload.data.length === 0 ||
      payload.mediaType !== "image/gif"
    ) {
      throw new Error("Reaction GIF renderer returned an invalid image");
    }

    const filenameAuthor = author
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "chat-bot";

    return {
      ...idea,
      data: payload.data,
      mediaType: "image/gif",
      filename: `${filenameAuthor}-reaction-${Date.now()}.gif`,
      caption: `Reaction GIF by ${author}`,
    };
  }
}
