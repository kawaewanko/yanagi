import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceRewardScheduler } from "./voice-rewards.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("VoiceRewardScheduler", () => {
  it("awards one point after five minutes and then schedules the next interval", async () => {
    vi.useFakeTimers();
    const api = {
      awardVoicePoint: vi.fn().mockResolvedValue({ awarded: true, points: 1 }),
    };
    const scheduler = new VoiceRewardScheduler(api, vi.fn());
    scheduler.start("guild-1", "user-1");
    scheduler.start("guild-1", "user-1");

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(api.awardVoicePoint).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(api.awardVoicePoint).toHaveBeenCalledTimes(1),
    );
    expect(api.awardVoicePoint).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        userId: "user-1",
        tickId: expect.any(String),
      }),
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() =>
      expect(api.awardVoicePoint).toHaveBeenCalledTimes(2),
    );
    scheduler.stopAll();
  });

  it("stops awarding after a member leaves voice", async () => {
    vi.useFakeTimers();
    const api = {
      awardVoicePoint: vi.fn().mockResolvedValue({ awarded: true, points: 1 }),
    };
    const scheduler = new VoiceRewardScheduler(api, vi.fn());
    scheduler.start("guild-1", "user-1");
    scheduler.stop("guild-1", "user-1");

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(api.awardVoicePoint).not.toHaveBeenCalled();
  });

  it("reports failures and continues the five-minute schedule", async () => {
    vi.useFakeTimers();
    const error = new Error("Core API unavailable");
    const api = {
      awardVoicePoint: vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ awarded: true, points: 1 }),
    };
    const reportError = vi.fn();
    const scheduler = new VoiceRewardScheduler(api, reportError);
    scheduler.start("guild-1", "user-1");

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(error));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() =>
      expect(api.awardVoicePoint).toHaveBeenCalledTimes(2),
    );
    scheduler.stopAll();
  });
});
