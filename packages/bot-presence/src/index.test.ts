import { afterEach, describe, expect, it, vi } from "vitest";
import { BotPresenceController, type WatchingPresence } from "./index.js";

describe("BotPresenceController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("updates the watching activity every 1 second", () => {
    vi.useFakeTimers();

    let ping = 42.4;
    const setPresence = vi.fn<(presence: WatchingPresence) => void>();

    const controller = new BotPresenceController({
      getPing: () => ping,
      activityLabel: "RSS・Webhook・管理",
      setPresence,
      intervalMilliseconds: 1_000,
    });

    controller.start();

    expect(setPresence).toHaveBeenCalledTimes(1);
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: {
        name: "/help | 42ms | RSS・Webhook・管理",
        type: 3,
      },
      status: "online",
    });

    ping = 78;
    vi.advanceTimersByTime(999);

    expect(setPresence).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);

    expect(setPresence).toHaveBeenCalledTimes(2);
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: {
        name: "/help | 78ms | RSS・Webhook・管理",
        type: 3,
      },
      status: "online",
    });

    ping = 100;
    vi.advanceTimersByTime(1_000);

    expect(setPresence).toHaveBeenCalledTimes(3);
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: {
        name: "/help | 100ms | RSS・Webhook・管理",
        type: 3,
      },
      status: "online",
    });

    controller.stop();

    vi.advanceTimersByTime(2_000);
    expect(setPresence).toHaveBeenCalledTimes(3);
  });

  it("keeps an error presence sticky while allowing a critical incident to take precedence", () => {
    const setPresence = vi.fn<(presence: WatchingPresence) => void>();

    const controller = new BotPresenceController({
      getPing: () => 10,
      activityLabel: "まぶ",
      setPresence,
      intervalMilliseconds: 1_000,
    });

    controller.start();

    controller.reportError();

    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "⚠️ 不具合発生", type: 3 },
      status: "online",
    });

    controller.reportError();
    expect(setPresence).toHaveBeenCalledTimes(3);

    controller.reportIncident();

    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "🚨 インシデント発生", type: 3 },
      status: "online",
    });

    controller.reportError();

    expect(setPresence).toHaveBeenCalledTimes(4);
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "🚨 インシデント発生", type: 3 },
      status: "online",
    });

    controller.stop();
  });

  it("reports presence update failures and retries on the next interval", () => {
    vi.useFakeTimers();

    const error = new Error("presence failed");
    const reportUpdateError = vi.fn();

    const setPresence = vi
      .fn<(presence: WatchingPresence) => void>()
      .mockImplementationOnce(() => {
        throw error;
      });

    const controller = new BotPresenceController({
      getPing: () => -1,
      activityLabel: "まぶ",
      setPresence,
      intervalMilliseconds: 1_000,
      reportUpdateError,
    });

    controller.start();

    expect(reportUpdateError).toHaveBeenCalledWith(error);

    vi.advanceTimersByTime(1_000);

    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "⚠️ 不具合発生", type: 3 },
      status: "online",
    });

    controller.stop();
  });

  it("rejects an invalid refresh interval", () => {
    expect(
      () =>
        new BotPresenceController({
          getPing: () => 0,
          activityLabel: "まぶ",
          setPresence: () => undefined,
          intervalMilliseconds: 0,
        }),
    ).toThrow(RangeError);
  });
});
