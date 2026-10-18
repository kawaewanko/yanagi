import { describe, expect, it, vi } from "vitest";
import { CoreApiClient, CoreApiError } from "./index.js";

describe("CoreApiClient", () => {
  it("sends community voice events with service auth and event idempotency", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ recorded: true, eventId: "event-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      {
        baseUrl: "http://localhost:3000/",
        apiKey: "community-key",
      },
      fetcher,
    );

    await expect(
      client.recordVoiceEvent({
        guildId: "guild-1",
        userId: "user-1",
        channelId: "channel-1",
        action: "join",
        eventId: "event-1",
      }),
    ).resolves.toEqual({ recorded: true, eventId: "event-1" });

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:3000/v1/community/voice-events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer community-key",
          "Idempotency-Key": "event-1",
          "content-type": "application/json",
        }),
      }),
    );
  });

  it("loads and validates per-guild Community settings through the authenticated API", async () => {
    const expected = {
      guildId: "guild-1",
      welcomeChannelId: "1234567890",
      waitingVoiceChannelId: null,
      temporaryVoiceCategoryId: "9876543210",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(expected), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "community-key" },
      fetcher,
    );

    await expect(client.getCommunityGuildSettings("guild-1")).resolves.toEqual(
      expected,
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:3000/v1/community/guild-settings?guildId=guild-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer community-key",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects invalid per-guild Community settings responses", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          guildId: "guild-1",
          welcomeChannelId: "not-a-discord-id",
          waitingVoiceChannelId: null,
          temporaryVoiceCategoryId: null,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "community-key" },
      fetcher,
    );

    await expect(
      client.getCommunityGuildSettings("guild-1"),
    ).rejects.toMatchObject({
      name: "CoreApiError",
      code: "invalid_response",
    });
  });

  it("exposes API errors without returning a success-shaped fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "key" },
      fetcher,
    );

    await expect(
      client.recordAuditEvent({
        guildId: "guild-1",
        actorId: null,
        action: "channel_delete",
        eventId: "event-2",
        details: {},
      }),
    ).rejects.toMatchObject<Partial<CoreApiError>>({
      name: "CoreApiError",
      status: 403,
      code: "forbidden",
    });
  });

  it("rejects a non-HTTP Core API URL", () => {
    expect(
      () => new CoreApiClient({ baseUrl: "file:///tmp/api", apiKey: "key" }),
    ).toThrow(TypeError);
  });

  it("fetches a member balance from the authenticated Game API", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ guildId: "guild 1", userId: "user 1", points: 42 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "game-key" },
      fetcher,
    );

    await expect(client.getPointBalance("guild 1", "user 1")).resolves.toEqual({
      guildId: "guild 1",
      userId: "user 1",
      points: 42,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:3000/v1/points/balance?guildId=guild+1&userId=user+1",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer game-key" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("runs retention cleanup through the worker API", async () => {
    const result = {
      deleted: {
        auditLogs: 1,
        voiceLogs: 2,
        pointTransactions: 3,
        adminSessions: 4,
        aiConversations: 0,
        aiIdempotencyKeys: 0,
        ttsJobs: 5,
        ttsAudioFiles: 6,
      },
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "worker-key" },
      fetcher,
    );

    await expect(client.runRetentionCleanup()).resolves.toEqual(result);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/maintenance/retention");
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("sends local AI chat with guild/user scope and an idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ answer: "こんにちは。" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "game-key" },
      fetcher,
    );

    await expect(
      client.chatWithAi("guild-1", "user-1", "こんにちは", "interaction-1"),
    ).resolves.toEqual({ answer: "こんにちは。" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:3000/v1/ai/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          guildId: "guild-1",
          userId: "user-1",
          message: "こんにちは",
        }),
        headers: expect.objectContaining({
          authorization: "Bearer game-key",
          "Idempotency-Key": "interaction-1",
        }),
      }),
    );
  });

  it("submits a TTS job with an idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jobId: "42", status: "queued" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new CoreApiClient(
      { baseUrl: "http://localhost:3000", apiKey: "voice-key" },
      fetcher,
    );

    await expect(
      client.createTtsJob(
        {
          guildId: "guild-1",
          requesterId: "user-1",
          text: "読み上げ",
        },
        "interaction-1",
      ),
    ).resolves.toEqual({ jobId: "42", status: "queued" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://localhost:3000/v1/tts/jobs");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        requesterId: "user-1",
        text: "読み上げ",
      }),
    });
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "interaction-1",
    );
  });
});
