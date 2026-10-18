import type { CoreApiClient } from "@yanagi/core-api-client";

export type TemporaryVoiceChannelHandle = {
  id: string;
  memberCount: number;
};

export type TemporaryVoiceGuild = {
  id: string;
  getMemberVoiceChannelId(userId: string): Promise<string | null>;
  createTemporaryVoiceChannel(
    ownerId: string,
  ): Promise<TemporaryVoiceChannelHandle>;
  moveMember(userId: string, channelId: string): Promise<void>;
  fetchTemporaryVoiceChannel(
    channelId: string,
  ): Promise<TemporaryVoiceChannelHandle | null>;
  deleteTemporaryVoiceChannel(channelId: string): Promise<void>;
};

type TemporaryVoiceApi = Pick<
  CoreApiClient,
  | "registerTemporaryVoiceChannel"
  | "listTemporaryVoiceChannels"
  | "markTemporaryVoiceChannelEmpty"
  | "markTemporaryVoiceChannelActive"
  | "removeTemporaryVoiceChannel"
>;

type ScheduledDeletion = {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};

const EMPTY_CHANNEL_DELAY_MS = 60_000;

export class TemporaryVoiceManager {
  private readonly managedChannels = new Set<string>();
  private readonly userOperations = new Map<string, Promise<void>>();
  private readonly channelOperations = new Map<string, Promise<void>>();
  private readonly scheduledDeletions = new Map<string, ScheduledDeletion>();
  private generation = 0;

  constructor(
    private readonly api: TemporaryVoiceApi,
    private readonly reportError: (eventName: string, error: unknown) => void,
  ) {}

  async onVoiceStateChange(
    guild: TemporaryVoiceGuild,
    userId: string,
    oldChannelId: string | null,
    newChannelId: string | null,
    waitingChannelId: string | undefined,
  ): Promise<void> {
    if (
      oldChannelId &&
      this.isManaged(guild.id, oldChannelId) &&
      oldChannelId !== newChannelId
    ) {
      const key = this.channelKey(guild.id, oldChannelId);
      await this.runExclusive(this.channelOperations, key, () =>
        this.scheduleDeletion(guild, oldChannelId),
      );
    }

    if (
      newChannelId &&
      this.isManaged(guild.id, newChannelId) &&
      oldChannelId !== newChannelId
    ) {
      const key = this.channelKey(guild.id, newChannelId);
      await this.runExclusive(this.channelOperations, key, async () => {
        this.cancelDeletion(guild.id, newChannelId);
        await this.api.markTemporaryVoiceChannelActive(guild.id, newChannelId);
      });
    }

    if (
      waitingChannelId &&
      newChannelId === waitingChannelId &&
      oldChannelId !== waitingChannelId
    ) {
      await this.runExclusive(
        this.userOperations,
        `${guild.id}:${userId}`,
        async () => {
          const currentChannelId = await guild.getMemberVoiceChannelId(userId);
          if (currentChannelId !== waitingChannelId) return;

          const channel = await guild.createTemporaryVoiceChannel(userId);
          let registered = false;
          try {
            await this.api.registerTemporaryVoiceChannel(
              guild.id,
              channel.id,
              userId,
            );
            registered = true;
            this.managedChannels.add(this.channelKey(guild.id, channel.id));
            await guild.moveMember(userId, channel.id);
          } catch (error) {
            const cleanupErrors: unknown[] = [];
            try {
              await guild.deleteTemporaryVoiceChannel(channel.id);
            } catch (cleanupError) {
              cleanupErrors.push(cleanupError);
            }
            if (registered) {
              try {
                await this.api.removeTemporaryVoiceChannel(
                  guild.id,
                  channel.id,
                );
              } catch (cleanupError) {
                cleanupErrors.push(cleanupError);
              }
              this.managedChannels.delete(
                this.channelKey(guild.id, channel.id),
              );
            }
            if (cleanupErrors.length) {
              throw new AggregateError(
                [error, ...cleanupErrors],
                "Temporary voice channel creation and rollback failed",
              );
            }
            throw error;
          }
        },
      );
    }
  }

