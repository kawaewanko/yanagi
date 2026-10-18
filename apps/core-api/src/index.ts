import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrations.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function serviceKey(name: string): string {
  const value = required(name);
  if (Buffer.byteLength(value) < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

const port = Number(process.env.CORE_API_PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("CORE_API_PORT must be an integer between 1 and 65535");
}

if (!process.env.DATABASE_URL?.trim() && !process.env.PGPASSWORD) {
  throw new Error("DATABASE_URL or PGPASSWORD must be configured");
}
const pool = new Pool({
  ...(process.env.DATABASE_URL?.trim()
    ? { connectionString: process.env.DATABASE_URL.trim() }
    : {}),
  max: 10,
  connectionTimeoutMillis: 5_000,
});

const aiEnabledValue = process.env.AI_ENABLED?.trim() ?? "false";
if (aiEnabledValue !== "true" && aiEnabledValue !== "false") {
  throw new Error("AI_ENABLED must be true or false");
}
const ollamaUrl = process.env.OLLAMA_URL?.trim() ?? "http://ollama:11434";
const ollamaEndpoint = new URL(ollamaUrl);
if (!["http:", "https:"].includes(ollamaEndpoint.protocol)) {
  throw new Error("OLLAMA_URL must use HTTP or HTTPS");
}

const serviceKeys = {
  community: serviceKey("CORE_API_KEY_COMMUNITY"),
  game: serviceKey("CORE_API_KEY_GAME"),
  ai: serviceKey("CORE_API_KEY_AI"),
  voice: serviceKey("CORE_API_KEY_VOICE"),
  worker: serviceKey("CORE_API_KEY_WORKER"),
  tts: serviceKey("CORE_API_KEY_TTS"),
};
if (
  new Set(Object.values(serviceKeys)).size !== Object.keys(serviceKeys).length
) {
  throw new Error("Each Core API service must use a distinct service key");
}

const app = buildApp({
  pool,
  serviceKeys,
  webhookSecretResolver: (secretRef) =>
    secretRef ? process.env[secretRef] : undefined,
  ttsAudioDirectory: process.env.TTS_AUDIO_DIR ?? "/var/lib/yanagi/tts",
  aiEnabled: aiEnabledValue === "true",
  ollamaUrl,
  ollamaModel: process.env.OLLAMA_MODEL?.trim() || "qwen2.5:1.5b",
});

try {
  const appliedMigrations = await runMigrations(pool);
  if (appliedMigrations.length) {
    app.log.info(
      { migrations: appliedMigrations },
      "Database migrations applied",
    );
  }
  await app.listen({
    host: process.env.CORE_API_HOST ?? "0.0.0.0",
    port,
  });
} catch (error) {
  app.log.error({ err: error }, "Core API failed to start");
  await pool.end();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
  });
}
