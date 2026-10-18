import {
  createHash,
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { access, mkdir, readdir, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";

type Service = "community" | "game" | "ai" | "voice" | "worker" | "tts";

type AppOptions = {
  pool: Pool;
  serviceKeys: Partial<Record<Service, string>>;
  webhookSecretResolver?: (secretRef: string | null) => string | undefined;
  ttsAudioDirectory?: string;
  aiEnabled?: boolean;
  ollamaUrl?: string;
  ollamaModel?: string;
  ollamaFetch?: typeof fetch;
};

type EventBody = {
  guildId: string;
  userId: string;
  messageId?: string;
  tickId?: string;
};

type VoiceLogBody = {
  guildId: string;
  userId: string;
  channelId: string | null;
  action: "join" | "leave" | "move";
  eventId: string;
};

type AuditLogBody = {
  guildId: string;
  actorId: string | null;
  action: string;
  eventId: string;
  details: Record<string, unknown>;
};

type TemporaryVoiceChannelBody = {
  guildId: string;
  channelId: string;
  ownerId: string;
};

type CreateRaffleBody = {
  guildId: string;
  createdBy: string;
  title: string;
  prize: Record<string, unknown>;
  entryCost: number;
  eligibility?: { minPoints?: number; roleIds?: string[] };
};

type RaffleActionBody = {
  guildId: string;
  actorId: string;
};

type FortuneOutcome = {
  name: string;
  points: number;
  weight: number;
};

class LocalAiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const fortuneOutcomes: readonly FortuneOutcome[] = [
  { name: "daikichi", points: 50, weight: 5 },
  { name: "chukichi", points: 30, weight: 15 },
  { name: "kichi", points: 20, weight: 25 },
  { name: "shokichi", points: 10, weight: 25 },
  { name: "suekichi", points: 5, weight: 20 },
  { name: "kyo", points: 0, weight: 10 },
];

export function fortuneForRoll(roll: number): FortuneOutcome {
  if (!Number.isInteger(roll) || roll < 0 || roll >= 100) {
    throw new RangeError("Fortune roll must be an integer from 0 to 99");
  }
  let threshold = 0;
  const outcome = fortuneOutcomes.find((result) => {
    threshold += result.weight;
    return roll < threshold;
  });
  if (!outcome) throw new Error("Fortune probability table must total 100");
  return outcome;
}

const idSchema = { type: "string", minLength: 1, maxLength: 32 };
const eventSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["guildId", "userId"],
    properties: {
      guildId: idSchema,
      userId: idSchema,
      messageId: idSchema,
      tickId: idSchema,
    },
  },
  headers: {
    type: "object",
    required: ["idempotency-key"],
    properties: {
      "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function payloadHash(payload: object): string {
  const canonical = Object.fromEntries(
    Object.entries(payload).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function webhookSignatureValid(
  payload: unknown,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!signature || !secret) return false;
  const provided = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify(payload ?? null))
    .digest("hex");
  return safeEqual(provided.toLowerCase(), expected);
}

async function beginIdempotent(
  client: PoolClient,
  scope: string,
  key: string,
  payload: object,
): Promise<{ replay: { status: number; body: object } } | { replay: null }> {
  const hash = payloadHash(payload);
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (scope, idempotency_key, payload_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING idempotency_key`,
    [scope, key, hash],
  );

  if (inserted.rowCount === 1) return { replay: null };

  const existing = await client.query<{
    payload_hash: string;
    response_status: number | null;
    response_body: object | null;
  }>(
    `SELECT payload_hash, response_status, response_body
     FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2`,
    [scope, key],
  );
  const row = existing.rows[0];
  if (!row || row.payload_hash !== hash) {
    return {
      replay: { status: 409, body: { error: "idempotency_key_conflict" } },
    };
  }
  if (row.response_status === null || row.response_body === null) {
    throw new Error("Committed idempotency record has no response");
  }
  return { replay: { status: row.response_status, body: row.response_body } };
}

async function saveIdempotentResponse(
  client: PoolClient,
  scope: string,
  key: string,
  status: number,
  body: object,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys
     SET response_status = $3, response_body = $4
     WHERE scope = $1 AND idempotency_key = $2`,
    [scope, key, status, JSON.stringify(body)],
  );
}

async function ensureMember(
  client: PoolClient,
  guildId: string,
  userId: string,
): Promise<void> {
  await client.query(
    "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [guildId],
  );
  await client.query(
    `INSERT INTO guild_members (guild_id, user_id) VALUES ($1, $2)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
    [guildId, userId],
  );
  await client.query(
    "SELECT points FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE",
    [guildId, userId],
  );
}

async function awardPoints(
  client: PoolClient,
  guildId: string,
  userId: string,
  amount: number,
  reason:
    | "message"
    | "voice"
    | "fortune"
    | "redemption"
    | "raffle_entry"
    | "daily"
    | "work"
    | "crime"
    | "transfer_out"
    | "transfer_in",
  idempotencyKey: string,
): Promise<void> {
  if (amount === 0) return;
  await client.query(
    `INSERT INTO point_transactions (guild_id, user_id, amount, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [guildId, userId, amount, reason, idempotencyKey],
  );
  await client.query(
    `UPDATE guild_members SET points = points + $3, updated_at = NOW()
     WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId, amount],
  );

  if (amount > 0) {
    await client.query(
      `INSERT INTO member_achievements (guild_id, user_id, achievement_key) VALUES ($1, $2, 'first_point') ON CONFLICT DO NOTHING`,
      [guildId, userId],
    );
    const total = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM point_transactions WHERE guild_id = $1 AND user_id = $2 AND amount > 0`,
      [guildId, userId],
    );
    if (Number(total.rows[0]?.total ?? 0) >= 1000)
      await client.query(
        `INSERT INTO member_achievements (guild_id, user_id, achievement_key) VALUES ($1, $2, 'point_collector') ON CONFLICT DO NOTHING`,
        [guildId, userId],
      );
  }
  if (reason === "daily") {
    const dailies = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM point_transactions WHERE guild_id = $1 AND user_id = $2 AND reason = 'daily'`,
      [guildId, userId],
    );
    if (Number(dailies.rows[0]?.count ?? 0) >= 7)
      await client.query(
        `INSERT INTO member_achievements (guild_id, user_id, achievement_key) VALUES ($1, $2, 'daily_regular') ON CONFLICT DO NOTHING`,
        [guildId, userId],
      );
  }
  if (reason === "redemption")
    await client.query(
      `INSERT INTO member_achievements (guild_id, user_id, achievement_key) VALUES ($1, $2, 'shopper') ON CONFLICT DO NOTHING`,
      [guildId, userId],
    );
  if (reason === "transfer_out")
    await client.query(
      `INSERT INTO member_achievements (guild_id, user_id, achievement_key) VALUES ($1, $2, 'generous') ON CONFLICT DO NOTHING`,
      [guildId, userId],
    );
}

async function withTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function registerAuth(
  app: FastifyInstance,
  keys: AppOptions["serviceKeys"],
): void {
  const configured = Object.entries(keys).filter(
    (entry): entry is [Service, string] => Boolean(entry[1]),
  );

  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url === "/health" ||
      request.url.startsWith("/v1/notifications/webhooks/")
    )
      return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const service = configured.find(([, key]) => safeEqual(token, key))?.[0];
    if (!service) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.service = service;
  });
}

declare module "fastify" {
  interface FastifyRequest {
    service?: Service;
  }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      redact: ["req.headers.authorization", "req.headers.cookie", "req.url"],
    },
  });
  registerAuth(app, options.serviceKeys);

  app.addHook("onResponse", async (request, reply) => {
    if (request.url === "/health") return;
    const route = request.routeOptions.url ?? "unknown";
    const metricKey = `api:${request.method.toLowerCase()}:${route}`.slice(
      0,
      120,
    );
    const dimensions = JSON.stringify({
      service: request.service ?? "unknown",
      status: reply.statusCode >= 400 ? "error" : "ok",
    });
    try {
      await options.pool.query(
        `INSERT INTO metric_buckets (bucket_start, guild_id, metric_key, dimensions, value)
         VALUES (date_trunc('minute', NOW()), NULL, $1, $2::jsonb, 1)
         ON CONFLICT (bucket_start, guild_id, metric_key, dimensions)
         DO UPDATE SET value = metric_buckets.value + 1`,
        [metricKey, dimensions],
      );
    } catch (error) {
      request.log.warn({ err: error }, "metric recording failed");
    }
  });

  app.get("/health", async (request, reply) => {
    try {
      await options.pool.query("SELECT 1");
      return { status: "ok" };
    } catch (error) {
      request.log.warn({ err: error }, "Database readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  app.post<{ Body: { service: string; metadata?: Record<string, unknown> } }>(
    "/v1/dashboard/heartbeat",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["service"],
          properties: {
            service: { type: "string", minLength: 1, maxLength: 32 },
            metadata: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      if (!request.service) return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `INSERT INTO bot_status (service, status, last_seen_at, metadata) VALUES ($1, 'online', NOW(), $2) ON CONFLICT (service) DO UPDATE SET status = 'online', last_seen_at = NOW(), metadata = EXCLUDED.metadata`,
        [request.service, JSON.stringify(request.body.metadata ?? {})],
      );
      return { ok: true };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      requesterId: string;
      title: string;
      url: string;
      effect?: string;
    };
  }>(
    "/v1/dashboard/music-history",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "requesterId", "title", "url"],
          properties: {
            guildId: idSchema,
            requesterId: idSchema,
            title: { type: "string", minLength: 1, maxLength: 300 },
            url: { type: "string", minLength: 1, maxLength: 1000 },
            effect: { type: "string", maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "INSERT INTO music_play_history (guild_id, requester_id, title, url, effect) VALUES ($1, $2, $3, $4, $5)",
        [
          request.body.guildId,
          request.body.requesterId,
          request.body.title,
          request.body.url,
          request.body.effect ?? "none",
        ],
      );
      return { ok: true };
    },
  );

  app.get("/v1/dashboard/status", async (request, reply) => {
    if (!request.service) return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query<{
      service: string;
      status: string;
      last_seen_at: Date;
    }>("SELECT service, status, last_seen_at FROM bot_status ORDER BY service");
    const knownServices = [
      "community",
      "game",
      "ai",
      "voice",
      "worker",
      "tts",
      "tts-1",
      "tts-2",
      "tts-3",
      "music-1",
      "music-2",
      "music-3",
    ];
    const rows = new Map(result.rows.map((row) => [row.service, row]));
    return {
      bots: knownServices.map((service) => {
        const row = rows.get(service);
        const lastSeenAt = row?.last_seen_at ?? new Date(0);
        return {
          service,
          status: row?.status ?? "offline",
          online: Boolean(
            row &&
              row.status === "online" &&
              Date.now() - lastSeenAt.getTime() < 90_000,
          ),
          lastSeenAt: lastSeenAt.toISOString(),
        };
      }),
    };
  });
  app.get<{ Querystring: { minutes?: string } }>(
    "/v1/metrics",
    async (request, reply) => {
      if (!request.service) return reply.code(403).send({ error: "forbidden" });
      const minutes = Math.min(
        Math.max(Number(request.query.minutes ?? 60) || 60, 1),
        10080,
      );
      const result = await options.pool.query<{
        metric_key: string;
        dimensions: Record<string, unknown>;
        value: string;
      }>(
        `SELECT metric_key, dimensions, SUM(value)::text AS value
       FROM metric_buckets
       WHERE bucket_start >= NOW() - ($1::int * INTERVAL '1 minute')
       GROUP BY metric_key, dimensions ORDER BY SUM(value) DESC LIMIT 200`,
        [minutes],
      );
      return {
        minutes,
        items: result.rows.map((row) => ({
          metricKey: row.metric_key,
          dimensions: row.dimensions,
          value: Number(row.value),
        })),
      };
    },
  );

  app.get("/v1/dashboard/music-history", async (request, reply) => {
    if (!request.service) return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query<{
      id: string;
      guild_id: string;
      title: string;
      url: string;
      effect: string;
      started_at: Date;
      status: string;
    }>(
      "SELECT id::text, guild_id, title, url, effect, started_at, status FROM music_play_history ORDER BY started_at DESC LIMIT 100",
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        guildId: row.guild_id,
        title: row.title,
        url: row.url,
        effect: row.effect,
        startedAt: row.started_at.toISOString(),
        status: row.status,
      })),
    };
  });

  app.get<{ Querystring: { guildId: string; days?: string; limit?: string } }>(
    "/v1/music/ranking",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const days = Math.min(
        Math.max(Number(request.query.days ?? 30) || 30, 1),
        365,
      );
      const limit = Math.min(
        Math.max(Number(request.query.limit ?? 10) || 10, 1),
        50,
      );
      const result = await options.pool.query(
        `SELECT title, url, COUNT(*)::int AS plays, MAX(started_at) AS last_played FROM music_play_history WHERE guild_id = $1 AND started_at >= NOW() - ($2::int * INTERVAL '1 day') GROUP BY title, url ORDER BY plays DESC, last_played DESC LIMIT $3`,
        [request.query.guildId, days, limit],
      );
      return { items: result.rows, days };
    },
  );

  app.post<{
    Body: { guildId: string; userId: string; url: string; title: string };
  }>("/v1/music/favorites", async (request, reply) => {
    if (request.service !== "voice")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `INSERT INTO music_favorites (guild_id, user_id, url, title) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, user_id, url) DO UPDATE SET title = EXCLUDED.title`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.url,
        request.body.title,
      ],
    );
    return { saved: true };
  });

  app.get<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/music/favorites",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT url, title, created_at FROM music_favorites WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
        [request.query.guildId, request.query.userId],
      );
      return { items: result.rows };
    },
  );

  app.delete<{ Querystring: { guildId: string; userId: string; url: string } }>(
    "/v1/music/favorites",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `DELETE FROM music_favorites WHERE guild_id = $1 AND user_id = $2 AND url = $3`,
        [request.query.guildId, request.query.userId, request.query.url],
      );
      return { deleted: true };
    },
  );

  app.post<{ Body: { guildId: string; userId: string; name: string } }>(
    "/v1/music/playlists",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `INSERT INTO music_playlists (guild_id, user_id, name) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [request.body.guildId, request.body.userId, request.body.name],
      );
      return { playlistId: result.rows[0].id };
    },
  );

  app.get<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/music/playlists",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT p.id, p.name, p.created_at, COUNT(t.position)::int AS track_count FROM music_playlists p LEFT JOIN music_playlist_tracks t ON t.playlist_id = p.id WHERE p.guild_id = $1 AND p.user_id = $2 GROUP BY p.id ORDER BY p.created_at DESC`,
        [request.query.guildId, request.query.userId],
      );
      return { items: result.rows };
    },
  );

  app.post<{ Body: { playlistId: number; url: string; title: string } }>(
    "/v1/music/playlists/tracks",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `INSERT INTO music_playlist_tracks (playlist_id, position, url, title) VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM music_playlist_tracks WHERE playlist_id = $1), 1), $2, $3) RETURNING position`,
        [request.body.playlistId, request.body.url, request.body.title],
      );
      return { position: result.rows[0].position };
    },
  );

  app.get<{ Querystring: { playlistId: string } }>(
    "/v1/music/playlists/tracks",
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT position, url, title FROM music_playlist_tracks WHERE playlist_id = $1 ORDER BY position`,
        [request.query.playlistId],
      );
      return { items: result.rows };
    },
  );

  app.post<{ Body: { service: string; status: "online" | "offline" } }>(
    "/v1/dashboard/health-events",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["service", "status"],
          properties: {
            service: { type: "string", minLength: 1, maxLength: 32 },
            status: { type: "string", enum: ["online", "offline"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "INSERT INTO health_events (service, status) VALUES ($1, $2)",
        [request.body.service, request.body.status],
      );
      return { ok: true };
    },
  );

  app.get("/v1/dashboard/health-history", async (request, reply) => {
    if (!request.service) return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query<{
      id: string;
      service: string;
      status: "online" | "offline";
      detected_at: Date;
    }>(
      "SELECT id::text, service, status, detected_at FROM health_events ORDER BY detected_at DESC LIMIT 50",
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        service: row.service,
        status: row.status,
        detectedAt: row.detected_at.toISOString(),
      })),
    };
  });

  app.post<{ Body: { service: string; actorId: string } }>(
    "/v1/health/ack",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `INSERT INTO health_alert_controls (service, acknowledged_at, acknowledged_by, updated_at) VALUES ($1, NOW(), $2, NOW()) ON CONFLICT (service) DO UPDATE SET acknowledged_at = NOW(), acknowledged_by = EXCLUDED.acknowledged_by, updated_at = NOW()`,
        [request.body.service, request.body.actorId],
      );
      return { acknowledged: true };
    },
  );
  app.post<{ Body: { service: string; actorId: string; minutes: number } }>(
    "/v1/health/silence",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const minutes = Math.min(
        Math.max(Math.trunc(request.body.minutes), 1),
        10080,
      );
      await options.pool.query(
        `INSERT INTO health_alert_controls (service, silenced_until, silenced_by, updated_at) VALUES ($1, NOW() + ($3::int * INTERVAL '1 minute'), $2, NOW()) ON CONFLICT (service) DO UPDATE SET silenced_until = NOW() + ($3::int * INTERVAL '1 minute'), silenced_by = EXCLUDED.silenced_by, updated_at = NOW()`,
        [request.body.service, request.body.actorId, minutes],
      );
      return { silenced: true, minutes };
    },
  );
  app.get("/v1/health/controls", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query(
      `SELECT service, acknowledged_at, acknowledged_by, silenced_until, silenced_by FROM health_alert_controls`,
    );
    return { items: result.rows };
  });

  app.post<{
    Body: {
      guildId: string;
      channelId: string;
      createdBy: string;
      title: string;
      description?: string;
      startsAt: string;
    };
  }>("/v1/community/events", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const startsAt = new Date(request.body.startsAt);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now())
      return reply.code(400).send({ error: "invalid_starts_at" });
    const eventId = randomUUID();
    await withTransaction(options.pool, async (client) => {
      await client.query(
        "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [request.body.guildId],
      );
      await client.query(
        `INSERT INTO community_events (id, guild_id, channel_id, created_by, title, description, starts_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eventId,
          request.body.guildId,
          request.body.channelId,
          request.body.createdBy,
          request.body.title,
          request.body.description ?? "",
          startsAt,
        ],
      );
      await client.query(
        `INSERT INTO notification_outbox (guild_id, channel_id, kind, payload, scheduled_at, dedupe_key) VALUES ($1, $2, 'event', $3::jsonb, $4, $5) ON CONFLICT (guild_id, dedupe_key) DO NOTHING`,
        [
          request.body.guildId,
          request.body.channelId,
          JSON.stringify({
            eventId,
            content: `📅 イベント「${request.body.title}」が開始されます。`,
          }),
          startsAt,
          `event:${eventId}`,
        ],
      );
    });
    return reply.code(201).send({ eventId, startsAt: startsAt.toISOString() });
  });
  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/events",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT id, title, description, channel_id, starts_at, status FROM community_events WHERE guild_id = $1 AND status = 'scheduled' ORDER BY starts_at LIMIT 50`,
        [request.query.guildId],
      );
      return {
        items: result.rows.map((row) => ({
          eventId: row.id,
          title: row.title,
          description: row.description,
          channelId: row.channel_id,
          startsAt: row.starts_at.toISOString(),
          status: row.status,
        })),
      };
    },
  );
  app.delete<{
    Params: { id: string };
    Querystring: { guildId: string; actorId: string };
  }>("/v1/community/events/:id", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query(
      `UPDATE community_events SET status = 'cancelled', cancelled_by = $3, cancelled_at = NOW(), updated_at = NOW() WHERE id = $1 AND guild_id = $2 AND status = 'scheduled' RETURNING id`,
      [request.params.id, request.query.guildId, request.query.actorId],
    );
    await options.pool.query(
      `UPDATE notification_outbox SET status = 'cancelled', updated_at = NOW() WHERE guild_id = $1 AND payload->>'eventId' = $2 AND status IN ('pending', 'processing')`,
      [request.query.guildId, request.params.id],
    );
    return { cancelled: (result.rowCount ?? 0) > 0 };
  });

  app.post<{
    Body: { guildId: string; userId: string; message: string };
  }>(
    "/v1/ai/chat",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId", "message"],
          properties: {
            guildId: idSchema,
            userId: idSchema,
            message: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
        headers: {
          type: "object",
          required: ["idempotency-key"],
          properties: {
            "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "game" && request.service !== "ai")
        return reply.code(403).send({ error: "forbidden" });
      if (!options.aiEnabled)
        return reply.code(503).send({ error: "ai_disabled" });

      const message = request.body.message.trim();
      if (!message)
        return reply.code(400).send({ error: "message_must_not_be_blank" });

      const idempotencyKey = request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }

      try {
        const result = await withTransaction(options.pool, async (client) => {
          const scope = `ai:${request.body.guildId}`;
          const idempotency = await beginIdempotent(
            client,
            scope,
            idempotencyKey,
            request.body,
          );
          if (idempotency.replay) return idempotency.replay;

          const conversationKey = `${request.body.guildId}:${request.body.userId}`;
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [conversationKey],
          );
          await client.query(
            "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
            [request.body.guildId],
          );
          const conversation = await client.query<{ id: string }>(
            `INSERT INTO ai_conversations (guild_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (guild_id, user_id) DO UPDATE SET updated_at = NOW()
           RETURNING id::text`,
            [request.body.guildId, request.body.userId],
          );
          const history = await client.query<{
            role: "user" | "assistant";
            content: string;
          }>(
            `SELECT role, content FROM (
             SELECT role, content, id
             FROM ai_messages
             WHERE conversation_id = $1
             ORDER BY id DESC
             LIMIT 12
           ) AS recent
           ORDER BY id`,
            [conversation.rows[0].id],
          );
          const modelMessages = [
            {
              role: "system",
              content:
                "あなたは夜凪鯖の日本語アシスタントです。簡潔で親切に回答し、知らないことは推測せず不明と伝えてください。",
            },
            ...history.rows,
            { role: "user", content: message },
          ];

          let response: Response;
          try {
            response = await (options.ollamaFetch ?? fetch)(
              new URL("/api/chat", options.ollamaUrl ?? "http://ollama:11434"),
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  model: options.ollamaModel ?? "qwen2.5:1.5b",
                  messages: modelMessages,
                  stream: false,
                  options: { num_predict: 256, num_ctx: 4096 },
                }),
                signal: AbortSignal.timeout(30_000),
              },
            );
          } catch (error) {
            if (
              error instanceof Error &&
              (error.name === "TimeoutError" || error.name === "AbortError")
            ) {
              throw new LocalAiError(504, "ai_timeout");
            }
            request.log.warn({ err: error }, "Local AI service request failed");
            throw new LocalAiError(503, "ai_unavailable");
          }
          if (!response.ok) {
            request.log.warn(
              { statusCode: response.status },
              "Local AI service returned an error",
            );
            throw new LocalAiError(503, "ai_unavailable");
          }

          let body: unknown;
          try {
            body = await response.json();
          } catch (error) {
            request.log.warn(
              { err: error },
              "Local AI service returned invalid JSON",
            );
            throw new LocalAiError(502, "ai_invalid_response");
          }
          const answer =
            body &&
            typeof body === "object" &&
            "message" in body &&
            body.message &&
            typeof body.message === "object" &&
            "content" in body.message &&
            typeof body.message.content === "string"
              ? body.message.content.trim()
              : "";
          if (!answer) throw new LocalAiError(502, "ai_invalid_response");

          const boundedAnswer =
            answer.length > 1900 ? `${answer.slice(0, 1899)}…` : answer;
          await client.query(
            `INSERT INTO ai_messages (conversation_id, role, content)
           VALUES ($1, 'user', $2), ($1, 'assistant', $3)`,
            [conversation.rows[0].id, message, boundedAnswer],
          );
          const resultBody = { answer: boundedAnswer };
          await saveIdempotentResponse(
            client,
            scope,
            idempotencyKey,
            200,
            resultBody,
          );
          return { status: 200, body: resultBody };
        });
        return reply.code(result.status).send(result.body);
      } catch (error) {
        if (error instanceof LocalAiError) {
          return reply.code(error.status).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{
    Body: {
      guildId: string;
      userId: string;
      interactionId: string;
      rating: number;
      comment?: string;
    };
  }>("/v1/ai/feedback", async (request, reply) => {
    if (request.service !== "game" && request.service !== "ai")
      return reply.code(403).send({ error: "forbidden" });
    if (
      !Number.isInteger(request.body.rating) ||
      request.body.rating < 1 ||
      request.body.rating > 5
    )
      return reply.code(400).send({ error: "invalid_rating" });
    await options.pool.query(
      `INSERT INTO ai_feedback (guild_id, user_id, interaction_id, rating, comment) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id, interaction_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.interactionId,
        request.body.rating,
        request.body.comment ?? "",
      ],
    );
    return { saved: true };
  });
  app.get<{ Querystring: { guildId: string } }>(
    "/v1/ai/feedback/summary",
    async (request, reply) => {
      if (request.service !== "game" && request.service !== "ai")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query<{
        count: string;
        average: string | null;
      }>(
        "SELECT COUNT(*)::text AS count, AVG(rating)::numeric(10,2)::text AS average FROM ai_feedback WHERE guild_id = $1",
        [request.query.guildId],
      );
      return {
        count: Number(result.rows[0]?.count ?? 0),
        average: result.rows[0]?.average
          ? Number(result.rows[0].average)
          : null,
      };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      postChannelId: string;
      messageId: string;
      voiceChannelId: string;
      creatorId: string;
      title: string;
      activity: string;
      maxParticipants: number;
      expiresAt: string;
    };
  }>(
    "/v1/community/vc-recruitments",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "guildId",
            "postChannelId",
            "messageId",
            "voiceChannelId",
            "creatorId",
            "title",
            "activity",
            "maxParticipants",
            "expiresAt",
          ],
          properties: {
            guildId: idSchema,
            postChannelId: idSchema,
            messageId: idSchema,
            voiceChannelId: idSchema,
            creatorId: idSchema,
            title: { type: "string", minLength: 1, maxLength: 100 },
            activity: { type: "string", minLength: 1, maxLength: 500 },
            maxParticipants: { type: "integer", minimum: 2, maximum: 99 },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const result = await withTransaction(options.pool, async (client) => {
        const scope = `vc-recruitment:${request.body.guildId}`;
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        await client.query(
          "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [request.body.guildId],
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO vc_recruitments
          (guild_id, post_channel_id, message_id, voice_channel_id, creator_id, title, activity, max_participants, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            request.body.guildId,
            request.body.postChannelId,
            request.body.messageId,
            request.body.voiceChannelId,
            request.body.creatorId,
            request.body.title.trim(),
            request.body.activity.trim(),
            request.body.maxParticipants,
            request.body.expiresAt,
          ],
        );
        await client.query(
          "INSERT INTO vc_recruitment_participants (recruitment_id, user_id) VALUES ($1, $2)",
          [inserted.rows[0].id, request.body.creatorId],
        );
        const body = {
          recruitmentId: inserted.rows[0].id,
          guildId: request.body.guildId,
          postChannelId: request.body.postChannelId,
          messageId: request.body.messageId,
          voiceChannelId: request.body.voiceChannelId,
          creatorId: request.body.creatorId,
          title: request.body.title.trim(),
          activity: request.body.activity.trim(),
          maxParticipants: request.body.maxParticipants,
          expiresAt: request.body.expiresAt,
          status: "open",
          participantIds: [request.body.creatorId],
        };
        await saveIdempotentResponse(client, scope, key, 201, body);
        return { status: 201, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/vc-recruitments",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId"],
          additionalProperties: false,
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const recruitments = await options.pool.query(
        `SELECT recruitment.id::text AS "recruitmentId", recruitment.guild_id AS "guildId",
              recruitment.post_channel_id AS "postChannelId", recruitment.message_id AS "messageId",
              recruitment.voice_channel_id AS "voiceChannelId", recruitment.creator_id AS "creatorId",
              recruitment.title, recruitment.activity, recruitment.max_participants AS "maxParticipants",
              recruitment.expires_at AS "expiresAt", recruitment.status,
              COALESCE(json_agg(participant.user_id) FILTER (WHERE participant.user_id IS NOT NULL), '[]') AS "participantIds"
       FROM vc_recruitments AS recruitment
       LEFT JOIN vc_recruitment_participants AS participant ON participant.recruitment_id = recruitment.id
       WHERE recruitment.guild_id = $1 AND recruitment.status = 'open' AND recruitment.expires_at > NOW()
       GROUP BY recruitment.id ORDER BY recruitment.created_at DESC`,
        [request.query.guildId],
      );
      return { recruitments: recruitments.rows };
    },
  );

  app.post<{
    Params: { recruitmentId: string };
    Body: { guildId: string; userId: string; action: "join" | "leave" };
  }>(
    "/v1/community/vc-recruitments/:recruitmentId/participants",
    {
      schema: {
        params: {
          type: "object",
          required: ["recruitmentId"],
          properties: {
            recruitmentId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId", "action"],
          properties: {
            guildId: idSchema,
            userId: idSchema,
            action: { type: "string", enum: ["join", "leave"] },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await withTransaction(options.pool, async (client) => {
        const recruitment = await client.query<{
          max_participants: number;
          status: string;
          expires_at: Date;
        }>(
          "SELECT max_participants, status, expires_at FROM vc_recruitments WHERE guild_id = $1 AND id = $2 FOR UPDATE",
          [request.body.guildId, request.params.recruitmentId],
        );
        if (!recruitment.rowCount)
          return { status: 404, body: { error: "recruitment_not_found" } };
        if (
          recruitment.rows[0].status !== "open" ||
          recruitment.rows[0].expires_at <= new Date()
        )
          return { status: 409, body: { error: "recruitment_closed" } };
        if (request.body.action === "join") {
          const count = await client.query<{ count: string }>(
            "SELECT COUNT(*)::text AS count FROM vc_recruitment_participants WHERE recruitment_id = $1",
            [request.params.recruitmentId],
          );
          if (
            Number(count.rows[0].count) >= recruitment.rows[0].max_participants
          )
            return { status: 409, body: { error: "recruitment_full" } };
          await client.query(
            "INSERT INTO vc_recruitment_participants (recruitment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [request.params.recruitmentId, request.body.userId],
          );
        } else {
          await client.query(
            "DELETE FROM vc_recruitment_participants WHERE recruitment_id = $1 AND user_id = $2",
            [request.params.recruitmentId, request.body.userId],
          );
        }
        const participants = await client.query<{ user_id: string }>(
          "SELECT user_id FROM vc_recruitment_participants WHERE recruitment_id = $1 ORDER BY joined_at",
          [request.params.recruitmentId],
        );
        return {
          status: 200,
          body: {
            recruitmentId: request.params.recruitmentId,
            participantIds: participants.rows.map((row) => row.user_id),
          },
        };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { recruitmentId: string }; Body: { guildId: string } }>(
    "/v1/community/vc-recruitments/:recruitmentId/close",
    {
      schema: {
        params: {
          type: "object",
          required: ["recruitmentId"],
          properties: {
            recruitmentId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const updated = await options.pool.query(
        "UPDATE vc_recruitments SET status = 'closed' WHERE guild_id = $1 AND id = $2",
        [request.body.guildId, request.params.recruitmentId],
      );
      if (!updated.rowCount)
        return reply.code(404).send({ error: "recruitment_not_found" });
      return { status: "closed" as const };
    },
  );

  app.post(
    "/v1/maintenance/retention",
    {
      schema: { body: { type: "object", additionalProperties: false } },
    },
    async (request, reply) => {
      if (request.service !== "worker")
        return reply.code(403).send({ error: "forbidden" });
      const cleanup = await withTransaction(options.pool, async (client) => {
        const auditLogs = await client.query(
          `DELETE FROM audit_logs WHERE created_at < NOW() - INTERVAL '90 days'`,
        );
        const voiceLogs = await client.query(
          `DELETE FROM voice_logs WHERE created_at < NOW() - INTERVAL '180 days'`,
        );
        const pointTransactions = await client.query(
          `DELETE FROM point_transactions WHERE created_at < NOW() - INTERVAL '365 days'`,
        );
        const adminSessions = await client.query(
          `DELETE FROM admin_sessions
         WHERE expires_at <= NOW() OR created_at < NOW() - INTERVAL '7 days'`,
        );
        const temporaryVoiceChannels = await client.query(
          `DELETE FROM temporary_voice_channels
         WHERE delete_after IS NOT NULL AND delete_after < NOW() - INTERVAL '10 minutes'`,
        );
        const aiConversations = await client.query(
          `DELETE FROM ai_conversations WHERE updated_at < NOW() - INTERVAL '30 days'`,
        );
        const aiIdempotencyKeys = await client.query(
          `DELETE FROM idempotency_keys
         WHERE scope LIKE 'ai:%' AND created_at < NOW() - INTERVAL '30 days'`,
        );
        const ttsJobs = await client.query<{
          id: string;
          audio_path: string | null;
        }>(
          `WITH expired_jobs AS (
           DELETE FROM tts_jobs
           WHERE updated_at < NOW() - INTERVAL '30 days'
             AND status IN ('succeeded', 'failed')
           RETURNING id, idempotency_key, audio_path
         ), expired_keys AS (
           DELETE FROM idempotency_keys AS idem
           USING expired_jobs AS expired
           WHERE idem.scope LIKE 'tts:%'
             AND idem.idempotency_key = expired.idempotency_key
           RETURNING idem.idempotency_key
         )
         SELECT id::text, audio_path FROM expired_jobs`,
        );
        return {
          deleted: {
            auditLogs: auditLogs.rowCount ?? 0,
            voiceLogs: voiceLogs.rowCount ?? 0,
            pointTransactions: pointTransactions.rowCount ?? 0,
            adminSessions: adminSessions.rowCount ?? 0,
            temporaryVoiceChannels: temporaryVoiceChannels.rowCount ?? 0,
            aiConversations: aiConversations.rowCount ?? 0,
            aiIdempotencyKeys: aiIdempotencyKeys.rowCount ?? 0,
            ttsJobs: ttsJobs.rowCount ?? 0,
            ttsAudioFiles: ttsJobs.rows.filter((job) => job.audio_path !== null)
              .length,
          },
          expiredTtsJobs: ttsJobs.rows,
        };
      });
      const audioDirectory =
        options.ttsAudioDirectory ??
        process.env.TTS_AUDIO_DIR ??
        "/tmp/yanagi-tts";
      await mkdir(audioDirectory, { recursive: true });
      for (const job of cleanup.expiredTtsJobs) {
        if (job.audio_path === `${job.id}.wav`) {
          try {
            await unlink(join(audioDirectory, job.audio_path));
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
        }
      }
      const storedAudio = (await readdir(audioDirectory)).filter((name) =>
        /^[0-9]+\.wav$/.test(name),
      );
      if (storedAudio.length) {
        const storedIds = storedAudio.map((name) => name.slice(0, -4));
        const retainedJobs = await options.pool.query<{ id: string }>(
          "SELECT id::text FROM tts_jobs WHERE id = ANY($1::bigint[])",
          [storedIds],
        );
        const retainedIds = new Set(retainedJobs.rows.map((job) => job.id));
        for (const name of storedAudio) {
          if (retainedIds.has(name.slice(0, -4))) continue;
          try {
            await unlink(join(audioDirectory, name));
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
        }
      }
      return {
        deleted: cleanup.deleted,
        completedAt: new Date().toISOString(),
      };
    },
  );

  app.post<{ Body: VoiceLogBody }>(
    "/v1/community/voice-events",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId", "channelId", "action", "eventId"],
          properties: {
            guildId: idSchema,
            userId: idSchema,
            channelId: { anyOf: [idSchema, { type: "null" }] },
            action: { type: "string", enum: ["join", "leave", "move"] },
            eventId: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key !== request.body.eventId) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_must_match_event_id" });
      }
      const { guildId, userId, channelId, action, eventId } = request.body;
      const scope = `voice-log:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        await client.query(
          "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [guildId],
        );
        await client.query(
          `INSERT INTO voice_logs (guild_id, user_id, channel_id, action)
         VALUES ($1, $2, $3, $4)`,
          [guildId, userId, channelId, action],
        );
        const body = { recorded: true, eventId };
        await saveIdempotentResponse(client, scope, key, 201, body);
        return { status: 201, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: AuditLogBody }>(
    "/v1/community/audit-events",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId", "action", "eventId", "details"],
          properties: {
            guildId: idSchema,
            actorId: { anyOf: [idSchema, { type: "null" }] },
            action: { type: "string", minLength: 1, maxLength: 100 },
            eventId: { type: "string", minLength: 1, maxLength: 200 },
            details: { type: "object", maxProperties: 30 },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key !== request.body.eventId) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_must_match_event_id" });
      }
      const { guildId, actorId, action, eventId, details } = request.body;
      const scope = `audit-log:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        await client.query(
          "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [guildId],
        );
        await client.query(
          `INSERT INTO audit_logs (guild_id, actor_id, action, details)
         VALUES ($1, $2, $3, $4)`,
          [guildId, actorId, action, JSON.stringify(details)],
        );
        const body = { recorded: true, eventId };
        await saveIdempotentResponse(client, scope, key, 201, body);
        return { status: 201, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{
    Body: {
      guildId: string;
      targetUserId: string;
      actorUserId: string;
      action: "note" | "warn" | "timeout" | "kick" | "ban" | "unban";
      reason?: string;
      expiresAt?: string;
    };
  }>("/v1/community/moderation-cases", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const body = request.body;
    const result = await options.pool.query<{ case_number: number }>(
      `INSERT INTO moderation_cases (guild_id, case_number, target_user_id, actor_user_id, action, reason, expires_at)
       VALUES ($1, COALESCE((SELECT MAX(case_number) + 1 FROM moderation_cases WHERE guild_id = $1), 1), $2, $3, $4, $5, $6)
       RETURNING case_number`,
      [
        body.guildId,
        body.targetUserId,
        body.actorUserId,
        body.action,
        body.reason ?? "",
        body.expiresAt ?? null,
      ],
    );
    return { caseNumber: result.rows[0].case_number };
  });

  app.get<{
    Querystring: {
      guildId: string;
      targetUserId?: string;
      action?: string;
      limit?: string;
    };
  }>("/v1/community/moderation-cases", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? 20) || 20, 1),
      100,
    );
    const result = await options.pool.query(
      `SELECT case_number, target_user_id, actor_user_id, action, reason, status, expires_at, created_at FROM moderation_cases WHERE guild_id = $1 AND ($2::text IS NULL OR target_user_id = $2) AND ($3::text IS NULL OR action = $3) ORDER BY case_number DESC LIMIT $4`,
      [
        request.query.guildId,
        request.query.targetUserId ?? null,
        request.query.action ?? null,
        limit,
      ],
    );
    return { items: result.rows };
  });

  app.get<{
    Querystring: { guildId: string; action?: string; limit?: string };
  }>("/v1/community/audit-search", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? 20) || 20, 1),
      100,
    );
    const result = await options.pool.query(
      `SELECT id, actor_id, action, details, created_at FROM audit_logs WHERE guild_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY created_at DESC LIMIT $3`,
      [request.query.guildId, request.query.action ?? null, limit],
    );
    return { items: result.rows };
  });

  app.post<{
    Body: {
      guildId: string;
      userId: string;
      roleId: string;
      expiresAt: string;
      createdBy: string;
    };
  }>("/v1/community/temporary-roles", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [request.body.guildId],
    );
    await options.pool.query(
      `INSERT INTO temporary_roles (guild_id, user_id, role_id, expires_at, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, created_by = EXCLUDED.created_by`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.roleId,
        request.body.expiresAt,
        request.body.createdBy,
      ],
    );
    return { saved: true };
  });

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/temporary-roles",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT user_id, role_id, expires_at, created_by FROM temporary_roles WHERE guild_id = $1 AND expires_at > NOW() ORDER BY expires_at`,
        [request.query.guildId],
      );
      return { items: result.rows };
    },
  );

  app.delete<{
    Querystring: { guildId: string; userId: string; roleId: string };
  }>("/v1/community/temporary-roles", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `DELETE FROM temporary_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = $3`,
      [request.query.guildId, request.query.userId, request.query.roleId],
    );
    return { deleted: true };
  });

  app.put<{
    Body: {
      guildId: string;
      userId: string;
      timezone: string;
      locale?: string;
      notificationPreferences?: Record<string, unknown>;
    };
  }>("/v1/community/user-preferences", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [request.body.guildId],
    );
    await options.pool.query(
      `INSERT INTO user_preferences (guild_id, user_id, timezone, locale, notification_preferences) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (guild_id, user_id) DO UPDATE SET timezone = EXCLUDED.timezone, locale = EXCLUDED.locale, notification_preferences = EXCLUDED.notification_preferences, updated_at = NOW()`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.timezone,
        request.body.locale ?? "ja-JP",
        JSON.stringify(request.body.notificationPreferences ?? {}),
      ],
    );
    return { saved: true };
  });

  app.get<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/community/user-preferences",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT timezone, locale, notification_preferences FROM user_preferences WHERE guild_id = $1 AND user_id = $2`,
        [request.query.guildId, request.query.userId],
      );
      return {
        preferences: result.rows[0] ?? {
          timezone: "UTC",
          locale: "ja-JP",
          notification_preferences: {},
        },
      };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      createdBy: string;
      channelId: string;
      message: string;
      runAt: string;
      recurrence?: { intervalMinutes?: number };
    };
  }>("/v1/community/scheduled-notifications", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const runAt = new Date(request.body.runAt);
    if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= Date.now())
      return reply.code(400).send({ error: "run_at_must_be_future" });
    const recurrence = request.body.recurrence ?? {};
    if (
      recurrence.intervalMinutes !== undefined &&
      (recurrence.intervalMinutes < 1 || recurrence.intervalMinutes > 10080)
    )
      return reply.code(400).send({ error: "invalid_recurrence" });
    await options.pool.query(
      "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [request.body.guildId],
    );
    const result = await options.pool.query(
      `INSERT INTO scheduled_notifications (guild_id, created_by, channel_id, kind, message, run_at, recurrence, idempotency_key) VALUES ($1, $2, $3, 'announcement', $4, $5, $6, $7) RETURNING id::text, run_at`,
      [
        request.body.guildId,
        request.body.createdBy,
        request.body.channelId,
        request.body.message,
        runAt,
        JSON.stringify(recurrence),
        `${request.body.createdBy}:${request.body.channelId}:${runAt.toISOString()}`,
      ],
    );
    return reply.code(201).send({
      id: result.rows[0].id,
      runAt: result.rows[0].run_at.toISOString(),
    });
  });

  app.get<{ Querystring: { guildId: string; createdBy?: string } }>(
    "/v1/community/scheduled-notifications",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT id::text, channel_id, message, run_at, recurrence, created_by FROM scheduled_notifications WHERE guild_id = $1 AND status = 'scheduled' ${request.query.createdBy ? "AND created_by = $2" : ""} ORDER BY run_at`,
        request.query.createdBy
          ? [request.query.guildId, request.query.createdBy]
          : [request.query.guildId],
      );
      return {
        items: result.rows.map((row) => ({
          id: row.id,
          channelId: row.channel_id,
          message: row.message,
          runAt: row.run_at.toISOString(),
          recurrence: row.recurrence,
          createdBy: row.created_by,
        })),
      };
    },
  );

  app.delete<{
    Params: { id: string };
    Querystring: { guildId: string; userId: string };
  }>("/v1/community/scheduled-notifications/:id", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `UPDATE scheduled_notifications SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND guild_id = $2 AND created_by = $3 AND status = 'scheduled'`,
      [request.params.id, request.query.guildId, request.query.userId],
    );
    return { cancelled: true };
  });

  app.post<{ Params: { id: string }; Body: { nextRunAt?: string } }>(
    "/v1/community/scheduled-notifications/:id/complete",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const nextRun = request.body.nextRunAt
        ? new Date(request.body.nextRunAt)
        : null;
      if (nextRun && Number.isNaN(nextRun.getTime()))
        return reply.code(400).send({ error: "invalid_next_run_at" });
      await options.pool.query(
        nextRun
          ? `UPDATE scheduled_notifications SET run_at = $2, status = 'scheduled', updated_at = NOW() WHERE id = $1`
          : `UPDATE scheduled_notifications SET status = 'sent', updated_at = NOW() WHERE id = $1`,
        nextRun ? [request.params.id, nextRun] : [request.params.id],
      );
      return { completed: true };
    },
  );

  app.post<{ Body: { limit?: number } }>(
    "/v1/notifications/outbox/claim",
    async (request, reply) => {
      if (request.service !== "community" && request.service !== "worker")
        return reply.code(403).send({ error: "forbidden" });
      const limit = Math.min(
        Math.max(Number(request.body.limit ?? 10) || 10, 1),
        50,
      );
      return withTransaction(options.pool, async (client) => {
        const result = await client.query(
          `WITH candidates AS (
           SELECT id FROM notification_outbox
           WHERE (status = 'pending' AND scheduled_at <= NOW())
              OR (status IN ('processing', 'failed') AND updated_at < NOW() - INTERVAL '2 minutes' AND attempts < 10)
           ORDER BY scheduled_at, id FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE notification_outbox o
         SET status = 'processing', attempts = o.attempts + 1, locked_at = NOW(), updated_at = NOW()
         FROM candidates c WHERE o.id = c.id
         RETURNING o.id::text, o.guild_id, o.channel_id, o.kind, o.payload, o.attempts`,
          [limit],
        );
        return { items: result.rows };
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { delivered: boolean; error?: string };
  }>("/v1/notifications/outbox/:id/complete", async (request, reply) => {
    if (request.service !== "community" && request.service !== "worker")
      return reply.code(403).send({ error: "forbidden" });
    const status = request.body.delivered ? "sent" : "failed";
    await options.pool.query(
      `UPDATE notification_outbox
       SET status = CASE WHEN $2::boolean THEN 'sent' ELSE CASE WHEN attempts >= 10 THEN 'failed' ELSE 'pending' END END,
           sent_at = CASE WHEN $2::boolean THEN NOW() ELSE sent_at END,
           last_error = CASE WHEN $2::boolean THEN NULL ELSE LEFT($3, 1000) END,
           locked_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [
        request.params.id,
        request.body.delivered,
        request.body.error ?? "delivery_failed",
      ],
    );
    return { completed: true, status };
  });

  app.post<{
    Body: {
      guildId: string;
      kind: "youtube" | "twitch" | "webhook";
      target: string;
      channelId: string;
      config?: Record<string, unknown>;
      secretRef?: string;
      createdBy: string;
      intervalSeconds?: number;
    };
  }>("/v1/community/external-subscriptions", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const {
      guildId,
      kind,
      target,
      channelId,
      config = {},
      secretRef,
      createdBy,
    } = request.body;
    if (
      !["youtube", "twitch", "webhook"].includes(kind) ||
      !target.trim() ||
      target.length > 2000
    )
      return reply.code(400).send({ error: "invalid_subscription" });
    if (kind === "youtube" && !/^UC[a-zA-Z0-9_-]{10,}$/.test(target))
      return reply.code(400).send({ error: "invalid_youtube_channel_id" });
    if (kind === "webhook" && !secretRef?.trim())
      return reply.code(400).send({ error: "webhook_secret_ref_required" });
    const interval = Math.min(
      Math.max(Math.trunc(request.body.intervalSeconds ?? 300), 60),
      86400,
    );
    const safeConfig = Object.fromEntries(
      Object.entries(config).filter(
        ([key]) => !/(secret|token|password|credential)/i.test(key),
      ),
    );
    await options.pool.query(
      "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [guildId],
    );
    const result = await options.pool.query(
      `INSERT INTO external_subscriptions (guild_id, kind, target, channel_id, config, secret_ref, next_poll_at, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6, CASE WHEN $2 = 'webhook' THEN NULL ELSE NOW() END, $7) ON CONFLICT (guild_id, kind, target, channel_id) DO UPDATE SET config = EXCLUDED.config, secret_ref = EXCLUDED.secret_ref, next_poll_at = CASE WHEN EXCLUDED.kind = 'webhook' THEN NULL ELSE NOW() END, enabled = TRUE, failure_count = 0, updated_at = NOW() RETURNING id::text, guild_id, kind, target, channel_id, config, secret_ref, enabled, next_poll_at`,
      [
        guildId,
        kind,
        target.trim(),
        channelId,
        JSON.stringify({ ...safeConfig, intervalSeconds: interval }),
        secretRef?.trim() ?? null,
        createdBy,
      ],
    );
    return reply.code(201).send({ subscription: result.rows[0] });
  });
  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/external-subscriptions",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT id::text, kind, target, channel_id, config, secret_ref, enabled, failure_count, next_poll_at, last_success_at, last_error FROM external_subscriptions WHERE guild_id = $1 ORDER BY created_at DESC`,
        [request.query.guildId],
      );
      return { items: result.rows };
    },
  );
  app.delete<{ Params: { id: string }; Querystring: { guildId: string } }>(
    "/v1/community/external-subscriptions/:id",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `UPDATE external_subscriptions SET enabled = FALSE, updated_at = NOW() WHERE id = $1 AND guild_id = $2`,
        [request.params.id, request.query.guildId],
      );
      return { deleted: true };
    },
  );
  app.post<{ Body: { limit?: number } }>(
    "/v1/notifications/external-poll/claim",
    async (request, reply) => {
      if (request.service !== "worker")
        return reply.code(403).send({ error: "forbidden" });
      const limit = Math.min(
        Math.max(Math.trunc(request.body.limit ?? 20), 1),
        50,
      );
      return withTransaction(options.pool, async (client) => {
        const result = await client.query(
          `WITH candidates AS (SELECT id FROM external_subscriptions WHERE enabled AND kind IN ('youtube', 'twitch') AND next_poll_at <= NOW() ORDER BY next_poll_at, id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE external_subscriptions s SET next_poll_at = NOW() + INTERVAL '2 minutes', updated_at = NOW(), last_error = NULL FROM candidates c WHERE s.id = c.id RETURNING s.id::text, s.guild_id, s.kind, s.target, s.channel_id, s.config, s.secret_ref`,
          [limit],
        );
        return { items: result.rows };
      });
    },
  );
  app.post<{
    Body: {
      subscriptionId: string;
      externalId: string;
      title: string;
      url: string;
      payload?: Record<string, unknown>;
      publishedAt?: string;
    };
  }>("/v1/notifications/external-events", async (request, reply) => {
    if (request.service !== "worker")
      return reply.code(403).send({ error: "forbidden" });
    const publishedAt = request.body.publishedAt
      ? new Date(request.body.publishedAt)
      : null;
    if (publishedAt && Number.isNaN(publishedAt.getTime()))
      return reply.code(400).send({ error: "invalid_published_at" });
    return withTransaction(options.pool, async (client) => {
      const inserted = await client.query<{
        guild_id: string;
        channel_id: string;
        kind: string;
      }>(
        `WITH created AS (INSERT INTO external_notification_events (subscription_id, external_id, title, url, payload, published_at) SELECT id, $2, $3, $4, $5::jsonb, $6 FROM external_subscriptions WHERE id = $1 AND enabled ON CONFLICT (subscription_id, external_id) DO NOTHING RETURNING subscription_id) SELECT s.guild_id, s.channel_id, s.kind FROM created c JOIN external_subscriptions s ON s.id = c.subscription_id`,
        [
          request.body.subscriptionId,
          request.body.externalId,
          request.body.title,
          request.body.url,
          JSON.stringify(request.body.payload ?? {}),
          publishedAt,
        ],
      );
      if (inserted.rowCount !== 1) return { inserted: false, duplicate: true };
      const event = inserted.rows[0];
      const outbox = await client.query<{ id: string }>(
        `INSERT INTO notification_outbox (guild_id, channel_id, kind, payload, dedupe_key) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (guild_id, dedupe_key) DO NOTHING RETURNING id::text`,
        [
          event.guild_id,
          event.channel_id,
          event.kind,
          JSON.stringify({
            content: `🔔 **${request.body.title}**\n${request.body.url}`,
            externalId: request.body.externalId,
            subscriptionId: request.body.subscriptionId,
          }),
          `external:${request.body.subscriptionId}:${request.body.externalId}`,
        ],
      );
      return { inserted: true, outboxId: outbox.rows[0]?.id ?? null };
    });
  });
  app.post<{
    Body: { subscriptionId: string; success: boolean; error?: string };
  }>("/v1/notifications/external-poll/complete", async (request, reply) => {
    if (request.service !== "worker")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      `UPDATE external_subscriptions SET failure_count = CASE WHEN $2::boolean THEN 0 ELSE failure_count + 1 END, last_success_at = CASE WHEN $2::boolean THEN NOW() ELSE last_success_at END, last_error = CASE WHEN $2::boolean THEN NULL ELSE LEFT($3, 1000) END, next_poll_at = NOW() + CASE WHEN $2::boolean THEN (COALESCE((config->>'intervalSeconds')::int, 300) * INTERVAL '1 second') ELSE LEAST(86400, (60 * POWER(2, LEAST(failure_count + 1, 10)))::int) * INTERVAL '1 second' END, updated_at = NOW() WHERE id = $1 AND enabled`,
      [
        request.body.subscriptionId,
        request.body.success,
        request.body.error ?? "poll_failed",
      ],
    );
    return { completed: true };
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/v1/notifications/webhooks/:id",
    async (request, reply) => {
      const result = await options.pool.query<{
        secret_ref: string | null;
        guild_id: string;
        channel_id: string;
        kind: string;
        target: string;
        enabled: boolean;
      }>(
        `SELECT secret_ref, guild_id, channel_id, kind, target, enabled FROM external_subscriptions WHERE id = $1`,
        [request.params.id],
      );
      const row = result.rows[0];
      if (!row || !row.enabled || row.kind !== "webhook")
        return reply.code(404).send({ error: "webhook_not_found" });
      const secret = options.webhookSecretResolver?.(row.secret_ref);
      const signature = request.headers["x-webhook-signature"];
      if (
        !webhookSignatureValid(
          request.body,
          Array.isArray(signature) ? signature[0] : signature,
          secret,
        )
      )
        return reply.code(401).send({ error: "invalid_webhook_signature" });
      const body = request.body ?? {};
      const externalId = String(
        body.eventId ??
          body.id ??
          body.deliveryId ??
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      );
      const title = String(body.title ?? body.name ?? "Webhook通知").slice(
        0,
        500,
      );
      const url = String(body.url ?? row.target).slice(0, 2000);
      return withTransaction(options.pool, async (client) => {
        const inserted = await client.query(
          `INSERT INTO external_notification_events (subscription_id, external_id, title, url, payload) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (subscription_id, external_id) DO NOTHING RETURNING id`,
          [request.params.id, externalId, title, url, JSON.stringify(body)],
        );
        if (inserted.rowCount !== 1) return { accepted: true, duplicate: true };
        await client.query(
          `INSERT INTO notification_outbox (guild_id, channel_id, kind, payload, dedupe_key) VALUES ($1, $2, 'webhook', $3::jsonb, $4) ON CONFLICT (guild_id, dedupe_key) DO NOTHING`,
          [
            row.guild_id,
            row.channel_id,
            JSON.stringify({
              content: `🔔 **${title}**\n${url}`,
              payload: body,
              externalId,
            }),
            `external:${request.params.id}:${externalId}`,
          ],
        );
        await client.query(
          `UPDATE external_subscriptions SET last_success_at = NOW(), last_error = NULL, failure_count = 0, updated_at = NOW() WHERE id = $1`,
          [request.params.id],
        );
        return { accepted: true, duplicate: false };
      });
    },
  );

  app.put<{
    Body: {
      guildId: string;
      userId: string;
      month: number;
      day: number;
      timezone?: string;
      channelId?: string;
    };
  }>("/v1/community/birthdays", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    if (
      request.body.month < 1 ||
      request.body.month > 12 ||
      request.body.day < 1 ||
      request.body.day > 31
    )
      return reply.code(400).send({ error: "invalid_birthday" });
    await options.pool.query(
      "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [request.body.guildId],
    );
    await options.pool.query(
      `INSERT INTO birthdays (guild_id, user_id, month, day, timezone, announcement_channel_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (guild_id, user_id) DO UPDATE SET month = EXCLUDED.month, day = EXCLUDED.day, timezone = EXCLUDED.timezone, announcement_channel_id = EXCLUDED.announcement_channel_id, enabled = TRUE, updated_at = NOW()`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.month,
        request.body.day,
        request.body.timezone ?? "UTC",
        request.body.channelId ?? null,
      ],
    );
    return { saved: true };
  });

  app.get<{ Querystring: { guildId: string; userId?: string } }>(
    "/v1/community/birthdays",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT user_id, month, day, timezone, announcement_channel_id FROM birthdays WHERE guild_id = $1 AND enabled = TRUE ${request.query.userId ? "AND user_id = $2" : ""} ORDER BY month, day`,
        request.query.userId
          ? [request.query.guildId, request.query.userId]
          : [request.query.guildId],
      );
      return {
        items: result.rows.map((row) => ({
          userId: row.user_id,
          month: row.month,
          day: row.day,
          timezone: row.timezone,
          channelId: row.announcement_channel_id,
        })),
      };
    },
  );

  app.delete<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/community/birthdays",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "DELETE FROM birthdays WHERE guild_id = $1 AND user_id = $2",
        [request.query.guildId, request.query.userId],
      );
      return { deleted: true };
    },
  );

  app.get("/v1/community/birthdays/due", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query(
      `SELECT guild_id, user_id, announcement_channel_id, month, day FROM birthdays WHERE enabled = TRUE AND last_announced_year IS DISTINCT FROM EXTRACT(YEAR FROM NOW())::int AND month = EXTRACT(MONTH FROM (NOW() AT TIME ZONE timezone))::int AND day = EXTRACT(DAY FROM (NOW() AT TIME ZONE timezone))`,
    );
    return {
      items: result.rows.map((row) => ({
        guildId: row.guild_id,
        userId: row.user_id,
        channelId: row.announcement_channel_id,
        month: row.month,
        day: row.day,
      })),
    };
  });

  app.post<{ Body: { guildId: string; userId: string } }>(
    "/v1/community/birthdays/announce",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "UPDATE birthdays SET last_announced_year = EXTRACT(YEAR FROM NOW())::int, updated_at = NOW() WHERE guild_id = $1 AND user_id = $2",
        [request.body.guildId, request.body.userId],
      );
      return { marked: true };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      url: string;
      displayName: string;
      channelId: string;
      createdBy: string;
      intervalSeconds?: number;
    };
  }>("/v1/community/rss-feeds", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    try {
      new URL(request.body.url);
    } catch {
      return reply.code(400).send({ error: "invalid_feed_url" });
    }
    const interval = Math.min(
      Math.max(request.body.intervalSeconds ?? 900, 60),
      604800,
    );
    await options.pool.query(
      "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [request.body.guildId],
    );
    const result = await options.pool.query(
      `INSERT INTO rss_feeds (guild_id, url, display_name, announcement_channel_id, interval_seconds, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (guild_id, url) DO UPDATE SET display_name = EXCLUDED.display_name, announcement_channel_id = EXCLUDED.announcement_channel_id, interval_seconds = EXCLUDED.interval_seconds, enabled = TRUE, updated_at = NOW() RETURNING id::text, url, display_name, announcement_channel_id, interval_seconds, next_poll_at`,
      [
        request.body.guildId,
        request.body.url,
        request.body.displayName,
        request.body.channelId,
        interval,
        request.body.createdBy,
      ],
    );
    return reply.code(201).send({ feed: result.rows[0] });
  });

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/rss-feeds",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT id::text, url, display_name, announcement_channel_id, interval_seconds, next_poll_at FROM rss_feeds WHERE guild_id = $1 AND enabled = TRUE ORDER BY created_at DESC`,
        [request.query.guildId],
      );
      return { items: result.rows };
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { guildId: string } }>(
    "/v1/community/rss-feeds/:id",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `UPDATE rss_feeds SET enabled = FALSE, updated_at = NOW() WHERE id = $1 AND guild_id = $2`,
        [request.params.id, request.query.guildId],
      );
      return { deleted: true };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      externalId: string;
      title: string;
      link: string;
      summary?: string;
      publishedAt?: string;
    };
  }>("/v1/community/rss-feeds/:id/items", async (request, reply) => {
    if (request.service !== "community")
      return reply.code(403).send({ error: "forbidden" });
    const result = await options.pool.query(
      `INSERT INTO rss_items (feed_id, external_id, title, link, summary, published_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (feed_id, external_id) DO NOTHING RETURNING id::text, title, link, summary, published_at`,
      [
        request.params.id,
        request.body.externalId,
        request.body.title,
        request.body.link,
        request.body.summary ?? "",
        request.body.publishedAt ? new Date(request.body.publishedAt) : null,
      ],
    );
    return { inserted: result.rowCount === 1, item: result.rows[0] ?? null };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/community/rss-feeds/:id/polled",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        `UPDATE rss_feeds SET last_polled_at = NOW(), next_poll_at = NOW() + (interval_seconds * INTERVAL '1 second'), failure_count = 0, updated_at = NOW() WHERE id = $1`,
        [request.params.id],
      );
      return { updated: true };
    },
  );

  app.post<{ Params: { itemId: string } }>(
    "/v1/community/rss-items/:itemId/announced",
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "UPDATE rss_items SET announced_at = NOW() WHERE id = $1",
        [request.params.itemId],
      );
      return { updated: true };
    },
  );

  app.post<{ Body: TemporaryVoiceChannelBody }>(
    "/v1/community/temporary-voice-channels",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "channelId", "ownerId"],
          properties: {
            guildId: idSchema,
            channelId: idSchema,
            ownerId: idSchema,
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key !== request.body.channelId) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_must_match_channel_id" });
      }
      const { guildId, channelId, ownerId } = request.body;
      const scope = `temporary-voice:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        await client.query(
          "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [guildId],
        );
        await client.query(
          `INSERT INTO temporary_voice_channels (guild_id, channel_id, owner_id)
         VALUES ($1, $2, $3)`,
          [guildId, channelId, ownerId],
        );
        const body = {
          registered: true,
          channelId,
          ownerId,
          deleteAfter: null,
        };
        await saveIdempotentResponse(client, scope, key, 201, body);
        return { status: 201, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/temporary-voice-channels",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const channels = await options.pool.query(
        `SELECT channel_id AS "channelId", owner_id AS "ownerId",
              created_at AS "createdAt", delete_after AS "deleteAfter"
       FROM temporary_voice_channels
       WHERE guild_id = $1 ORDER BY created_at`,
        [request.query.guildId],
      );
      return { channels: channels.rows };
    },
  );

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/community/guild-settings",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId"],
          additionalProperties: false,
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query<{
        welcome_channel_id: string | null;
        waiting_voice_channel_id: string | null;
        temporary_voice_category_id: string | null;
      }>(
        `SELECT welcome_channel_id, waiting_voice_channel_id, temporary_voice_category_id
       FROM guild_settings WHERE guild_id = $1`,
        [request.query.guildId],
      );
      const settings = result.rows[0];
      return {
        guildId: request.query.guildId,
        welcomeChannelId: settings?.welcome_channel_id ?? null,
        waitingVoiceChannelId: settings?.waiting_voice_channel_id ?? null,
        temporaryVoiceCategoryId: settings?.temporary_voice_category_id ?? null,
      };
    },
  );

  app.post<{ Params: { channelId: string }; Body: { guildId: string } }>(
    "/v1/community/temporary-voice-channels/:channelId/empty",
    {
      schema: {
        params: {
          type: "object",
          required: ["channelId"],
          properties: { channelId: idSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `UPDATE temporary_voice_channels
         SET delete_after = NOW() + INTERVAL '60 seconds'
         WHERE guild_id = $1 AND channel_id = $2
         RETURNING delete_after AS "deleteAfter"`,
        [request.body.guildId, request.params.channelId],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: "temporary_channel_not_found" });
      return { deleteAfter: result.rows[0].deleteAfter };
    },
  );

  app.post<{ Params: { channelId: string }; Body: { guildId: string } }>(
    "/v1/community/temporary-voice-channels/:channelId/active",
    {
      schema: {
        params: {
          type: "object",
          required: ["channelId"],
          properties: { channelId: idSchema },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `UPDATE temporary_voice_channels SET delete_after = NULL
         WHERE guild_id = $1 AND channel_id = $2`,
        [request.body.guildId, request.params.channelId],
      );
      if (!result.rowCount)
        return reply.code(404).send({ error: "temporary_channel_not_found" });
      return { active: true, channelId: request.params.channelId };
    },
  );

  app.delete<{
    Params: { channelId: string };
    Querystring: { guildId: string };
  }>(
    "/v1/community/temporary-voice-channels/:channelId",
    {
      schema: {
        params: {
          type: "object",
          required: ["channelId"],
          properties: { channelId: idSchema },
        },
        querystring: {
          type: "object",
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "community")
        return reply.code(403).send({ error: "forbidden" });
      await options.pool.query(
        "DELETE FROM temporary_voice_channels WHERE guild_id = $1 AND channel_id = $2",
        [request.query.guildId, request.params.channelId],
      );
      return { removed: true, channelId: request.params.channelId };
    },
  );

  app.post<{ Body: EventBody }>(
    "/v1/points/message",
    { schema: eventSchema },
    async (request, reply) => {
      if (request.service !== "game" || !request.body.messageId) {
        return reply
          .code(request.service !== "game" ? 403 : 400)
          .send({ error: "invalid_request" });
      }

      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const { guildId, userId, messageId } = request.body;
      if (key !== messageId) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_must_match_message_id" });
      }
      const scope = `message:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;

        await ensureMember(client, guildId, userId);
        const priorEvent = await client.query<{
          amount: number;
          user_id: string;
        }>(
          `SELECT amount, user_id FROM point_transactions
         WHERE guild_id = $1 AND idempotency_key = $2`,
          [guildId, `message:${messageId}`],
        );
        if (priorEvent.rowCount) {
          const existing = priorEvent.rows[0];
          if (existing.user_id !== userId) {
            const body = { error: "idempotency_key_conflict" };
            await saveIdempotentResponse(client, scope, key, 409, body);
            return { status: 409, body };
          }
          const points = existing.amount;
          const body = { awarded: points > 0, points: Math.max(points, 0) };
          await saveIdempotentResponse(client, scope, key, 200, body);
          return { status: 200, body };
        }
        const totals = await client.query<{
          points: string;
          cooled_down: boolean;
        }>(
          `SELECT COALESCE(SUM(amount) FILTER (
                  WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ), 0)::text AS points,
                COALESCE(MAX(created_at) <= NOW() - INTERVAL '30 seconds', TRUE) AS cooled_down
         FROM point_transactions
         WHERE guild_id = $1 AND user_id = $2 AND reason = 'message'`,
          [guildId, userId],
        );
        const { points, cooled_down: cooledDown } = totals.rows[0];
        const eligible = Number(points) < 100 && cooledDown;
        const awarded = eligible ? 1 : 0;
        await awardPoints(
          client,
          guildId,
          userId,
          awarded,
          "message",
          `message:${messageId}`,
        );
        const body = { awarded: awarded === 1, points: awarded };
        await saveIdempotentResponse(client, scope, key, 200, body);
        return { status: 200, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/points/balance",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId", "userId"],
          additionalProperties: false,
          properties: { guildId: idSchema, userId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query<{ points: string }>(
        `SELECT points::text FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
        [request.query.guildId, request.query.userId],
      );
      return {
        guildId: request.query.guildId,
        userId: request.query.userId,
        points: Number(result.rows[0]?.points ?? 0),
      };
    },
  );

  app.post<{ Body: { guildId: string; userId: string } }>(
    "/v1/points/daily",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await withTransaction(options.pool, async (client) => {
        await ensureMember(client, request.body.guildId, request.body.userId);
        const cooldown = await client.query<{ next_available_at: Date }>(
          "SELECT next_available_at FROM point_cooldowns WHERE guild_id = $1 AND user_id = $2 AND action = $3 FOR UPDATE",
          [request.body.guildId, request.body.userId, "daily"],
        );
        if (
          cooldown.rows[0] &&
          cooldown.rows[0].next_available_at.getTime() > Date.now()
        )
          return {
            status: 409,
            body: {
              error: "daily_cooldown",
              retryAfterSeconds: Math.ceil(
                (cooldown.rows[0].next_available_at.getTime() - Date.now()) /
                  1000,
              ),
            },
          };
        const points = 100;
        await awardPoints(
          client,
          request.body.guildId,
          request.body.userId,
          points,
          "daily",
          `daily:${request.body.guildId}:${request.body.userId}:${new Date().toISOString().slice(0, 10)}`,
        );
        await client.query(
          `INSERT INTO point_cooldowns (guild_id, user_id, action, next_available_at) VALUES ($1, $2, 'daily', NOW() + INTERVAL '1 day') ON CONFLICT (guild_id, user_id, action) DO UPDATE SET next_available_at = EXCLUDED.next_available_at, updated_at = NOW()`,
          [request.body.guildId, request.body.userId],
        );
        return { status: 200, body: { awarded: points } };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: { guildId: string; userId: string } }>(
    "/v1/points/work",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await withTransaction(options.pool, async (client) => {
        await ensureMember(client, request.body.guildId, request.body.userId);
        const cooldown = await client.query<{ next_available_at: Date }>(
          "SELECT next_available_at FROM point_cooldowns WHERE guild_id = $1 AND user_id = $2 AND action = $3 FOR UPDATE",
          [request.body.guildId, request.body.userId, "work"],
        );
        if (
          cooldown.rows[0] &&
          cooldown.rows[0].next_available_at.getTime() > Date.now()
        )
          return {
            status: 409,
            body: {
              error: "work_cooldown",
              retryAfterSeconds: Math.ceil(
                (cooldown.rows[0].next_available_at.getTime() - Date.now()) /
                  1000,
              ),
            },
          };
        const points = 20 + Math.floor(Math.random() * 31);
        await awardPoints(
          client,
          request.body.guildId,
          request.body.userId,
          points,
          "work",
          `work:${request.body.guildId}:${request.body.userId}:${Date.now()}`,
        );
        await client.query(
          `INSERT INTO point_cooldowns (guild_id, user_id, action, next_available_at) VALUES ($1, $2, 'work', NOW() + INTERVAL '1 hour') ON CONFLICT (guild_id, user_id, action) DO UPDATE SET next_available_at = EXCLUDED.next_available_at, updated_at = NOW()`,
          [request.body.guildId, request.body.userId],
        );
        return { status: 200, body: { awarded: points } };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: { guildId: string; userId: string } }>(
    "/v1/points/crime",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await withTransaction(options.pool, async (client) => {
        await ensureMember(client, request.body.guildId, request.body.userId);
        const cooldown = await client.query<{ next_available_at: Date }>(
          "SELECT next_available_at FROM point_cooldowns WHERE guild_id = $1 AND user_id = $2 AND action = $3 FOR UPDATE",
          [request.body.guildId, request.body.userId, "crime"],
        );
        if (
          cooldown.rows[0] &&
          cooldown.rows[0].next_available_at.getTime() > Date.now()
        )
          return {
            status: 409,
            body: {
              error: "crime_cooldown",
              retryAfterSeconds: Math.ceil(
                (cooldown.rows[0].next_available_at.getTime() - Date.now()) /
                  1000,
              ),
            },
          };
        const success = Math.random() < 0.65;
        const points = success ? 40 + Math.floor(Math.random() * 61) : 0;
        if (points > 0)
          await awardPoints(
            client,
            request.body.guildId,
            request.body.userId,
            points,
            "crime",
            `crime:${request.body.guildId}:${request.body.userId}:${Date.now()}`,
          );
        await client.query(
          `INSERT INTO point_cooldowns (guild_id, user_id, action, next_available_at) VALUES ($1, $2, 'crime', NOW() + INTERVAL '3 hours') ON CONFLICT (guild_id, user_id, action) DO UPDATE SET next_available_at = EXCLUDED.next_available_at, updated_at = NOW()`,
          [request.body.guildId, request.body.userId],
        );
        return { status: 200, body: { success, awarded: points } };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string; limit?: string } }>(
    "/v1/points/leaderboard",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const limit = Math.min(
        Math.max(Number(request.query.limit ?? 10) || 10, 3),
        25,
      );
      const result = await options.pool.query(
        `SELECT user_id, points::text FROM guild_members WHERE guild_id = $1 ORDER BY points DESC, user_id LIMIT $2`,
        [request.query.guildId, limit],
      );
      return {
        items: result.rows.map((row, index) => ({
          rank: index + 1,
          userId: row.user_id,
          points: Number(row.points),
        })),
      };
    },
  );

  app.get<{ Querystring: { guildId: string; userId: string; limit?: string } }>(
    "/v1/points/history",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const limit = Math.min(
        Math.max(Number(request.query.limit ?? 20) || 20, 1),
        50,
      );
      const result = await options.pool.query(
        `SELECT amount, reason, created_at FROM point_transactions WHERE guild_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3`,
        [request.query.guildId, request.query.userId, limit],
      );
      return {
        items: result.rows.map((row) => ({
          amount: Number(row.amount),
          reason: row.reason,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      fromUserId: string;
      toUserId: string;
      amount: number;
    };
  }>("/v1/points/transfer", async (request, reply) => {
    if (request.service !== "game")
      return reply.code(403).send({ error: "forbidden" });
    if (
      !Number.isInteger(request.body.amount) ||
      request.body.amount < 1 ||
      request.body.fromUserId === request.body.toUserId
    )
      return reply.code(400).send({ error: "invalid_transfer" });
    const result = await withTransaction(options.pool, async (client) => {
      await ensureMember(client, request.body.guildId, request.body.fromUserId);
      await ensureMember(client, request.body.guildId, request.body.toUserId);
      const balances = await client.query<{ user_id: string; points: string }>(
        "SELECT user_id, points::text FROM guild_members WHERE guild_id = $1 AND user_id IN ($2, $3) ORDER BY user_id FOR UPDATE",
        [request.body.guildId, request.body.fromUserId, request.body.toUserId],
      );
      const sender = balances.rows.find(
        (row) => row.user_id === request.body.fromUserId,
      );
      if (!sender || Number(sender.points) < request.body.amount)
        return { status: 409, body: { error: "insufficient_points" } };
      const key = `transfer:${request.body.guildId}:${request.body.fromUserId}:${request.body.toUserId}:${Date.now()}`;
      await awardPoints(
        client,
        request.body.guildId,
        request.body.fromUserId,
        -request.body.amount,
        "transfer_out",
        `${key}:out`,
      );
      await awardPoints(
        client,
        request.body.guildId,
        request.body.toUserId,
        request.body.amount,
        "transfer_in",
        `${key}:in`,
      );
      return { status: 200, body: { transferred: request.body.amount } };
    });
    return reply.code(result.status).send(result.body);
  });

  app.get<{
    Querystring: { guildId: string; period?: string; limit?: string };
  }>("/v1/points/period-leaderboard", async (request, reply) => {
    if (request.service !== "game")
      return reply.code(403).send({ error: "forbidden" });
    const period = request.query.period === "month" ? "month" : "week";
    const limit = Math.min(
      Math.max(Number(request.query.limit ?? 10) || 10, 3),
      25,
    );
    const result = await options.pool.query(
      `SELECT user_id, SUM(amount)::text AS points FROM point_transactions WHERE guild_id = $1 AND amount > 0 AND created_at >= NOW() - ($2::text)::interval GROUP BY user_id ORDER BY SUM(amount) DESC, user_id LIMIT $3`,
      [request.query.guildId, period === "month" ? "1 month" : "7 days", limit],
    );
    return {
      period,
      items: result.rows.map((row, index) => ({
        rank: index + 1,
        userId: row.user_id,
        points: Number(row.points),
      })),
    };
  });

  app.get<{ Querystring: { guildId: string; userId: string } }>(
    "/v1/achievements",
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `SELECT d.achievement_key, d.name, d.description, d.badge, a.earned_at FROM achievement_definitions d LEFT JOIN member_achievements a ON a.achievement_key = d.achievement_key AND a.guild_id = $1 AND a.user_id = $2 ORDER BY d.sort_order`,
        [request.query.guildId, request.query.userId],
      );
      return {
        items: result.rows.map((row) => ({
          key: row.achievement_key,
          name: row.name,
          description: row.description,
          badge: row.badge,
          earnedAt: row.earned_at?.toISOString() ?? null,
        })),
      };
    },
  );

  app.post<{
    Body: {
      guildId: string;
      userId: string;
      channelId: string;
      startedAt?: string;
    };
  }>("/v1/voice/sessions/start", async (request, reply) => {
    if (request.service !== "community" && request.service !== "game")
      return reply.code(403).send({ error: "forbidden" });
    await options.pool.query(
      "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [request.body.guildId],
    );
    await options.pool.query(
      `INSERT INTO voice_sessions (guild_id, user_id, channel_id, started_at) VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW())) ON CONFLICT (guild_id, user_id) WHERE ended_at IS NULL DO UPDATE SET channel_id = EXCLUDED.channel_id`,
      [
        request.body.guildId,
        request.body.userId,
        request.body.channelId,
        request.body.startedAt ?? null,
      ],
    );
    return { started: true };
  });
  app.post<{ Body: { guildId: string; userId: string; endedAt?: string } }>(
    "/v1/voice/sessions/stop",
    async (request, reply) => {
      if (request.service !== "community" && request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const result = await options.pool.query(
        `UPDATE voice_sessions SET ended_at = COALESCE($3::timestamptz, NOW()), duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (COALESCE($3::timestamptz, NOW()) - started_at))::integer) WHERE guild_id = $1 AND user_id = $2 AND ended_at IS NULL RETURNING duration_seconds`,
        [
          request.body.guildId,
          request.body.userId,
          request.body.endedAt ?? null,
        ],
      );
      return {
        stopped: (result.rowCount ?? 0) > 0,
        durationSeconds: Number(result.rows[0]?.duration_seconds ?? 0),
      };
    },
  );
  app.get<{ Querystring: { guildId: string; limit?: string } }>(
    "/v1/voice/sessions/leaderboard",
    async (request, reply) => {
      if (request.service !== "community" && request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const limit = Math.min(
        Math.max(Number(request.query.limit ?? 10) || 10, 3),
        25,
      );
      const result = await options.pool.query(
        `SELECT user_id, SUM(duration_seconds)::text AS duration_seconds FROM voice_sessions WHERE guild_id = $1 GROUP BY user_id ORDER BY SUM(duration_seconds) DESC LIMIT $2`,
        [request.query.guildId, limit],
      );
      return {
        items: result.rows.map((row, index) => ({
          rank: index + 1,
          userId: row.user_id,
          durationSeconds: Number(row.duration_seconds),
        })),
      };
    },
  );

  app.post<{ Body: EventBody }>(
    "/v1/points/voice-tick",
    { schema: eventSchema },
    async (request, reply) => {
      if (request.service !== "game" || !request.body.tickId) {
        return reply
          .code(request.service !== "game" ? 403 : 400)
          .send({ error: "invalid_request" });
      }

      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const { guildId, userId, tickId } = request.body;
      if (key !== tickId) {
        return reply
          .code(400)
          .send({ error: "idempotency_key_must_match_tick_id" });
      }
      const scope = `voice:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;

        await ensureMember(client, guildId, userId);
        const priorEvent = await client.query<{
          amount: number;
          user_id: string;
        }>(
          `SELECT amount, user_id FROM point_transactions
         WHERE guild_id = $1 AND idempotency_key = $2`,
          [guildId, `voice:${tickId}`],
        );
        if (priorEvent.rowCount) {
          const existing = priorEvent.rows[0];
          if (existing.user_id !== userId) {
            const body = { error: "idempotency_key_conflict" };
            await saveIdempotentResponse(client, scope, key, 409, body);
            return { status: 409, body };
          }
          const points = existing.amount;
          const body = { awarded: points > 0, points: Math.max(points, 0) };
          await saveIdempotentResponse(client, scope, key, 200, body);
          return { status: 200, body };
        }
        const totals = await client.query<{
          points: string;
          cooled_down: boolean;
        }>(
          `SELECT COALESCE(SUM(amount) FILTER (
                  WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                ), 0)::text AS points,
                COALESCE(MAX(created_at) <= NOW() - INTERVAL '5 minutes', TRUE) AS cooled_down
         FROM point_transactions
         WHERE guild_id = $1 AND user_id = $2 AND reason = 'voice'`,
          [guildId, userId],
        );
        const { points, cooled_down: cooledDown } = totals.rows[0];
        const eligible = Number(points) < 60 && cooledDown;
        const awarded = eligible ? 1 : 0;
        await awardPoints(
          client,
          guildId,
          userId,
          awarded,
          "voice",
          `voice:${tickId}`,
        );
        const body = { awarded: awarded === 1, points: awarded };
        await saveIdempotentResponse(client, scope, key, 200, body);
        return { status: 200, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: Omit<EventBody, "messageId" | "tickId"> }>(
    "/v1/fortune/draw",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId"],
          properties: { guildId: idSchema, userId: idSchema },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const { guildId, userId } = request.body;
      const scope = `fortune:${guildId}:${userId}`;
      const outcome = fortuneForRoll(randomInt(100));

      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;

        await ensureMember(client, guildId, userId);
        const existing = await client.query(
          `SELECT 1 FROM fortune_draws
         WHERE guild_id = $1 AND user_id = $2
           AND draw_date = (NOW() AT TIME ZONE 'UTC')::date`,
          [guildId, userId],
        );
        if (existing.rowCount) {
          const body = { error: "already_drawn_today" };
          await saveIdempotentResponse(client, scope, key, 409, body);
          return { status: 409, body };
        }

        await client.query(
          `INSERT INTO fortune_draws (guild_id, user_id, draw_date, result, points)
         VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, $3, $4)`,
          [guildId, userId, outcome.name, outcome.points],
        );
        await awardPoints(
          client,
          guildId,
          userId,
          outcome.points,
          "fortune",
          `fortune:${guildId}:${userId}:${new Date().toISOString().slice(0, 10)}`,
        );
        const body = { result: outcome.name, points: outcome.points };
        await saveIdempotentResponse(client, scope, key, 200, body);
        return { status: 200, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/rewards",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId"],
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const rewards = await options.pool.query(
        `SELECT id, name, description, cost FROM rewards
       WHERE guild_id = $1 AND active = TRUE ORDER BY id`,
        [request.query.guildId],
      );
      return { rewards: rewards.rows };
    },
  );

  app.post<{
    Params: { rewardId: string };
    Body: { guildId: string; userId: string };
  }>(
    "/v1/rewards/:rewardId/redeem",
    {
      schema: {
        params: {
          type: "object",
          required: ["rewardId"],
          properties: { rewardId: { type: "string", pattern: "^[0-9]+$" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId"],
          properties: { guildId: idSchema, userId: idSchema },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string") {
        return reply.code(400).send({ error: "idempotency_key_required" });
      }
      const { guildId, userId } = request.body;
      const scope = `redemption:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          rewardId: request.params.rewardId,
        });
        if (idempotency.replay) return idempotency.replay;

        await ensureMember(client, guildId, userId);
        const reward = await client.query<{ cost: number }>(
          "SELECT cost FROM rewards WHERE guild_id = $1 AND id = $2 AND active = TRUE FOR UPDATE",
          [guildId, request.params.rewardId],
        );
        let status = 200;
        let body: object;
        if (!reward.rowCount) {
          status = 404;
          body = { error: "reward_not_found" };
        } else {
          const cost = reward.rows[0].cost;
          const balance = await client.query<{ points: string }>(
            "SELECT points::text FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE",
            [guildId, userId],
          );
          if (Number(balance.rows[0].points) < cost) {
            status = 409;
            body = { error: "insufficient_points" };
          } else {
            const redemption = await client.query<{ id: string }>(
              `INSERT INTO reward_redemptions
                 (guild_id, user_id, reward_id, cost, idempotency_key)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [guildId, userId, request.params.rewardId, cost, key],
            );
            await awardPoints(
              client,
              guildId,
              userId,
              -cost,
              "redemption",
              `redemption:${key}`,
            );
            body = { redemptionId: redemption.rows[0].id, cost };
          }
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Body: CreateRaffleBody }>(
    "/v1/raffles",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "createdBy", "title", "prize", "entryCost"],
          properties: {
            guildId: idSchema,
            createdBy: idSchema,
            title: { type: "string", minLength: 1, maxLength: 200 },
            prize: { type: "object", minProperties: 1, maxProperties: 20 },
            entryCost: { type: "integer", minimum: 0, maximum: 2_000_000_000 },
            eligibility: {
              type: "object",
              additionalProperties: false,
              properties: {
                minPoints: {
                  type: "integer",
                  minimum: 0,
                  maximum: 2_000_000_000,
                },
                roleIds: { type: "array", maxItems: 50, items: idSchema },
              },
            },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const {
        guildId,
        createdBy,
        title,
        prize,
        entryCost,
        eligibility = {},
      } = request.body;
      if (!title.trim())
        return reply.code(400).send({ error: "invalid_title" });
      const scope = `raffle-create:${guildId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        await client.query(
          "INSERT INTO guilds (guild_id) VALUES ($1) ON CONFLICT DO NOTHING",
          [guildId],
        );
        const raffle = await client.query<{ id: string }>(
          `INSERT INTO raffles (guild_id, title, prize, entry_cost, eligibility, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [
            guildId,
            title.trim(),
            JSON.stringify(prize),
            entryCost,
            JSON.stringify(eligibility),
            createdBy,
          ],
        );
        const body = {
          raffleId: raffle.rows[0].id,
          status: "draft",
          title: title.trim(),
          prize,
          entryCost,
          eligibility,
        };
        await saveIdempotentResponse(client, scope, key, 201, body);
        return { status: 201, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Querystring: { guildId: string } }>(
    "/v1/raffles",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["guildId"],
          additionalProperties: false,
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const raffles = await options.pool.query(
        `SELECT id AS "raffleId", title, prize, eligibility, entry_cost AS "entryCost",
              status, starts_at AS "startsAt", ends_at AS "endsAt",
              created_by AS "createdBy", created_at AS "createdAt"
       FROM raffles WHERE guild_id = $1 ORDER BY id DESC LIMIT 50`,
        [request.query.guildId],
      );
      return { raffles: raffles.rows };
    },
  );

  app.patch<{
    Params: { raffleId: string };
    Body: RaffleActionBody & { prize: Record<string, unknown> };
  }>(
    "/v1/raffles/:raffleId/prize",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId", "prize"],
          properties: {
            guildId: idSchema,
            actorId: idSchema,
            prize: { type: "object", minProperties: 1, maxProperties: 20 },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const scope = `raffle-prize:${request.body.guildId}:${request.params.raffleId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          raffleId: request.params.raffleId,
        });
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{ created_by: string }>(
          "SELECT created_by FROM raffles WHERE guild_id = $1 AND id = $2 FOR UPDATE",
          [request.body.guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "raffle_not_found" };
        } else if (raffle.rows[0].created_by !== request.body.actorId) {
          status = 403;
          body = { error: "raffle_creator_required" };
        } else {
          await client.query(
            "UPDATE raffles SET prize = $3 WHERE guild_id = $1 AND id = $2",
            [
              request.body.guildId,
              request.params.raffleId,
              JSON.stringify(request.body.prize),
            ],
          );
          body = {
            raffleId: request.params.raffleId,
            prize: request.body.prize,
          };
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{
    Params: { raffleId: string };
    Body: RaffleActionBody & { durationMinutes?: number };
  }>(
    "/v1/raffles/:raffleId/start",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId"],
          properties: {
            guildId: idSchema,
            actorId: idSchema,
            durationMinutes: { type: "integer", minimum: 1, maximum: 10_080 },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const { guildId, actorId, durationMinutes } = request.body;
      const scope = `raffle:${guildId}:${request.params.raffleId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          raffleId: request.params.raffleId,
        });
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{
          status: string;
          created_by: string;
        }>(
          "SELECT status, created_by FROM raffles WHERE guild_id = $1 AND id = $2 FOR UPDATE",
          [guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "raffle_not_found" };
        } else if (raffle.rows[0].created_by !== actorId) {
          status = 403;
          body = { error: "raffle_creator_required" };
        } else if (raffle.rows[0].status !== "draft") {
          status = 409;
          body = { error: "raffle_not_draft" };
        } else {
          const updated = await client.query<{
            starts_at: Date;
            ends_at: Date | null;
          }>(
            `UPDATE raffles
             SET status = 'open', starts_at = NOW(),
                 ends_at = CASE WHEN $3::integer IS NULL THEN NULL
                                ELSE NOW() + ($3::text || ' minutes')::interval END
             WHERE guild_id = $1 AND id = $2
             RETURNING starts_at, ends_at`,
            [guildId, request.params.raffleId, durationMinutes ?? null],
          );
          body = {
            raffleId: request.params.raffleId,
            status: "open",
            startsAt: updated.rows[0].starts_at,
            endsAt: updated.rows[0].ends_at,
          };
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{
    Params: { raffleId: string };
    Body: { guildId: string; userId: string; roleIds?: string[] };
  }>(
    "/v1/raffles/:raffleId/entries",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "userId"],
          properties: {
            guildId: idSchema,
            userId: idSchema,
            roleIds: { type: "array", maxItems: 50, items: idSchema },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const { guildId, userId, roleIds = [] } = request.body;
      const scope = `raffle-entry:${guildId}:${request.params.raffleId}`;
      const payload = { ...request.body, raffleId: request.params.raffleId };
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, payload);
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{
          status: string;
          entry_cost: number;
          accepting_entries: boolean;
          eligibility: { minPoints?: number; roleIds?: string[] };
        }>(
          `SELECT status, entry_cost, eligibility,
                  (ends_at IS NULL OR ends_at > NOW()) AS accepting_entries
           FROM raffles
           WHERE guild_id = $1 AND id = $2 FOR UPDATE`,
          [guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "raffle_not_found" };
        } else if (
          raffle.rows[0].status !== "open" ||
          !raffle.rows[0].accepting_entries
        ) {
          status = 409;
          body = { error: "raffle_not_open" };
        } else {
          await ensureMember(client, guildId, userId);
          const alreadyEntered = await client.query(
            "SELECT 1 FROM raffle_entries WHERE raffle_id = $1 AND user_id = $2",
            [request.params.raffleId, userId],
          );
          if (alreadyEntered.rowCount) {
            status = 409;
            body = { error: "already_entered_raffle" };
          } else {
            const cost = raffle.rows[0].entry_cost;
            const balance = await client.query<{ points: string }>(
              "SELECT points::text FROM guild_members WHERE guild_id = $1 AND user_id = $2 FOR UPDATE",
              [guildId, userId],
            );
            const minPoints = Number(
              raffle.rows[0].eligibility?.minPoints ?? 0,
            );
            const requiredRoleIds = raffle.rows[0].eligibility?.roleIds ?? [];
            const hasRequiredRoles = requiredRoleIds.every((roleId) =>
              roleIds.includes(roleId),
            );
            if (!hasRequiredRoles) {
              status = 403;
              body = { error: "raffle_role_eligibility_not_met" };
            } else if (Number(balance.rows[0].points) < minPoints) {
              status = 403;
              body = { error: "raffle_eligibility_not_met", minPoints };
            } else if (Number(balance.rows[0].points) < cost) {
              status = 409;
              body = { error: "insufficient_points" };
            } else {
              await client.query(
                `INSERT INTO raffle_entries (raffle_id, guild_id, user_id)
                 VALUES ($1, $2, $3)`,
                [request.params.raffleId, guildId, userId],
              );
              if (cost > 0) {
                await awardPoints(
                  client,
                  guildId,
                  userId,
                  -cost,
                  "raffle_entry",
                  `raffle-entry:${request.params.raffleId}:${userId}`,
                );
              }
              body = {
                raffleId: request.params.raffleId,
                entered: true,
                entryCount: 1,
                cost,
              };
            }
          }
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { raffleId: string }; Body: RaffleActionBody }>(
    "/v1/raffles/:raffleId/close",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId"],
          properties: { guildId: idSchema, actorId: idSchema },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const scope = `raffle:${request.body.guildId}:${request.params.raffleId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          raffleId: request.params.raffleId,
        });
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{
          status: string;
          created_by: string;
        }>(
          "SELECT status, created_by FROM raffles WHERE guild_id = $1 AND id = $2 FOR UPDATE",
          [request.body.guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "raffle_not_found" };
        } else if (raffle.rows[0].created_by !== request.body.actorId) {
          status = 403;
          body = { error: "raffle_creator_required" };
        } else if (raffle.rows[0].status !== "open") {
          status = 409;
          body = { error: "raffle_not_open" };
        } else {
          await client.query(
            `UPDATE raffles SET status = 'closed', ends_at = NOW()
             WHERE guild_id = $1 AND id = $2`,
            [request.body.guildId, request.params.raffleId],
          );
          body = { raffleId: request.params.raffleId, status: "closed" };
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { raffleId: string }; Body: RaffleActionBody }>(
    "/v1/raffles/:raffleId/draw",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId"],
          properties: { guildId: idSchema, actorId: idSchema },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const { guildId, actorId } = request.body;
      const scope = `raffle:${guildId}:${request.params.raffleId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          raffleId: request.params.raffleId,
        });
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{
          status: string;
          created_by: string;
          prize: Record<string, unknown>;
        }>(
          `SELECT status, created_by, prize FROM raffles
           WHERE guild_id = $1 AND id = $2 FOR UPDATE`,
          [guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "raffle_not_found" };
        } else if (raffle.rows[0].created_by !== actorId) {
          status = 403;
          body = { error: "raffle_creator_required" };
        } else if (raffle.rows[0].status !== "closed") {
          status = 409;
          body = { error: "raffle_must_be_closed" };
        } else {
          const entries = await client.query<{ user_id: string }>(
            `SELECT user_id FROM raffle_entries WHERE raffle_id = $1 ORDER BY user_id`,
            [request.params.raffleId],
          );
          if (!entries.rowCount) {
            status = 409;
            body = { error: "raffle_has_no_entries" };
          } else {
            const winner = entries.rows[randomInt(entries.rows.length)].user_id;
            const resultRow = await client.query<{ id: string }>(
              `INSERT INTO raffle_results (raffle_id, draw_number, user_id, prize)
               VALUES ($1, 1, $2, $3) RETURNING id`,
              [
                request.params.raffleId,
                winner,
                JSON.stringify(raffle.rows[0].prize),
              ],
            );
            await client.query(
              `UPDATE raffles SET status = 'drawn'
               WHERE guild_id = $1 AND id = $2`,
              [guildId, request.params.raffleId],
            );
            body = {
              raffleId: request.params.raffleId,
              resultId: resultRow.rows[0].id,
              winnerId: winner,
              prize: raffle.rows[0].prize,
              redrawn: false,
            };
          }
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post<{ Params: { raffleId: string }; Body: RaffleActionBody }>(
    "/v1/raffles/:raffleId/redraw",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "actorId"],
          properties: { guildId: idSchema, actorId: idSchema },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const { guildId, actorId } = request.body;
      const scope = `raffle:${guildId}:${request.params.raffleId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(client, scope, key, {
          ...request.body,
          raffleId: request.params.raffleId,
        });
        if (idempotency.replay) return idempotency.replay;
        const raffle = await client.query<{
          created_by: string;
          prize: Record<string, unknown>;
        }>(
          `SELECT created_by, prize FROM raffles
           WHERE guild_id = $1 AND id = $2 AND status = 'drawn' FOR UPDATE`,
          [guildId, request.params.raffleId],
        );
        let status = 200;
        let body: object;
        if (!raffle.rowCount) {
          status = 404;
          body = { error: "drawn_raffle_not_found" };
        } else if (raffle.rows[0].created_by !== actorId) {
          status = 403;
          body = { error: "raffle_creator_required" };
        } else {
          const previous = await client.query<{
            id: string;
            draw_number: number;
          }>(
            `SELECT id, draw_number FROM raffle_results
             WHERE raffle_id = $1 ORDER BY draw_number DESC LIMIT 1`,
            [request.params.raffleId],
          );
          const eligible = await client.query<{ user_id: string }>(
            `SELECT entry.user_id FROM raffle_entries AS entry
             WHERE entry.raffle_id = $1
               AND NOT EXISTS (
                 SELECT 1 FROM raffle_results AS prior
                 WHERE prior.raffle_id = entry.raffle_id AND prior.user_id = entry.user_id
               )
             ORDER BY entry.user_id`,
            [request.params.raffleId],
          );
          if (!eligible.rowCount) {
            status = 409;
            body = { error: "no_eligible_reroll_winners" };
          } else {
            const winner =
              eligible.rows[randomInt(eligible.rows.length)].user_id;
            const drawNumber = previous.rows[0].draw_number + 1;
            const resultRow = await client.query<{ id: string }>(
              `INSERT INTO raffle_results
                 (raffle_id, draw_number, user_id, prize, redrawn_from)
               VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [
                request.params.raffleId,
                drawNumber,
                winner,
                JSON.stringify(raffle.rows[0].prize),
                previous.rows[0].id,
              ],
            );
            body = {
              raffleId: request.params.raffleId,
              resultId: resultRow.rows[0].id,
              winnerId: winner,
              prize: raffle.rows[0].prize,
              redrawn: true,
            };
          }
        }
        await saveIdempotentResponse(client, scope, key, status, body);
        return { status, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get<{ Params: { raffleId: string }; Querystring: { guildId: string } }>(
    "/v1/raffles/:raffleId/history",
    {
      schema: {
        params: {
          type: "object",
          required: ["raffleId"],
          properties: {
            raffleId: { type: "string", pattern: "^[0-9]{1,19}$" },
          },
        },
        querystring: {
          type: "object",
          required: ["guildId"],
          additionalProperties: false,
          properties: { guildId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "game")
        return reply.code(403).send({ error: "forbidden" });
      const raffle = await options.pool.query(
        `SELECT id AS "raffleId", title, prize, entry_cost AS "entryCost",
                status, starts_at AS "startsAt", ends_at AS "endsAt",
                created_by AS "createdBy"
         FROM raffles WHERE guild_id = $1 AND id = $2`,
        [request.query.guildId, request.params.raffleId],
      );
      if (!raffle.rowCount)
        return reply.code(404).send({ error: "raffle_not_found" });
      const entries = await options.pool.query(
        `SELECT user_id AS "userId", entry_count AS "entryCount", created_at AS "createdAt"
         FROM raffle_entries WHERE raffle_id = $1 ORDER BY created_at`,
        [request.params.raffleId],
      );
      const results = await options.pool.query(
        `SELECT id AS "resultId", draw_number AS "drawNumber", user_id AS "userId",
                prize, redrawn_from AS "redrawnFrom", created_at AS "createdAt"
         FROM raffle_results WHERE raffle_id = $1 ORDER BY draw_number`,
        [request.params.raffleId],
      );
      return {
        raffle: raffle.rows[0],
        entries: entries.rows,
        results: results.rows,
      };
    },
  );

  app.post<{ Body: { guildId: string; requesterId: string; text: string } }>(
    "/v1/tts/jobs",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["guildId", "requesterId", "text"],
          properties: {
            guildId: idSchema,
            requesterId: idSchema,
            text: { type: "string", minLength: 1, maxLength: 500 },
          },
        },
        headers: eventSchema.headers,
      },
    },
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        return reply.code(400).send({ error: "idempotency_key_required" });
      const { guildId, requesterId, text } = request.body;
      if (!text.trim()) return reply.code(400).send({ error: "empty_text" });
      const scope = `tts:${guildId}:${requesterId}`;
      const result = await withTransaction(options.pool, async (client) => {
        const idempotency = await beginIdempotent(
          client,
          scope,
          key,
          request.body,
        );
        if (idempotency.replay) return idempotency.replay;
        const job = await client.query<{ id: string }>(
          `INSERT INTO tts_jobs (idempotency_key, guild_id, requester_id, text)
         VALUES ($1, $2, $3, $4) RETURNING id::text`,
          [key, guildId, requesterId, text.trim()],
        );
        const body = { jobId: job.rows[0].id, status: "queued" as const };
        await saveIdempotentResponse(client, scope, key, 202, body);
        return { status: 202, body };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/v1/tts/jobs/claim",
    {
      schema: { body: { type: "object", additionalProperties: false } },
    },
    async (request, reply) => {
      if (request.service !== "tts")
        return reply.code(403).send({ error: "forbidden" });
      const job = await withTransaction(options.pool, async (client) => {
        await client.query(
          `UPDATE tts_jobs
         SET status = 'failed', error_code = 'worker_timeout', updated_at = NOW(), claimed_at = NULL
         WHERE status = 'processing' AND claimed_at < NOW() - INTERVAL '2 minutes'
           AND attempts >= 3`,
        );
        const claimed = await client.query<{
          id: string;
          guild_id: string;
          requester_id: string;
          text: string;
          attempts: number;
        }>(
          `WITH next_job AS (
           SELECT id FROM tts_jobs
           WHERE attempts < 3
             AND (status = 'queued'
               OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '2 minutes'))
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE tts_jobs AS job
         SET status = 'processing', attempts = job.attempts + 1,
             claimed_at = NOW(), updated_at = NOW(), error_code = NULL
         FROM next_job
         WHERE job.id = next_job.id
         RETURNING job.id::text AS "jobId",
                   job.guild_id AS "guildId",
                   job.requester_id AS "requesterId",
                   job.text, job.attempts`,
        );
        return claimed.rows[0] ?? null;
      });
      if (!job) return reply.code(204).send();
      return job;
    },
  );

  app.get<{
    Params: { jobId: string };
    Querystring: { guildId: string; requesterId: string };
  }>(
    "/v1/tts/jobs/:jobId",
    {
      schema: {
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: "^[0-9]{1,19}$" } },
        },
        querystring: {
          type: "object",
          required: ["guildId", "requesterId"],
          additionalProperties: false,
          properties: { guildId: idSchema, requesterId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const job = await options.pool.query<{
        id: string;
        status: "queued" | "processing" | "succeeded" | "failed";
        error_code: string | null;
      }>(
        `SELECT id::text, status, error_code
         FROM tts_jobs
         WHERE id = $1 AND guild_id = $2 AND requester_id = $3`,
        [
          request.params.jobId,
          request.query.guildId,
          request.query.requesterId,
        ],
      );
      if (!job.rowCount)
        return reply.code(404).send({ error: "tts_job_not_found" });
      return {
        jobId: job.rows[0].id,
        status: job.rows[0].status,
        errorCode: job.rows[0].error_code,
      };
    },
  );

  app.post<{ Params: { jobId: string } }>(
    "/v1/tts/jobs/:jobId/complete",
    {
      schema: {
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: "^[0-9]{1,19}$" } },
        },
        body: { type: "object", additionalProperties: false },
      },
    },
    async (request, reply) => {
      if (request.service !== "tts")
        return reply.code(403).send({ error: "forbidden" });
      const audioPath = `${request.params.jobId}.wav`;
      const filePath = join(
        options.ttsAudioDirectory ??
          process.env.TTS_AUDIO_DIR ??
          "/tmp/yanagi-tts",
        audioPath,
      );
      try {
        await access(filePath);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        return reply.code(409).send({ error: "tts_audio_missing" });
      }
      const updated = await options.pool.query(
        `UPDATE tts_jobs
         SET status = 'succeeded', audio_path = $2, error_code = NULL,
             claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'processing'`,
        [request.params.jobId, audioPath],
      );
      if (!updated.rowCount)
        return reply.code(409).send({ error: "tts_job_not_processing" });
      return { jobId: request.params.jobId, status: "succeeded" };
    },
  );

  app.post<{ Params: { jobId: string }; Body: { errorCode: string } }>(
    "/v1/tts/jobs/:jobId/fail",
    {
      schema: {
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: "^[0-9]{1,19}$" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["errorCode"],
          properties: {
            errorCode: { type: "string", pattern: "^[a-z0-9_]{1,64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "tts")
        return reply.code(403).send({ error: "forbidden" });
      const failed = await options.pool.query<{ status: "queued" | "failed" }>(
        `UPDATE tts_jobs
         SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
             error_code = $2, claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'processing'
         RETURNING status`,
        [request.params.jobId, request.body.errorCode],
      );
      if (!failed.rowCount)
        return reply.code(409).send({ error: "tts_job_not_processing" });
      return { jobId: request.params.jobId, status: failed.rows[0].status };
    },
  );

  app.get<{
    Params: { jobId: string };
    Querystring: { guildId: string; requesterId: string };
  }>(
    "/v1/tts/jobs/:jobId/audio",
    {
      schema: {
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: "^[0-9]{1,19}$" } },
        },
        querystring: {
          type: "object",
          required: ["guildId", "requesterId"],
          additionalProperties: false,
          properties: { guildId: idSchema, requesterId: idSchema },
        },
      },
    },
    async (request, reply) => {
      if (request.service !== "voice")
        return reply.code(403).send({ error: "forbidden" });
      const job = await options.pool.query<{ audio_path: string | null }>(
        `SELECT audio_path FROM tts_jobs
         WHERE id = $1 AND guild_id = $2 AND requester_id = $3 AND status = 'succeeded'`,
        [
          request.params.jobId,
          request.query.guildId,
          request.query.requesterId,
        ],
      );
      if (
        !job.rowCount ||
        job.rows[0].audio_path !== `${request.params.jobId}.wav`
      ) {
        return reply.code(404).send({ error: "tts_audio_not_found" });
      }
      const filePath = join(
        options.ttsAudioDirectory ??
          process.env.TTS_AUDIO_DIR ??
          "/tmp/yanagi-tts",
        job.rows[0].audio_path,
      );
      try {
        await access(filePath);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
        return reply.code(404).send({ error: "tts_audio_not_found" });
      }
      return reply.type("audio/wav").send(createReadStream(filePath));
    },
  );

  return app;
}
