import { afterEach, describe, expect, it, vi } from "vitest";
import type { TemporaryVoiceChannel } from "@yanagi/core-api-client";
import {
  TemporaryVoiceManager,
  type TemporaryVoiceGuild,
} from "./temporary-voice.js";

function createFixture() {
  let memberChannel: string | null = "waiting";
  const channels = new Map<string, { id: string; memberCount: number }>();
  const api = {
    registerTemporaryVoiceChannel: vi.fn(
      async (_guildId: string, channelId: string, ownerId: string) => ({
        registered: true as const,
        channelId,
        ownerId,
        deleteAfter: null,
      }),
    ),
    listTemporaryVoiceChannels: vi.fn<() => Promise<TemporaryVoiceChannel[]>>(
      async () => [],
    ),
    markTemporaryVoiceChannelEmpty: vi.fn(async () => ({
      deleteAfter: new Date().toISOString(),
    })),
    markTemporaryVoiceChannelActive: vi.fn(
      async (_guildId: string, channelId: string) => ({
        active: true as const,
        channelId,
      }),
    ),
    removeTemporaryVoiceChannel: vi.fn(async () => undefined),
  };
  const guild: TemporaryVoiceGuild = {
    id: "guild-1",
    getMemberVoiceChannelId: vi.fn(async () => memberChannel),
    createTemporaryVoiceChannel: vi.fn(async () => {
      const channel = { id: "temporary-1", memberCount: 0 };
      channels.set(channel.id, channel);
      return channel;
    }),
    moveMember: vi.fn(async (_userId: string, channelId: string) => {
      memberChannel = channelId;
      const channel = channels.get(channelId);
      if (channel) channel.memberCount = 1;
    }),
    fetchTemporaryVoiceChannel: vi.fn(
      async (channelId: string) => channels.get(channelId) ?? null,
    ),
    deleteTemporaryVoiceChannel: vi.fn(async (channelId: string) => {
      channels.delete(channelId);
    }),
  };
  const reportError = vi.fn();
  const manager = new TemporaryVoiceManager(api, reportError);
  return {
    api,
    guild,
    manager,
    reportError,
    channels,
    setMemberChannel: (value: string | null) => {
      memberChannel = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TemporaryVoiceManager", () => {
  it("creates only one room when duplicate waiting-room events race for the same member", async () => {
    const { api, guild, manager } = createFixture();
    const event = () =>
      manager.onVoiceStateChange(guild, "user-1", null, "waiting", "waiting");

    await Promise.all([event(), event()]);

    expect(guild.createTemporaryVoiceChannel).toHaveBeenCalledTimes(1);
    expect(api.registerTemporaryVoiceChannel).toHaveBeenCalledTimes(1);
    expect(guild.moveMember).toHaveBeenCalledTimes(1);
  });

  it("deletes an empty temporary room only after the 60-second delay", async () => {
    vi.useFakeTimers();
    const { api, guild, manager } = createFixture();
    await manager.onVoiceStateChange(
      guild,
      "user-1",
      null,
      "waiting",
      "waiting",
    );
    const stored = await guild.fetchTemporaryVoiceChannel("temporary-1");
    if (!stored) throw new Error("Expected created temporary voice channel");
    stored.memberCount = 0;

    await manager.onVoiceStateChange(
      guild,
      "user-1",
      stored.id,
      null,
      "waiting",
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(guild.deleteTemporaryVoiceChannel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(guild.deleteTemporaryVoiceChannel).toHaveBeenCalledWith(stored.id);
    expect(api.removeTemporaryVoiceChannel).toHaveBeenCalledWith(
      guild.id,
      stored.id,
    );
  });

  it("cancels delayed deletion when a member returns to the room", async () => {
    vi.useFakeTimers();
    const { api, guild, manager } = createFixture();
    await manager.onVoiceStateChange(
      guild,
      "user-1",
      null,
      "waiting",
      "waiting",
    );
    const channelId = "temporary-1";
    const channel = await guild.fetchTemporaryVoiceChannel(channelId);
    if (!channel) throw new Error("Expected created temporary voice channel");
    channel.memberCount = 0;
    await manager.onVoiceStateChange(
      guild,
      "user-1",
      channelId,
      null,
      "waiting",
    );

    channel.memberCount = 1;
    await manager.onVoiceStateChange(
      guild,
      "user-2",
      null,
      channelId,
      "waiting",
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(api.markTemporaryVoiceChannelActive).toHaveBeenCalledWith(
      guild.id,
      channelId,
    );
    expect(guild.deleteTemporaryVoiceChannel).not.toHaveBeenCalled();
    expect(api.removeTemporaryVoiceChannel).not.toHaveBeenCalled();
  });

  it("removes orphaned registrations and deletes empty rooms after a restart", async () => {
    const { api, guild, manager, channels } = createFixture();
    const existingChannel = { id: "temporary-1", memberCount: 0 };
    channels.set(existingChannel.id, existingChannel);
    api.listTemporaryVoiceChannels.mockResolvedValue([
      {
        channelId: existingChannel.id,
        ownerId: "user-1",
        createdAt: new Date().toISOString(),
        deleteAfter: null,
      },
      {
        channelId: "missing-channel",
        ownerId: "user-2",
        createdAt: new Date().toISOString(),
        deleteAfter: null,
      },
    ]);
    await manager.reconcileGuild(guild);

    expect(guild.deleteTemporaryVoiceChannel).toHaveBeenCalledWith(
      existingChannel.id,
    );
    expect(api.removeTemporaryVoiceChannel).toHaveBeenCalledWith(
      guild.id,
      existingChannel.id,
    );
    expect(api.removeTemporaryVoiceChannel).toHaveBeenCalledWith(
      guild.id,
      "missing-channel",
    );
  });
});
