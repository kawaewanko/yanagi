import type {
  CommunityGuildSettings,
  CoreApiClient,
} from "@yanagi/core-api-client";

type SettingsApi = Pick<CoreApiClient, "getCommunityGuildSettings">;
type SettingsFallback = Omit<CommunityGuildSettings, "guildId">;
type CachedSettings = { expiresAt: number; settings: SettingsFallback };

const CACHE_TTL_MS = 30_000;

export class CommunityGuildSettingsCache {
  private readonly cached = new Map<string, CachedSettings>();
  private readonly pending = new Map<string, Promise<SettingsFallback>>();

  constructor(
    private readonly api: SettingsApi,
    private readonly fallback: SettingsFallback,
    private readonly reportError: (eventName: string, error: unknown) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get(guildId: string): Promise<SettingsFallback> {
    const cached = this.cached.get(guildId);
    if (cached && cached.expiresAt > this.now())
      return Promise.resolve(cached.settings);
    const pending = this.pending.get(guildId);
    if (pending) return pending;

    const request = this.load(guildId).finally(() => {
      if (this.pending.get(guildId) === request) this.pending.delete(guildId);
    });
    this.pending.set(guildId, request);
    return request;
  }

  private async load(guildId: string): Promise<SettingsFallback> {
    let response: CommunityGuildSettings | null;
    try {
      response = await this.api.getCommunityGuildSettings(guildId);
    } catch (error) {
      this.reportError("guild-settings", error);
      response = null;
    }
    const settings = {
      welcomeChannelId:
        response?.welcomeChannelId ?? this.fallback.welcomeChannelId,
      waitingVoiceChannelId:
        response?.waitingVoiceChannelId ?? this.fallback.waitingVoiceChannelId,
      temporaryVoiceCategoryId:
        response?.temporaryVoiceCategoryId ??
        this.fallback.temporaryVoiceCategoryId,
    };
    this.cached.set(guildId, {
      settings,
      expiresAt: this.now() + CACHE_TTL_MS,
    });
    return settings;
  }
}
