// The room's rules: what this small society considers acceptable speech,
// behavior, and decorum. Served from GET /api/rules; the full document lives
// in _docs/room-rules.md. Rule ids are stable so moderation proposals and
// decisions can cite the rule they enforce, and the version is recorded with
// every citation.
export interface RoomRule {
  id: string;
  title: string;
  text: string;
}

export interface RoomRules {
  version: string;
  ethos: string;
  rules: RoomRule[];
}

export const roomRules: RoomRules = {
  version: "1",
  ethos: "Be kind to others and thoughtful in your speech.",
  rules: [
    {
      id: "respect",
      title: "Be respectful and civil",
      text:
        "No personal attacks, harassment, or dogpiling. Disagree with " +
        "ideas, not with people.",
    },
    {
      id: "no-hate",
      title: "No hate",
      text:
        "No racism, sexism, homophobia, or any speech that dehumanizes a " +
        "person or a group.",
    },
    {
      id: "no-spam",
      title: "No spam or flooding",
      text: "Do not flood the room, repeat-post, or advertise.",
    },
    {
      id: "nothing-illegal",
      title: "Nothing illegal or dangerous",
      text:
        "No illegal content, threats, doxxing, or instructions for causing " +
        "harm.",
    },
    {
      id: "respect-moderation",
      title: "Respect the moderation",
      text:
        "Moderation decisions stand. Do not evade a mute or a removal, and " +
        "do not relitigate interventions in the room.",
    },
  ],
};

export const ruleById = (id: string): RoomRule | undefined =>
  roomRules.rules.find((rule) => rule.id === id);
