import { describe, expect, it } from "vitest";
import { voiceChange } from "./voice-events.js";

function state(channelId: string | null): { channelId: string | null } {
  return { channelId };
}

describe("voiceChange", () => {
  it("detects joining a voice channel", () => {
    expect(voiceChange(state(null), state("channel-a"))).toEqual({
      channelId: "channel-a",
      action: "join",
    });
  });

  it("detects leaving and records the channel that was left", () => {
    expect(voiceChange(state("channel-a"), state(null))).toEqual({
      channelId: "channel-a",
      action: "leave",
    });
  });

  it("detects moving to another channel and uses the destination channel", () => {
    expect(voiceChange(state("channel-a"), state("channel-b"))).toEqual({
      channelId: "channel-b",
      action: "move",
    });
  });

  it("ignores voice updates that do not change the channel", () => {
    expect(voiceChange(state("channel-a"), state("channel-a"))).toBeNull();
  });
});