  async reconcileGuild(guild: TemporaryVoiceGuild): Promise<void> {
    const channels = await this.api.listTemporaryVoiceChannels(guild.id);
    for (const channel of channels) {
      this.managedChannels.add(this.channelKey(guild.id, channel.channelId));
      const discordChannel = await guild.fetchTemporaryVoiceChannel(
        channel.channelId,
      );
      if (!discordChannel) {
        await this.removeRegistration(guild.id, channel.channelId);
        continue;
      }

      if (discordChannel.memberCount === 0) {
        await this.deleteIfStillEmpty(guild, channel.channelId);
      } else if (channel.deleteAfter) {
        await this.api.markTemporaryVoiceChannelActive(
          guild.id,
          channel.channelId,
        );
      }
    }
  }

  private async scheduleDeletion(
    guild: TemporaryVoiceGuild,
    channelId: string,
  ): Promise<void> {
    await this.api.markTemporaryVoiceChannelEmpty(guild.id, channelId);
    await this.cancelDeletion(guild.id, channelId);
    const key = this.channelKey(guild.id, channelId);
    const generation = ++this.generation;
    const timer = setTimeout(() => {
      const pending = this.scheduledDeletions.get(key);
      if (pending?.generation !== generation) return;
      this.scheduledDeletions.delete(key);
      void this.runExclusive(this.channelOperations, key, () =>
        this.deleteIfStillEmpty(guild, channelId),
      ).catch((error: unknown) =>
        this.reportError("temporary-voice-delete", error),
      );
    }, EMPTY_CHANNEL_DELAY_MS);
    timer.unref?.();
    this.scheduledDeletions.set(key, { timer, generation });
  }

  private cancelDeletion(guildId: string, channelId: string): void {
    const key = this.channelKey(guildId, channelId);
    const scheduled = this.scheduledDeletions.get(key);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      this.scheduledDeletions.delete(key);
    }
  }

  private async deleteIfStillEmpty(
    guild: TemporaryVoiceGuild,
    channelId: string,
  ): Promise<void> {
    const key = this.channelKey(guild.id, channelId);
    const channel = await guild.fetchTemporaryVoiceChannel(channelId);
    if (channel && channel.memberCount > 0) {
      await this.api.markTemporaryVoiceChannelActive(guild.id, channelId);
      return;
    }

    if (channel) await guild.deleteTemporaryVoiceChannel(channelId);
    await this.api.removeTemporaryVoiceChannel(guild.id, channelId);
    this.managedChannels.delete(key);
  }

  async onChannelDeleted(guildId: string, channelId: string): Promise<void> {
    if (!this.isManaged(guildId, channelId)) return;
    const key = this.channelKey(guildId, channelId);
    await this.runExclusive(this.channelOperations, key, async () => {
      this.cancelDeletion(guildId, channelId);
      await this.api.removeTemporaryVoiceChannel(guildId, channelId);
      this.managedChannels.delete(key);
    });
  }

  private async removeRegistration(
    guildId: string,
    channelId: string,
  ): Promise<void> {
    return this.onChannelDeleted(guildId, channelId);
  }

  private isManaged(guildId: string, channelId: string): boolean {
    return this.managedChannels.has(this.channelKey(guildId, channelId));
  }

  private channelKey(guildId: string, channelId: string): string {
    return `${guildId}:${channelId}`;
  }

  private async runExclusive(
    operations: Map<string, Promise<void>>,
    key: string,
    action: () => Promise<void>,
  ): Promise<void> {
    const previous = operations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    operations.set(key, current);
    try {
      await current;
    } finally {
      if (operations.get(key) === current) operations.delete(key);
    }
  }
}
