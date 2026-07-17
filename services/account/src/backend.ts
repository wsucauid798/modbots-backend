// Thin client over the platform backend. The account surface owns no
// identity data: registration, credential checks, and policy text all live
// in the one backend.
export interface Actor {
  id: string;
  handle: string | null;
  displayName: string;
  display: string;
  profilePictureId: string | null;
  profilePictureUrl: string | null;
  type: string;
  registered: boolean;
  retiredAt: string | null;
}

export interface ParticipationPolicy {
  version: string;
  title?: string;
  summary?: string;
  moderationAccess?: string;
  trainingUse?: string;
  retention?: string;
}

export class BackendError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export class BackendClient {
  public constructor(private readonly baseUrl: string) {}

  private async request<Result>(
    path: string,
    init?: RequestInit,
  ): Promise<Result> {
    const response = await fetch(new URL(path, this.baseUrl), init);
    const raw = await response.text();
    const payload = raw.length === 0 ? null : JSON.parse(raw);

    if (!response.ok) {
      const code =
        payload !== null && typeof payload.error === "string"
          ? payload.error
          : null;
      const message =
        payload !== null && typeof payload.message === "string"
          ? payload.message
          : `Backend returned HTTP ${response.status}`;

      throw new BackendError(response.status, code, message);
    }

    return payload as Result;
  }

  public health(): Promise<unknown> {
    return this.request("/health");
  }

  public policy(): Promise<ParticipationPolicy> {
    return this.request("/api/policy");
  }

  public getActor(actorId: string): Promise<Actor> {
    return this.request(`/api/actors/${encodeURIComponent(actorId)}`);
  }

  public async verifyCredentials(
    username: string,
    password: string,
    acceptPolicy: boolean,
  ): Promise<Actor | null> {
    try {
      const result = await this.request<{ actor: Actor }>(
        "/api/credentials/verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password, acceptPolicy }),
        },
      );

      return result.actor;
    } catch (error) {
      if (error instanceof BackendError && error.status === 401) {
        return null;
      }

      throw error;
    }
  }

  public createGuest(displayName: string | null): Promise<{ actor: Actor }> {
    return this.request("/api/guests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        acceptPolicy: true,
        ...(displayName === null ? {} : { displayName }),
      }),
    });
  }

  // The backend records the accepted policy version itself; acceptance is
  // the only thing the client asserts.
  public register(request: {
    username: string;
    displayName: string | null;
    password: string;
  }): Promise<{ actor: Actor }> {
    return this.request("/api/registrations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: request.username,
        ...(request.displayName === null
          ? {}
          : { displayName: request.displayName }),
        password: request.password,
        acceptPolicy: true,
      }),
    });
  }
}
