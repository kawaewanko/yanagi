export type VoiceEvent = {
  guildId: string;
  userId: string;
  channelId: string | null;
  action: "join" | "leave" | "move";
  eventId: string;
};

export type AuditEvent = {
  guildId: string;
  actorId: string | null;
  action: string;
  eventId: string;
  details: Record<string, unknown>;
};

export type MessagePointEvent = {
  guildId: string;
  userId: string;
  messageId: string;
};

export type VoicePointEvent = {
  guildId: string;
  userId: string;
  tickId: string;
};

export type PointBalance = {
  guildId: string;
  userId: string;
  points: number;
};

export type PointLeaderboardEntry = {
  rank: number;
  userId: string;
  points: number;
};

export type FortuneResult = {
  result: string;
  points: number;
};

export type Reward = {
  id: string;
  name: string;
  description: string;
  cost: number;
};

export type RewardRedemption = {
  redemptionId: string;
  cost: number;
};

export type Raffle = {
  raffleId: string;
  title: string;
  prize: Record<string, unknown>;
  entryCost: number;
  status: "draft" | "open" | "closed" | "drawn";
  startsAt: string | null;
  endsAt: string | null;
  createdBy: string;
  createdAt?: string;
  eligibility?: { minPoints?: number; roleIds?: string[] };
};

export type VoiceRecruitment = {
  recruitmentId: string;
  guildId: string;
  postChannelId: string;
  messageId: string;
  voiceChannelId: string;
  creatorId: string;
  title: string;
  activity: string;
  maxParticipants: number;
  expiresAt: string;
  status: "open" | "closed" | "expired";
  participantIds: string[];
};

export type RaffleResult = {
  raffleId: string;
  resultId: string;
  winnerId: string;
  prize: Record<string, unknown>;
  redrawn: boolean;
};

export type RaffleHistoryResult = {
  resultId: string;
  drawNumber: number;
  userId: string;
  prize: Record<string, unknown>;
  redrawnFrom: string | null;
  createdAt: string;
};

export type RetentionCleanupResult = {
  deleted: {
    auditLogs: number;
    voiceLogs: number;
    pointTransactions: number;
    adminSessions: number;
    temporaryVoiceChannels: number;
    aiConversations: number;
    aiIdempotencyKeys: number;
    ttsJobs: number;
    ttsAudioFiles: number;
  };
  completedAt: string;
};

export type AiChatResponse = {
  answer: string;
};

export type TtsJobStatus = "queued" | "processing" | "succeeded" | "failed";

export type TtsJob = {
  jobId: string;
  guildId: string;
  requesterId: string;
  text: string;
  attempts: number;
};

export type TtsJobState = {
  jobId: string;
  status: TtsJobStatus;
  errorCode: string | null;
};

export type TemporaryVoiceChannel = {
  channelId: string;
  ownerId: string;
  createdAt: string;
  deleteAfter: string | null;
};

export type CommunityGuildSettings = {
  guildId: string;
  welcomeChannelId: string | null;
  waitingVoiceChannelId: string | null;
  temporaryVoiceCategoryId: string | null;
};
export type ExternalSubscription = {
  id: string;
  guild_id: string;
  kind: "youtube" | "twitch";
  target: string;
  channel_id: string;
  config: Record<string, unknown>;
  secret_ref: string | null;
};

export class CoreApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CoreApiError";
  }
}

export type CoreApiClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
};

