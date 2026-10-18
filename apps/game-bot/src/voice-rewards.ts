import { randomUUID } from "node:crypto";
import type { CoreApiClient } from "@yanagi/core-api-client";

type VoiceRewardApi = Pick<CoreApiClient, "awardVoicePoint">;

type ScheduledTick = {
  timer: ReturnType<typeof setTimeout>;
  generation: number;
};

const VOICE_POINT_INTERVAL_MS = 5 * 60_000;

export class VoiceRewardScheduler {
  private readonly timers = new Map<string, ScheduledTick>();
  private generation = 0;

  constructor(
    private readonly api: VoiceRewardApi,
    private readonly reportError: (error: unknown) => void,
  ) {}

  start(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    if (this.timers.has(key)) return;
    this.schedule(guildId, userId, key);
  }

  stop(guildId: string, userId: string): void {
    const key = `${guildId}:${userId}`;
    const scheduled = this.timers.get(key);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.timers.delete(key);
  }

  stopAll(): void {
    for (const scheduled of this.timers.values()) clearTimeout(scheduled.timer);
    this.timers.clear();
  }

  private schedule(guildId: string, userId: string, key: string): void {
    const generation = ++this.generation;
    const timer = setTimeout(() => {
      const scheduled = this.timers.get(key);
      if (!scheduled || scheduled.generation !== generation) return;

      void this.api
        .awardVoicePoint({
          guildId,
          userId,
          tickId: randomUUID(),
        })
        .catch(this.reportError)
        .finally(() => {
          if (this.timers.get(key)?.generation === generation) {
            this.schedule(guildId, userId, key);
          }
        });
    }, VOICE_POINT_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(key, { timer, generation });
  }
}
