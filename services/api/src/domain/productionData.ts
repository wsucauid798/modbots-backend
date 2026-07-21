const forbiddenActorIds = new Set([
  "realtime-human",
  "smoke-human",
  "desktop-user",
  "smoke-chat-bot",
  "smoke-mod-bot",
]);

const forbiddenDisplayNames = new Set([
  "realtime human",
  "smoke test human",
  "smoke test chat bot",
  "smoke test mod bot",
  "desktop user",
  "renamed probe",
  "session probe",
  "replycheck",
  "web user",
  "handoff user",
]);

const forbiddenDisplayNamePrefixes = [
  "copilot test",
  "addrprobe",
  "oidcuser",
  "logincheck",
  "inline",
  "stale",
  "regress",
];

const forbiddenHandlePrefixes = [
  "smoke-",
  "copilot",
  "oidcuser",
  "logincheck",
  "inline",
  "stale",
  "regress",
];

export interface ActorIdentityInput {
  id?: string | null;
  displayName: string;
  handle?: string | null;
}

const normalized = (value: string | null | undefined): string =>
  (value ?? "").trim().toLowerCase();

export const devActorIdentityReason = (
  actor: ActorIdentityInput,
): string | null => {
  const id = normalized(actor.id);
  const displayName = normalized(actor.displayName);
  const handle = normalized(actor.handle);

  if (forbiddenActorIds.has(id)) {
    return `actor id '${actor.id}' is reserved for dev and test data`;
  }

  if (forbiddenDisplayNames.has(displayName)) {
    return `display name '${actor.displayName}' is reserved for dev and test data`;
  }

  if (
    forbiddenDisplayNamePrefixes.some((prefix) =>
      displayName.startsWith(prefix),
    )
  ) {
    return `display name '${actor.displayName}' uses a dev or test prefix`;
  }

  if (
    handle.length > 0 &&
    forbiddenHandlePrefixes.some((prefix) => handle.startsWith(prefix))
  ) {
    return `handle '${actor.handle}' uses a dev or test prefix`;
  }

  return null;
};
