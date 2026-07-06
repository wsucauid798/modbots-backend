export interface ProfilePicture {
  id: string;
  source: "platform";
  contentType: "image/webp";
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

export const profilePictureById = (id: string): ProfilePicture | null =>
  profilePictures[id] ?? null;
