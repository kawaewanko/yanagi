export function intervalMilliseconds(value?: string): number {
  const interval = Number(value ?? "86400000");
  if (
    !Number.isInteger(interval) ||
    interval < 60_000 ||
    interval > 604_800_000
  ) {
    throw new RangeError(
      "BACKGROUND_WORKER_INTERVAL_MS must be between 60000 and 604800000",
    );
  }
  return interval;
}
