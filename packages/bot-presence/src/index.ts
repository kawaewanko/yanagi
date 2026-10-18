export type WatchingPresence = {
  activity: { name: string; type: 3 };
  status: "online";
};

export type BotPresenceOptions = {
  getPing: () => number;
  activityLabel: string;
  setPresence: (presence: WatchingPresence) => void;
  intervalMilliseconds?: number;
  reportUpdateError?: (error: unknown) => void;
};

type PresenceState = "online" | "error" | "incident";

export class BotPresenceController {
  private state: PresenceState = "online";
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMilliseconds: number;
  private readonly activityLabel: string;

  constructor(private readonly options: BotPresenceOptions) {
    this.activityLabel = options.activityLabel.trim();
    if (!this.activityLabel || this.activityLabel.length > 100) {
      throw new RangeError("Presence activity label must be 1-100 characters");
    }
    this.intervalMilliseconds = options.intervalMilliseconds ?? 15_000;
    if (
      !Number.isInteger(this.intervalMilliseconds) ||
      this.intervalMilliseconds < 1
    ) {
      throw new RangeError(
        "Presence update interval must be a positive integer",
      );
    }
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMilliseconds);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  reportError(): void {
    if (this.state === "incident") return;
    this.state = "error";
    this.refresh();
  }

  reportIncident(): void {
    this.state = "incident";
    this.refresh();
  }

  private refresh(): void {
    let text: string;
    if (this.state === "incident") {
      text = "🚨 インシデント発生";
    } else if (this.state === "error") {
      text = "⚠️ 不具合発生";
    } else {
      const ping = this.options.getPing();
      const milliseconds =
        Number.isFinite(ping) && ping >= 0 ? `${Math.round(ping)}ms` : "N/Ams";
      text = `/help | ${milliseconds} | ${this.activityLabel}`;
    }

    try {
      this.options.setPresence({
        activity: { name: text, type: 3 },
        status: "online",
      });
    } catch (error) {
      if (this.state !== "incident") this.state = "error";
      this.options.reportUpdateError?.(error);
    }
  }
}
