export interface UploadedProfilePicture {
  profilePictureId: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
}

export interface ProfilePictureStore {
  upload(data: string): Promise<UploadedProfilePicture>;
  remove(profilePictureId: string): Promise<boolean>;
}

export class ProfilePictureStoreError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ProfilePictureStoreError";
  }
}

export class UppsProfilePictureStore implements ProfilePictureStore {
  public constructor(
    private readonly baseUrl: string,
    private readonly serviceToken: string,
  ) {}

  public async upload(data: string): Promise<UploadedProfilePicture> {
    const response = await fetch(
      new URL("/internal/profile-pictures", this.baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ data }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      throw await this.error(response);
    }

    return (await response.json()) as UploadedProfilePicture;
  }

  public async remove(profilePictureId: string): Promise<boolean> {
    const response = await fetch(
      new URL(
        `/internal/profile-pictures/${encodeURIComponent(profilePictureId)}`,
        this.baseUrl,
      ),
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      throw await this.error(response);
    }

    return true;
  }

  private async error(response: Response): Promise<ProfilePictureStoreError> {
    let message = `UPPS returned HTTP ${response.status}`;

    try {
      const body = (await response.json()) as { message?: unknown };

      if (typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      // The status still identifies the UPPS failure.
    }

    return new ProfilePictureStoreError(response.status, message);
  }
}
