// Thin client over the platform's authorized write paths. Chat bots post
// like any participant; the backend stays authoritative and can refuse them
// (muted, not in room), and the runtime reacts instead of overriding.
export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  display: string;
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
  ): Promise<void> {
    await this.post(
      `/api/rooms/${this.roomId}/messages`,
      {
        actorId,
        content,
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      [201],
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
}
