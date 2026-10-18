import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CoreApiClient } from "@yanagi/core-api-client";
import { synthesizeVoicevox, TtsSynthesisError } from "./engine.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const engineUrl = required("VOICEVOX_URL");
const speakerId = Number(process.env.VOICEVOX_SPEAKER ?? "1");
if (!Number.isInteger(speakerId) || speakerId < 0)
  throw new RangeError("VOICEVOX_SPEAKER must be a non-negative integer");
const audioDirectory =
  process.env.TTS_AUDIO_DIR?.trim() || "/var/lib/yanagi/tts";
const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_TTS");
const api = new CoreApiClient({
  baseUrl: coreApiUrl,
  apiKey: coreApiKey,
  timeoutMs: 30_000,
});
let stopped = false;

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: "tts" }),
  });
}

void sendHeartbeat().catch(() => undefined);
const heartbeat = setInterval(
  () => void sendHeartbeat().catch(() => undefined),
  30_000,
);
heartbeat.unref();

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processJob(): Promise<boolean> {
  const job = await api.claimTtsJob();
  if (!job) return false;
  try {
    const audio = await synthesizeVoicevox(job.text, engineUrl, speakerId);
    await mkdir(audioDirectory, { recursive: true });
    await writeFile(join(audioDirectory, `${job.jobId}.wav`), audio);
    await api.completeTtsJob(job.jobId);
    console.info(
      JSON.stringify({
        event: "tts-job-succeeded",
        jobId: job.jobId,
        attempt: job.attempts,
      }),
    );
  } catch (error) {
    const errorCode =
      error instanceof TtsSynthesisError ? error.code : "worker_error";
    try {
      const result = await api.failTtsJob(job.jobId, errorCode);
      console.error(
        JSON.stringify({
          event: "tts-job-failed",
          jobId: job.jobId,
          attempt: job.attempts,
          errorCode,
          status: result.status,
        }),
      );
    } catch (reportError) {
      const message =
        reportError instanceof Error ? reportError.message : "Unknown error";
      console.error(
        JSON.stringify({
          event: "tts-job-report-failed",
          jobId: job.jobId,
          errorCode,
          message,
        }),
      );
      await delay(5_000);
    }
  }
  return true;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
  });
}

while (!stopped) {
  try {
    if (!(await processJob())) await delay(1_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(JSON.stringify({ event: "tts-worker-poll-failed", message }));
    await delay(5_000);
  }
}