export class CoreApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: CoreApiClientOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new TypeError("Core API URL must use HTTP or HTTPS");
    }
    if (!options.apiKey.trim())
      throw new TypeError("Core API key must not be empty");
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 30_000
    ) {
      throw new RangeError(
        "Core API timeout must be between 1 and 30000 milliseconds",
      );
    }
  }

  recordVoiceEvent(
    event: VoiceEvent,
  ): Promise<{ recorded: true; eventId: string }> {
    return this.post("/v1/community/voice-events", event, event.eventId);
  }

  startVoiceSession(input: {
    guildId: string;
    userId: string;
    channelId: string;
    startedAt?: string;
  }): Promise<{ started: true }> {
    return this.post("/v1/voice/sessions/start", input);
  }

  stopVoiceSession(input: {
    guildId: string;
    userId: string;
    endedAt?: string;
  }): Promise<{ stopped: boolean; durationSeconds: number }> {
    return this.post("/v1/voice/sessions/stop", input);
  }

  async getVoiceLeaderboard(
    guildId: string,
    limit = 10,
  ): Promise<Array<{ rank: number; userId: string; durationSeconds: number }>> {
    const response = await this.request(
      `/v1/voice/sessions/leaderboard?guildId=${encodeURIComponent(guildId)}&limit=${limit}`,
    );
    const body = (await response.json()) as {
      items?: Array<{ rank: number; userId: string; durationSeconds: number }>;
    };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  recordAuditEvent(
    event: AuditEvent,
  ): Promise<{ recorded: true; eventId: string }> {
    return this.post("/v1/community/audit-events", event, event.eventId);
  }

  async getCommunityGuildSettings(
    guildId: string,
  ): Promise<CommunityGuildSettings> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(
      `/v1/community/guild-settings?${query.toString()}`,
    );
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    }
    const record = body as Record<string, unknown>;
    const isChannelId = (value: unknown): value is string | null =>
      value === null || (typeof value === "string" && /^\d{1,32}$/.test(value));
    if (
      record.guildId !== guildId ||
      !isChannelId(record.welcomeChannelId) ||
      !isChannelId(record.waitingVoiceChannelId) ||
      !isChannelId(record.temporaryVoiceCategoryId)
    ) {
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    }
    return {
      guildId,
      welcomeChannelId: record.welcomeChannelId,
      waitingVoiceChannelId: record.waitingVoiceChannelId,
      temporaryVoiceCategoryId: record.temporaryVoiceCategoryId,
    };
  }

  registerTemporaryVoiceChannel(
    guildId: string,
    channelId: string,
    ownerId: string,
  ): Promise<{
    registered: true;
    channelId: string;
    ownerId: string;
    deleteAfter: null;
  }> {
    return this.post(
      "/v1/community/temporary-voice-channels",
      { guildId, channelId, ownerId },
      channelId,
    );
  }

  async listTemporaryVoiceChannels(
    guildId: string,
  ): Promise<TemporaryVoiceChannel[]> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(
      `/v1/community/temporary-voice-channels?${query.toString()}`,
    );
    const body = (await response.json()) as {
      channels?: TemporaryVoiceChannel[];
    };
    if (!Array.isArray(body.channels)) {
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    }
    return body.channels;
  }

  markTemporaryVoiceChannelEmpty(
    guildId: string,
    channelId: string,
  ): Promise<{ deleteAfter: string }> {
    return this.post(
      `/v1/community/temporary-voice-channels/${encodeURIComponent(channelId)}/empty`,
      { guildId },
    );
  }

  markTemporaryVoiceChannelActive(
    guildId: string,
    channelId: string,
  ): Promise<{ active: true; channelId: string }> {
    return this.post(
      `/v1/community/temporary-voice-channels/${encodeURIComponent(channelId)}/active`,
      { guildId },
    );
  }

  async removeTemporaryVoiceChannel(
    guildId: string,
    channelId: string,
  ): Promise<void> {
    const query = new URLSearchParams({ guildId });
    await this.request(
      `/v1/community/temporary-voice-channels/${encodeURIComponent(channelId)}?${query.toString()}`,
      { method: "DELETE" },
    );
  }

  awardMessagePoint(
    event: MessagePointEvent,
  ): Promise<{ awarded: boolean; points: number }> {
    return this.post("/v1/points/message", event, event.messageId);
  }

  awardVoicePoint(
    event: VoicePointEvent,
  ): Promise<{ awarded: boolean; points: number }> {
    return this.post("/v1/points/voice-tick", event, event.tickId);
  }

  async getPointBalance(
    guildId: string,
    userId: string,
  ): Promise<PointBalance> {
    const query = new URLSearchParams({ guildId, userId });
    const response = await this.request(
      `/v1/points/balance?${query.toString()}`,
    );
    return response.json() as Promise<PointBalance>;
  }

  claimDaily(guildId: string, userId: string): Promise<{ awarded: number }> {
    return this.post("/v1/points/daily", { guildId, userId });
  }

  workForPoints(guildId: string, userId: string): Promise<{ awarded: number }> {
    return this.post("/v1/points/work", { guildId, userId });
  }

  commitCrime(
    guildId: string,
    userId: string,
  ): Promise<{ success: boolean; awarded: number }> {
    return this.post("/v1/points/crime", { guildId, userId });
  }

  async getPointLeaderboard(
    guildId: string,
    limit = 10,
  ): Promise<PointLeaderboardEntry[]> {
    const query = new URLSearchParams({ guildId, limit: String(limit) });
    const response = await this.request(
      `/v1/points/leaderboard?${query.toString()}`,
    );
    const body = (await response.json()) as { items?: PointLeaderboardEntry[] };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  async getPointHistory(
    guildId: string,
    userId: string,
    limit = 20,
  ): Promise<Array<{ amount: number; reason: string; createdAt: string }>> {
    const query = new URLSearchParams({
      guildId,
      userId,
      limit: String(limit),
    });
    const response = await this.request(
      `/v1/points/history?${query.toString()}`,
    );
    const body = (await response.json()) as {
      items?: Array<{ amount: number; reason: string; createdAt: string }>;
    };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  transferPoints(
    guildId: string,
    fromUserId: string,
    toUserId: string,
    amount: number,
  ): Promise<{ transferred: number }> {
    return this.post("/v1/points/transfer", {
      guildId,
      fromUserId,
      toUserId,
      amount,
    });
  }

  async getPeriodLeaderboard(
    guildId: string,
    period: "week" | "month",
    limit = 10,
  ): Promise<PointLeaderboardEntry[]> {
    const query = new URLSearchParams({
      guildId,
      period,
      limit: String(limit),
    });
    const response = await this.request(
      `/v1/points/period-leaderboard?${query.toString()}`,
    );
    const body = (await response.json()) as { items?: PointLeaderboardEntry[] };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  async getAchievements(
    guildId: string,
    userId: string,
  ): Promise<
    Array<{
      key: string;
      name: string;
      description: string;
      badge: string;
      earnedAt: string | null;
    }>
  > {
    const query = new URLSearchParams({ guildId, userId });
    const response = await this.request(`/v1/achievements?${query.toString()}`);
    const body = (await response.json()) as {
      items?: Array<{
        key: string;
        name: string;
        description: string;
        badge: string;
        earnedAt: string | null;
      }>;
    };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  drawFortune(
    guildId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<FortuneResult> {
    return this.post("/v1/fortune/draw", { guildId, userId }, idempotencyKey);
  }

  chatWithAi(
    guildId: string,
    userId: string,
    message: string,
    idempotencyKey: string,
  ): Promise<AiChatResponse> {
    return this.post(
      "/v1/ai/chat",
      { guildId, userId, message },
      idempotencyKey,
    );
  }

  submitAiFeedback(input: {
    guildId: string;
    userId: string;
    interactionId: string;
    rating: number;
    comment?: string;
  }): Promise<{ saved: boolean }> {
    return this.post("/v1/ai/feedback", input);
  }

  getAiFeedbackSummary(
    guildId: string,
  ): Promise<{ count: number; average: number | null }> {
    return this.request(
      `/v1/ai/feedback/summary?guildId=${encodeURIComponent(guildId)}`,
    ).then(
      async (response) =>
        response.json() as Promise<{ count: number; average: number | null }>,
    );
  }

  async listRewards(guildId: string): Promise<Reward[]> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(`/v1/rewards?${query.toString()}`);
    const body = (await response.json()) as { rewards?: Reward[] };
    if (!Array.isArray(body.rewards))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.rewards;
  }

  redeemReward(
    rewardId: string,
    guildId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<RewardRedemption> {
    return this.post(
      `/v1/rewards/${encodeURIComponent(rewardId)}/redeem`,
      { guildId, userId },
      idempotencyKey,
    );
  }

  createRaffle(
    input: {
      guildId: string;
      createdBy: string;
      title: string;
      prize: Record<string, unknown>;
      entryCost: number;
      eligibility?: { minPoints?: number; roleIds?: string[] };
    },
    idempotencyKey: string,
  ): Promise<{
    raffleId: string;
    status: "draft";
    title: string;
    prize: Record<string, unknown>;
    entryCost: number;
  }> {
    return this.post("/v1/raffles", input, idempotencyKey);
  }

  updateRafflePrize(
    raffleId: string,
    input: { guildId: string; actorId: string; prize: Record<string, unknown> },
    idempotencyKey: string,
  ): Promise<{ raffleId: string; prize: Record<string, unknown> }> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/prize`,
      input,
      idempotencyKey,
    );
  }

  async listRaffles(guildId: string): Promise<Raffle[]> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(`/v1/raffles?${query.toString()}`);
    const body = (await response.json()) as { raffles?: Raffle[] };
    if (!Array.isArray(body.raffles))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.raffles;
  }

  startRaffle(
    raffleId: string,
    input: { guildId: string; actorId: string; durationMinutes?: number },
    idempotencyKey: string,
  ): Promise<{
    raffleId: string;
    status: "open";
    startsAt: string;
    endsAt: string | null;
  }> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/start`,
      input,
      idempotencyKey,
    );
  }

  enterRaffle(
    raffleId: string,
    guildId: string,
    userId: string,
    idempotencyKey: string,
    roleIds: string[] = [],
  ): Promise<{ raffleId: string; entered: true; entryCount: 1; cost: number }> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/entries`,
      { guildId, userId, roleIds },
      idempotencyKey,
    );
  }

  closeRaffle(
    raffleId: string,
    guildId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<{ raffleId: string; status: "closed" }> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/close`,
      { guildId, actorId },
      idempotencyKey,
    );
  }

  drawRaffle(
    raffleId: string,
    guildId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<RaffleResult> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/draw`,
      { guildId, actorId },
      idempotencyKey,
    );
  }

  redrawRaffle(
    raffleId: string,
    guildId: string,
    actorId: string,
    idempotencyKey: string,
  ): Promise<RaffleResult> {
    return this.post(
      `/v1/raffles/${encodeURIComponent(raffleId)}/redraw`,
      { guildId, actorId },
      idempotencyKey,
    );
  }

  async getRaffleHistory(
    raffleId: string,
    guildId: string,
  ): Promise<{
    raffle: Raffle;
    entries: Array<{ userId: string; entryCount: number; createdAt: string }>;
    results: RaffleHistoryResult[];
  }> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(
      `/v1/raffles/${encodeURIComponent(raffleId)}/history?${query.toString()}`,
    );
    return response.json() as Promise<{
      raffle: Raffle;
      entries: Array<{ userId: string; entryCount: number; createdAt: string }>;
      results: RaffleHistoryResult[];
    }>;
  }

  createVoiceRecruitment(input: {
    guildId: string;
    postChannelId: string;
    messageId: string;
    voiceChannelId: string;
    creatorId: string;
    title: string;
    activity: string;
    maxParticipants: number;
    expiresAt: string;
  }): Promise<VoiceRecruitment> {
    return this.post("/v1/community/vc-recruitments", input, input.messageId);
  }

  async listVoiceRecruitments(guildId: string): Promise<VoiceRecruitment[]> {
    const query = new URLSearchParams({ guildId });
    const response = await this.request(
      `/v1/community/vc-recruitments?${query.toString()}`,
    );
    const body = (await response.json()) as {
      recruitments?: VoiceRecruitment[];
    };
    if (!Array.isArray(body.recruitments))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.recruitments;
  }

  updateVoiceRecruitmentParticipant(
    recruitmentId: string,
    input: { guildId: string; userId: string; action: "join" | "leave" },
  ): Promise<VoiceRecruitment> {
    return this.post(
      `/v1/community/vc-recruitments/${encodeURIComponent(recruitmentId)}/participants`,
      input,
    );
  }

  closeVoiceRecruitment(
    recruitmentId: string,
    guildId: string,
  ): Promise<{ status: "closed" }> {
    return this.post(
      `/v1/community/vc-recruitments/${encodeURIComponent(recruitmentId)}/close`,
      { guildId },
    );
  }

  runRetentionCleanup(): Promise<RetentionCleanupResult> {
    return this.post("/v1/maintenance/retention", {});
  }

  async claimExternalSubscriptions(
    limit = 20,
  ): Promise<ExternalSubscription[]> {
    const response = await this.request(
      "/v1/notifications/external-poll/claim",
      { method: "POST", body: JSON.stringify({ limit }) },
    );
    const body = (await response.json()) as { items?: ExternalSubscription[] };
    if (!Array.isArray(body.items))
      throw new CoreApiError(
        "Invalid response from Core API",
        response.status,
        "invalid_response",
      );
    return body.items;
  }

  recordExternalEvent(input: {
    subscriptionId: string;
    externalId: string;
    title: string;
    url: string;
    payload?: Record<string, unknown>;
    publishedAt?: string;
  }): Promise<{
    inserted: boolean;
    duplicate?: boolean;
    outboxId?: string | null;
  }> {
    return this.post("/v1/notifications/external-events", input);
  }

  completeExternalPoll(
    subscriptionId: string,
    success: boolean,
    error?: string,
  ): Promise<{ completed: true }> {
    return this.post("/v1/notifications/external-poll/complete", {
      subscriptionId,
      success,
      error,
    });
  }

  createTtsJob(
    input: { guildId: string; requesterId: string; text: string },
    idempotencyKey: string,
  ): Promise<{ jobId: string; status: "queued" }> {
    return this.post("/v1/tts/jobs", input, idempotencyKey);
  }

  async getTtsJob(
    jobId: string,
    guildId: string,
    requesterId: string,
  ): Promise<TtsJobState> {
    const query = new URLSearchParams({ guildId, requesterId });
    const response = await this.request(
      `/v1/tts/jobs/${encodeURIComponent(jobId)}?${query.toString()}`,
    );
    return response.json() as Promise<TtsJobState>;
  }

  async getTtsAudio(
    jobId: string,
    guildId: string,
    requesterId: string,
  ): Promise<Uint8Array> {
    const query = new URLSearchParams({ guildId, requesterId });
    const response = await this.request(
      `/v1/tts/jobs/${encodeURIComponent(jobId)}/audio?${query.toString()}`,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async claimTtsJob(): Promise<TtsJob | null> {
    const response = await this.request("/v1/tts/jobs/claim", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    if (response.status === 204) return null;
    return response.json() as Promise<TtsJob>;
  }

  completeTtsJob(
    jobId: string,
  ): Promise<{ jobId: string; status: "succeeded" }> {
    return this.post(`/v1/tts/jobs/${encodeURIComponent(jobId)}/complete`, {});
  }

  failTtsJob(
    jobId: string,
    errorCode: string,
  ): Promise<{ jobId: string; status: "queued" | "failed" }> {
    return this.post(`/v1/tts/jobs/${encodeURIComponent(jobId)}/fail`, {
      errorCode,
    });
  }

  private async post<T>(
    path: string,
    payload: object,
    idempotencyKey?: string,
  ): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      ...(idempotencyKey
        ? { headers: { "Idempotency-Key": idempotencyKey } }
        : {}),
      body: JSON.stringify(payload),
    });
    return response.json() as Promise<T>;
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          authorization: `Bearer ${this.options.apiKey}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
      if (!response.ok) {
        let code = "core_api_error";
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body.error === "string") code = body.error;
        } catch {
          code = "core_api_error";
        }
        throw new CoreApiError(
          `Core API request failed with status ${response.status}`,
          response.status,
          code,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof CoreApiError) throw error;
      if (controller.signal.aborted) {
        throw new CoreApiError("Core API request timed out", 0, "timeout");
      }
      throw new CoreApiError("Core API request failed", 0, "network_error");
    } finally {
      clearTimeout(timeout);
    }
  }
}
