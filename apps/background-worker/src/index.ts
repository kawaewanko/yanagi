import {
  CoreApiClient,
  type ExternalSubscription,
  type RetentionCleanupResult,
} from "@yanagi/core-api-client";
import { intervalMilliseconds } from "./config.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_WORKER");
const api = new CoreApiClient({
  baseUrl: coreApiUrl,
  apiKey: coreApiKey,
  timeoutMs: 15_000,
});
const interval = intervalMilliseconds(
  process.env.BACKGROUND_WORKER_INTERVAL_MS,
);
let pollTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;
let stopped = false;
let twitchToken: { value: string; expiresAt: number } | undefined;

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/atom+xml, application/xml, application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`external_http_${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function atomEntries(
  xml: string,
): Array<{ id: string; title: string; url: string; publishedAt?: string }> {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => {
      const entry = match[1];
      const id = decodeXml(
        entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] ??
          entry.match(/<id>([^<]+)<\/id>/)?.[1] ??
          "",
      );
      const title = decodeXml(
        entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "YouTube新着動画",
      );
      const url = decodeXml(
        entry.match(/<link[^>]+href="([^"]+)"/)?.[1] ??
          `https://www.youtube.com/watch?v=${id}`,
      );
      const publishedAt = entry.match(/<published>([^<]+)<\/published>/)?.[1];
      return {
        id,
        title: title.slice(0, 500),
        url: url.slice(0, 2000),
        ...(publishedAt ? { publishedAt } : {}),
      };
    })
    .filter((entry) => entry.id && entry.url);
}

async function twitchAccessToken(): Promise<string> {
  if (twitchToken && twitchToken.expiresAt > Date.now() + 30_000)
    return twitchToken.value;
  const clientId = required("TWITCH_CLIENT_ID");
  const clientSecret = required("TWITCH_CLIENT_SECRET");
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) throw new Error(`twitch_token_http_${response.status}`);
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("twitch_token_missing");
  twitchToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return body.access_token;
}

async function pollYouTube(subscription: ExternalSubscription): Promise<
  Array<{
    externalId: string;
    title: string;
    url: string;
    publishedAt?: string;
  }>
> {
  const xml = await fetchText(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(subscription.target)}`,
  );
  return atomEntries(xml)
    .slice(0, 15)
    .map((entry) => ({ externalId: `youtube:${entry.id}`, ...entry }));
}

async function pollTwitch(subscription: ExternalSubscription): Promise<
  Array<{
    externalId: string;
    title: string;
    url: string;
    publishedAt?: string;
  }>
> {
  const clientId = required("TWITCH_CLIENT_ID");
  const token = await twitchAccessToken();
  const response = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(subscription.target)}`,
    { headers: { "Client-Id": clientId, Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`twitch_stream_http_${response.status}`);
  const body = (await response.json()) as {
    data?: Array<{
      id: string;
      user_name: string;
      title: string;
      started_at: string;
    }>;
  };
  const stream = body.data?.[0];
  if (!stream) return [];
  return [
    {
      externalId: `twitch:${stream.id}`,
      title: `🔴 ${stream.user_name} が配信開始: ${stream.title}`.slice(0, 500),
      url: `https://www.twitch.tv/${encodeURIComponent(subscription.target)}`,
      publishedAt: stream.started_at,
    },
  ];
}

async function pollSubscription(
  subscription: ExternalSubscription,
): Promise<void> {
  const events =
    subscription.kind === "youtube"
      ? await pollYouTube(subscription)
      : await pollTwitch(subscription);
  for (const event of events)
    await api.recordExternalEvent({
      subscriptionId: subscription.id,
      externalId: event.externalId,
      title: event.title,
      url: event.url,
      publishedAt: event.publishedAt,
      payload: { provider: subscription.kind, target: subscription.target },
    });
  await api.completeExternalPoll(subscription.id, true);
}

async function runExternalPolling(): Promise<void> {
  const subscriptions = await api.claimExternalSubscriptions(20);
  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await pollSubscription(subscription);
        console.info(
          JSON.stringify({
            event: "external-notification-poll-completed",
            subscriptionId: subscription.id,
            kind: subscription.kind,
          }),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await api
          .completeExternalPoll(subscription.id, false, message)
          .catch(() => undefined);
        console.error(
          JSON.stringify({
            event: "external-notification-poll-failed",
            subscriptionId: subscription.id,
            message,
          }),
        );
      }
    }),
  );
}

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: "worker" }),
  });
}

async function runPollingCycle(): Promise<void> {
  try {
    await runExternalPolling();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(
      JSON.stringify({ event: "external-poll-cycle-failed", message }),
    );
  } finally {
    if (!stopped) pollTimer = setTimeout(() => void runPollingCycle(), 60_000);
  }
}

async function runRetentionCycle(): Promise<void> {
  let failed = false;
  try {
    const result: RetentionCleanupResult = await api.runRetentionCleanup();
    console.info(
      JSON.stringify({
        event: "retention-cleanup-completed",
        deleted: result.deleted,
        completedAt: result.completedAt,
      }),
    );
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(
      JSON.stringify({ event: "retention-cleanup-failed", message }),
    );
  } finally {
    if (!stopped)
      retentionTimer = setTimeout(
        () => void runRetentionCycle(),
        failed ? 60_000 : interval,
      );
  }
}

void runPollingCycle();
void runRetentionCycle();
void sendHeartbeat().catch(() => undefined);
const heartbeat = setInterval(
  () => void sendHeartbeat().catch(() => undefined),
  30_000,
);
heartbeat.unref();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (retentionTimer) clearTimeout(retentionTimer);
    clearInterval(heartbeat);
  });
}
