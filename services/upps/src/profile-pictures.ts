import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProfilePicture {
  id: string;
  source: "platform" | "user";
  contentType: "image/jpeg" | "image/png" | "image/webp";
  file: string;
}

const profilePictures: Record<string, ProfilePicture> = {
  "resident-arwen": {
    id: "resident-arwen",
    source: "platform",
    contentType: "image/webp",
    file: "residents/arwen.webp",
  },
  "resident-bob": {
    id: "resident-bob",
    source: "platform",
    contentType: "image/webp",
    file: "residents/bob.webp",
  },
  "resident-felix": {
    id: "resident-felix",
    source: "platform",
    contentType: "image/webp",
    file: "residents/felix.webp",
  },
  "resident-iris": {
    id: "resident-iris",
    source: "platform",
    contentType: "image/webp",
    file: "residents/iris-mod.webp",
  },
  "resident-jacob": {
    id: "resident-jacob",
    source: "platform",
    contentType: "image/webp",
    file: "residents/jacob.webp",
  },
  "resident-milo": {
    id: "resident-milo",
    source: "platform",
    contentType: "image/webp",
    file: "residents/milo-mod.webp",
  },
  "resident-ru-bot": {
    id: "resident-ru-bot",
    source: "platform",
    contentType: "image/webp",
    file: "residents/ru.webp",
  },
  "resident-vera": {
    id: "resident-vera",
    source: "platform",
    contentType: "image/webp",
    file: "residents/vera-mod.webp",
  },
};

const userPictureId = /^user-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userPictureFormats = [
  { contentType: "image/png" as const, extension: "png" },
  { contentType: "image/jpeg" as const, extension: "jpg" },
  { contentType: "image/webp" as const, extension: "webp" },
];

const uploadedFile = (
  publicDir: string,
  id: string,
  extension: string,
): string => path.join(publicDir, "profile-pictures", "uploads", `${id}.${extension}`);

export const detectedProfilePictureType = (
  data: Buffer,
): ProfilePicture["contentType"] | null => {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }

  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) {
    return "image/jpeg";
  }

  if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
};

export const createUserProfilePicture = async (
  publicDir: string,
  data: Buffer,
): Promise<ProfilePicture> => {
  const contentType = detectedProfilePictureType(data);
  const format = userPictureFormats.find(
    (candidate) => candidate.contentType === contentType,
  );

  if (format === undefined) {
    throw new Error("unsupported_profile_picture_type");
  }

  const id = `user-${randomUUID()}`;
  const relativeFile = `uploads/${id}.${format.extension}`;
  const directory = path.join(publicDir, "profile-pictures", "uploads");

  await mkdir(directory, { recursive: true });
  await writeFile(path.join(publicDir, "profile-pictures", relativeFile), data, {
    flag: "wx",
  });

  return {
    id,
    source: "user",
    contentType: format.contentType,
    file: relativeFile,
  };
};

export const profilePictureById = async (
  id: string,
  publicDir: string,
): Promise<ProfilePicture | null> => {
  const platformPicture = profilePictures[id];

  if (platformPicture !== undefined) {
    return platformPicture;
  }

  if (!userPictureId.test(id)) {
    return null;
  }

  for (const format of userPictureFormats) {
    try {
      const file = await stat(uploadedFile(publicDir, id, format.extension));

      if (file.isFile()) {
        return {
          id,
          source: "user",
          contentType: format.contentType,
          file: `uploads/${id}.${format.extension}`,
        };
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  return null;
};

export const removeUserProfilePicture = async (
  id: string,
  publicDir: string,
): Promise<boolean> => {
  if (!userPictureId.test(id)) {
    return false;
  }

  for (const format of userPictureFormats) {
    try {
      await unlink(uploadedFile(publicDir, id, format.extension));
      return true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }

  return false;
};
