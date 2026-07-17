// Thin client over the platform's authorized write paths. Chat bots post
// like any participant; the backend stays authoritative and can refuse them
// (muted, not in room), and the runtime reacts instead of overriding.
export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  display: string;
  profilePictureId: string | null;
  profilePictureUrl: string | null;
  type: "human" | "chat_bot" | "mod_bot";
  retiredAt: string | null;
}

export interface RoomEvent {
  sequence: string;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export type ContentAddress =
  | { targetType: "room" }
  | { targetType: "actor"; actorId: string };

export type RoomContentPart =
  | { partId: string; kind: "text"; text: string; language?: string }
  | {
      partId: string;
      kind: "image" | "audio" | "video" | "file";
      mediaAssetId: string;
      caption?: string;
      altText?: string;
    };

export type InferencePart =
  | { kind: "text"; text: string }
  | {
      kind: "image" | "audio" | "video" | "file";
      data: string;
      mediaType: string;
      filename: string;
    };

interface MediaAsset {
  mediaAssetId: string;
  originalFilename: string;
  detectedMediaType?: string;
  declaredMediaType: string;
  lifecycleState: string;
}

export class PlatformError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export class PlatformClient {
  public constructor(
    private readonly apiUrl: string,
    private readonly roomId: string,
  ) {}

  private async request<Result>(
    path: string,
    init?: RequestInit & { expected?: number[] },
  ): Promise<Result> {
    const response = await fetch(new URL(path, this.apiUrl).toString(), init);
    const raw = await response.text();
    const payload = raw.length === 0 ? null : JSON.parse(raw);

    if (!(init?.expected ?? [200]).includes(response.status)) {
      const code =
        payload !== null && typeof payload.error === "string"
          ? payload.error
          : null;
      const message =
        payload !== null && typeof payload.message === "string"
          ? payload.message
          : `HTTP ${response.status}`;

      throw new PlatformError(response.status, code, message);
    }

    return payload as Result;
  }

  private post<Result>(
    path: string,
    body: unknown,
    expected: number[],
  ): Promise<Result> {
    return this.request<Result>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      expected,
    });
  }

  public async health(): Promise<void> {
    await this.request("/health");
  }

  public async ensureActor(
    handle: string,
    displayName: string,
  ): Promise<Actor> {
    try {
      const existing = await this.request<Actor>(
        `/api/actors/by-handle/${encodeURIComponent(handle)}`,
      );

      if (existing.retiredAt !== null) {
        return this.post<Actor>(
          `/api/actors/${existing.id}/restore`,
          {},
          [200],
        );
      }

      return existing;
    } catch (error) {
      if (error instanceof PlatformError && error.status === 404) {
        return this.post<Actor>(
          "/api/actors",
          { handle, displayName, type: "chat_bot" },
          [201],
        );
      }

      throw error;
    }
  }

  public getActor(actorId: string): Promise<Actor> {
    return this.request<Actor>(`/api/actors/${encodeURIComponent(actorId)}`);
  }

  public async join(actorId: string): Promise<void> {
    await this.post(
      `/api/rooms/${this.roomId}/presence`,
      { actorId, state: "joined" },
      [201],
    );
  }

  public async postMessage(
    actorId: string,
    content: string,
    replyTo?: { contentItemId: string },
    addressedTo?: ContentAddress[],
  ): Promise<void> {
    await this.post(
      `/api/rooms/${this.roomId}/messages`,
      {
        actorId,
        content,
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(addressedTo === undefined || addressedTo.length === 0
          ? {}
          : { addressedTo }),
      },
      [201],
    );
  }

  public async inferenceParts(
    parts: RoomContentPart[],
  ): Promise<InferencePart[]> {
    return Promise.all(
      parts.map(async (part): Promise<InferencePart> => {
        if (part.kind === "text") {
          return { kind: "text", text: part.text };
        }

        const path =
          `/api/rooms/${encodeURIComponent(this.roomId)}/media-assets/` +
          encodeURIComponent(part.mediaAssetId);
        const asset = await this.request<MediaAsset>(path);

        if (asset.lifecycleState !== "published") {
          throw new Error(`Media asset '${part.mediaAssetId}' is not published`);
        }

        const response = await fetch(
          new URL(`${path}/data`, this.apiUrl).toString(),
        );

        if (!response.ok) {
          throw new Error(
            `Media asset '${part.mediaAssetId}' returned HTTP ${response.status}`,
          );
        }

        return {
          kind: part.kind,
          data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          mediaType: asset.detectedMediaType ?? asset.declaredMediaType,
          filename: asset.originalFilename,
        };
      }),
    );
  }

  public async latestSequence(): Promise<string> {
    let cursor = "0";

    while (true) {
      const page = await this.request<{
        data: RoomEvent[];
        nextCursor: string;
      }>(`/api/rooms/${this.roomId}/events?after=${cursor}&limit=500`);

      if (page.data.length < 500 || page.nextCursor === cursor) {
        return page.data.at(-1)?.sequence ?? cursor;
      }

      cursor = page.nextCursor;
    }
  }

  public async recentEvents(limit: number): Promise<RoomEvent[]> {
    let cursor = "0";
    const events: RoomEvent[] = [];

    while (true) {
      const page = await this.request<{
        data: RoomEvent[];
        nextCursor: string;
      }>(`/api/rooms/${this.roomId}/events?after=${cursor}&limit=500`);

      events.push(...page.data);

      while (events.length > limit) {
        events.shift();
      }

      if (page.data.length < 500 || page.nextCursor === cursor) {
        return events;
      }

      cursor = page.nextCursor;
    }
  }
}
