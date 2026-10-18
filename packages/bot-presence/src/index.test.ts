import { afterEach, describe, expect, it, vi } from "vitest";
import { BotPresenceController, type WatchingPresence } from "./index.js";

describe("BotPresenceController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the watching activity with the current latency and refreshes every 15 seconds", () => {
    vi.useFakeTimers();
    let ping = 42.4;
    const setPresence = vi.fn<(presence: WatchingPresence) => void>();
    const controller = new BotPresenceController({
      getPing: () => ping,
      activityLabel: "RSS・Webhook・管理",
      setPresence,
    });

    controller.start();
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "/help | 42ms | RSS・Webhook・管理", type: 3 },
      status: "online",
    });

    ping = 78;
    vi.advanceTimersByTime(14_999);
    expect(setPresence).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "/help | 78ms | RSS・Webhook・管理", type: 3 },
      status: "online",
    });

    controller.stop();
  });

  it("keeps an error presence sticky while allowing a critical incident to take precedence", () => {
    const setPresence = vi.fn<(presence: WatchingPresence) => void>();
    const controller = new BotPresenceController({
      getPing: () => 10,
      activityLabel: "まぶ",
      setPresence,
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
    controller.reportError();
    expect(setPresence).toHaveBeenLastCalledWith({
      activity: { name: "🚨 インシデント発生", type: 3 },
      status: "online",
    });
    expect(setPresence).toHaveBeenCalledTimes(4);
    controller.stop();
  });

  it("reports failures from the Discord presence update instead of swallowing them", () => {
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
      intervalMilliseconds: 15_000,
      reportUpdateError,
    });

    vi.useFakeTimers();
    controller.start();
    expect(reportUpdateError).toHaveBeenCalledWith(error);
    vi.advanceTimersByTime(15_000);
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
