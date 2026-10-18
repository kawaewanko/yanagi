export function voiceChange(
  oldState: { channelId: string | null },
  newState: { channelId: string | null },
): {
  channelId: string | null;
  action: "join" | "leave" | "move";
} | null {
  const previous = oldState.channelId;
  const current = newState.channelId;
  if (previous === current) return null;
  if (!previous && current) return { channelId: current, action: "join" };
  if (previous && !current) return { channelId: previous, action: "leave" };
  return { channelId: current, action: "move" };
}
