import { describe, expect, it, vi } from "vitest";
import type { CommunityGuildSettings } from "@yanagi/core-api-client";
import { CommunityGuildSettingsCache } from "./guild-settings.js";

const fallback = {
  welcomeChannelId: "env-welcome",
  waitingVoiceChannelId: "env-waiting",
  temporaryVoiceCategoryId: null,
};

function settings(
  overrides: Partial<CommunityGuildSettings> = {},
): CommunityGuildSettings {
  return {
    guildId: "guild-1",
    welcomeChannelId: null,
    waitingVoiceChannelId: "guild-waiting",
    temporaryVoiceCategoryId: "guild-category",
    ...overrides,
  };
}

describe("CommunityGuildSettingsCache", () => {
  it("combines per-guild overrides with environment fallbacks and caches them", async () => {
    const api = { getCommunityGuildSettings: vi.fn(async () => settings()) };
    const cache = new CommunityGuildSettingsCache(api, fallback, vi.fn());

    const first = await cache.get("guild-1");
    const second = await cache.get("guild-1");

    expect(first).toEqual({
      welcomeChannelId: "env-welcome",
      waitingVoiceChannelId: "guild-waiting",
      temporaryVoiceCategoryId: "guild-category",
    });
    expect(second).toEqual(first);
    expect(api.getCommunityGuildSettings).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent requests and refreshes settings after the cache expires", async () => {
    let now = 0;
    const api = { getCommunityGuildSettings: vi.fn(async () => settings()) };
    const cache = new CommunityGuildSettingsCache(
      api,
      fallback,
      vi.fn(),
      () => now,
    );

    await Promise.all([cache.get("guild-1"), cache.get("guild-1")]);
    now = 30_001;
    await cache.get("guild-1");

    expect(api.getCommunityGuildSettings).toHaveBeenCalledTimes(2);
  });

  it("reports API errors and keeps the existing environment-based behavior", async () => {
    const error = new Error("Core API unavailable");
    const api = {
      getCommunityGuildSettings: vi.fn(async () => {
        throw error;
      }),
    };
    const reportError = vi.fn();
    const cache = new CommunityGuildSettingsCache(api, fallback, reportError);

    await expect(cache.get("guild-1")).resolves.toEqual(fallback);
    expect(reportError).toHaveBeenCalledWith("guild-settings", error);
  });
});
