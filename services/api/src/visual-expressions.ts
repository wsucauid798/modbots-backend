export type MemeTemplate = "reaction" | "contrast" | "announcement";
export type ReactionGifTemplate =
  | "celebrate"
  | "laugh"
  | "side_eye"
  | "facepalm";

export interface RenderedVisualExpression {
  data: string;
  mediaType: "image/svg+xml" | "image/gif";
  width: number;
  height: number;
}

export interface VisualExpressionService {
  renderMeme(request: {
    template: MemeTemplate;
    topText: string;
    bottomText: string;
    author: string;
  }): Promise<RenderedVisualExpression>;
  renderReactionGif(request: {
    template: ReactionGifTemplate;
    text: string;
    author: string;
  }): Promise<RenderedVisualExpression>;
}

const readRenderedVisual = async (
  response: Response,
  expectedMediaType: RenderedVisualExpression["mediaType"],
): Promise<RenderedVisualExpression> => {
  if (!response.ok) {
    throw new Error(`Visual renderer returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;

  if (
    typeof payload.data !== "string" ||
    payload.data.length === 0 ||
    payload.mediaType !== expectedMediaType ||
    typeof payload.width !== "number" ||
    !Number.isInteger(payload.width) ||
    payload.width < 1 ||
    typeof payload.height !== "number" ||
    !Number.isInteger(payload.height) ||
    payload.height < 1
  ) {
    throw new Error("Visual renderer returned an invalid image");
  }

  return {
    data: payload.data,
    mediaType: expectedMediaType,
    width: payload.width,
    height: payload.height,
  };
};

export class MlVisualExpressionService implements VisualExpressionService {
  public constructor(private readonly mlUrl: string) {}

  public async renderMeme(request: {
    template: MemeTemplate;
    topText: string;
    bottomText: string;
    author: string;
  }): Promise<RenderedVisualExpression> {
    const response = await fetch(
      new URL("/v1/memes/render", this.mlUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );

    return readRenderedVisual(response, "image/svg+xml");
  }

  public async renderReactionGif(request: {
    template: ReactionGifTemplate;
    text: string;
    author: string;
  }): Promise<RenderedVisualExpression> {
    const response = await fetch(
      new URL("/v1/reaction-gifs/render", this.mlUrl).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );

    return readRenderedVisual(response, "image/gif");
  }
}
