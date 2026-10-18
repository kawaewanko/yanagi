import { afterEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { buildApp, fortuneForRoll } from "./app.js";

describe("Core API authentication", () => {
  const pools: Pool[] = [];
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  describe("fortuneForRoll", () => {
    const cases: Array<[number, string, number]> = [
      [0, "daikichi", 50],
      [4, "daikichi", 50],
      [5, "chukichi", 30],
      [19, "chukichi", 30],
      [20, "kichi", 20],
      [44, "kichi", 20],
      [45, "shokichi", 10],
      [69, "shokichi", 10],
      [70, "suekichi", 5],
      [89, "suekichi", 5],
      [90, "kyo", 0],
      [99, "kyo", 0],
    ];

    it.each(cases)("maps roll %i to %s (%i points)", (roll, result, points) => {
      expect(fortuneForRoll(roll)).toMatchObject({ name: result, points });
    });

    it("rejects rolls outside the 0-99 range", () => {
      expect(() => fortuneForRoll(100)).toThrow(RangeError);
      expect(() => fortuneForRoll(-1)).toThrow(RangeError);
    });
  });

  it("allows the health endpoint without service credentials", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { game: "test-game-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "unavailable" });
  });

  it("rejects missing service credentials before accessing the database", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { game: "test-game-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/fortune/draw",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthorized" });
  });

  it("returns a clear disabled response without accessing the database", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { game: "test-game-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: "Bearer test-game-key",
        "idempotency-key": "ai-test-disabled",
      },
      payload: { guildId: "guild-1", userId: "user-1", message: "こんにちは" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "ai_disabled" });
  });

  it("allows the dedicated AI service credential to invoke the AI route", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { ai: "test-ai-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: "Bearer test-ai-key",
        "idempotency-key": "ai-test-dedicated-key",
      },
      payload: { guildId: "guild-1", userId: "user-1", message: "こんにちは" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "ai_disabled" });
  });

  it("rejects blank AI messages before database or model access", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { game: "test-game-key" },
      aiEnabled: true,
      ollamaFetch: vi.fn(),
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: "Bearer test-game-key",
        "idempotency-key": "ai-test-blank",
      },
      payload: { guildId: "guild-1", userId: "user-1", message: "   " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "message_must_not_be_blank" });
  });

  it("does not allow a Community credential to invoke the Game-scoped AI route", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { community: "test-community-key", game: "test-game-key" },
      aiEnabled: true,
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: "Bearer test-community-key",
        "idempotency-key": "ai-test-community-forbidden",
      },
      payload: { guildId: "guild-1", userId: "user-1", message: "こんにちは" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("enforces the AI message length limit before database access", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { game: "test-game-key" },
      aiEnabled: true,
      ollamaFetch: vi.fn(),
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/ai/chat",
      headers: {
        authorization: "Bearer test-game-key",
        "idempotency-key": "ai-test-too-long",
      },
      payload: {
        guildId: "guild-1",
        userId: "user-1",
        message: "a".repeat(1001),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it("does not allow a community service credential to call game routes", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { community: "test-community-key", game: "test-game-key" },
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/fortune/draw",
      headers: {
        authorization: "Bearer test-community-key",
        "idempotency-key": "test-fortune-event-1",
      },
      payload: { guildId: "guild-1", userId: "user-1" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("does not allow a Game service credential to read Community guild settings", async () => {
    const pool = new Pool({
      connectionString: "******127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { community: "test-community-key", game: "test-game-key" },
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/v1/community/guild-settings?guildId=123",
      headers: { authorization: "Bearer test-game-key" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("requires a message event ID to match its idempotency key", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { game: "test-game-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/points/message",
      headers: {
        authorization: "Bearer test-game-key",
        "idempotency-key": "different-event-id",
      },
      payload: { guildId: "guild-1", userId: "user-1", messageId: "message-1" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "idempotency_key_must_match_message_id",
    });
  });

  it("requires the Game service credential for raffle routes", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { community: "test-community-key", game: "test-game-key" },
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/raffles",
      headers: {
        authorization: "Bearer test-community-key",
        "idempotency-key": "raffle-test-create",
      },
      payload: {
        guildId: "guild-1",
        createdBy: "user-1",
        title: "Test raffle",
        prize: { name: "test" },
        entryCost: 0,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("rejects blank raffle titles before database access", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({ pool, serviceKeys: { game: "test-game-key" } });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/raffles",
      headers: {
        authorization: "Bearer test-game-key",
        "idempotency-key": "raffle-test-blank-title",
      },
      payload: {
        guildId: "guild-1",
        createdBy: "user-1",
        title: "   ",
        prize: { name: "test" },
        entryCost: 0,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid_title" });
  });

  it("does not allow a bot service credential to run maintenance cleanup", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { game: "test-game-key", worker: "test-worker-key" },
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/maintenance/retention",
      headers: { authorization: "Bearer test-game-key" },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });

  it("requires the Voice service credential and enforces the TTS text limit", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { community: "test-community-key", voice: "test-voice-key" },
    });
    pools.push(pool);
    apps.push(app);

    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/tts/jobs",
      headers: {
        authorization: "Bearer test-community-key",
        "idempotency-key": "tts-test-forbidden",
      },
      payload: { guildId: "guild-1", requesterId: "user-1", text: "hello" },
    });
    expect(forbidden.statusCode).toBe(403);

    const tooLong = await app.inject({
      method: "POST",
      url: "/v1/tts/jobs",
      headers: {
        authorization: "Bearer test-voice-key",
        "idempotency-key": "tts-test-too-long",
      },
      payload: {
        guildId: "guild-1",
        requesterId: "user-1",
        text: "あ".repeat(501),
      },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it("allows only the TTS service to claim queued jobs", async () => {
    const pool = new Pool({
      connectionString: "postgres://yanagi:yanagi@127.0.0.1:1/yanagi",
      connectionTimeoutMillis: 100,
    });
    const app = buildApp({
      pool,
      serviceKeys: { voice: "test-voice-key", tts: "test-tts-key" },
    });
    pools.push(pool);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/tts/jobs/claim",
      headers: {
        authorization: "Bearer test-voice-key",
        "content-type": "application/json",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden" });
  });
});
