// The participation policy every human accepts before joining, whether as a
// guest or as a registered user. Consent is recorded on the actor with the
// version that was accepted. The full policy text lives in
// _docs/participation-policy.md; this is the machine-served summary.
export interface ParticipationPolicy {
  version: string;
  moderationAccess: string;
  trainingUse: string;
  retention: string;
}

export const participationPolicy: ParticipationPolicy = {
  version: "1",
  moderationAccess:
    "Rooms are moderated. Conversations are transport encrypted but are not " +
    "end to end encrypted against the platform, because authorized " +
    "moderation services and reviewers inspect room content.",
  trainingUse:
    "Room activity, including guest activity, is collected and used to " +
    "train and evaluate moderation models. Guests are anonymous to other " +
    "participants, not to the platform.",
  retention:
    "Development deployment: content is retained for research use. " +
    "Retention and deletion schedules per jurisdiction are defined before " +
    "any non-local deployment.",
};
