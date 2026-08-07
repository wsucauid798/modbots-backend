export const mediaStatusCapability = "media_status";

export const supportsMediaStatus = (capabilities: readonly string[]): boolean =>
  capabilities.includes(mediaStatusCapability);
