import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type NonThreadGuildBasedChannel,
  type Role,
  type VoiceState,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { CoreApiClient } from "@yanagi/core-api-client";
import { BotPresenceController } from "@yanagi/bot-presence";
import { auditChanges, type AuditSnapshot } from "./audit-events.js";
import { CommunityGuildSettingsCache } from "./guild-settings.js";
import {
  TemporaryVoiceManager,
  type TemporaryVoiceGuild,
} from "./temporary-voice.js";
import { voiceChange } from "./voice-events.js";
import { VoiceRecruitmentManager } from "./voice-recruitment.js";
import { CommunityForms } from "./community-forms.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token = required("COMMUNITY_BOT_TOKEN");
const welcomeChannelId = process.env.COMMUNITY_WELCOME_CHANNEL_ID?.trim();
const waitingVoiceChannelId =
  process.env.COMMUNITY_WAITING_VOICE_CHANNEL_ID?.trim();
const temporaryVoiceCategoryId =
  process.env.COMMUNITY_TEMP_VOICE_CATEGORY_ID?.trim();
let autoRoleId = process.env.COMMUNITY_AUTO_ROLE_ID?.trim() || null;
const verifyRoleId = process.env.COMMUNITY_VERIFY_ROLE_ID?.trim() || null;
const voiceLogChannelId =
  process.env.COMMUNITY_VOICE_LOG_CHANNEL_ID?.trim() || null;
const introChannelId = process.env.COMMUNITY_INTRO_CHANNEL_ID?.trim() || null;
const serverRegisterChannelId =
  process.env.COMMUNITY_SERVER_REGISTER_CHANNEL_ID?.trim() || null;
const voiceRecruitmentRoleId = process.env.VC_RECRUIT_ROLE_ID?.trim() || null;
const voiceAutoMute = process.env.COMMUNITY_VC_AUTO_MUTE === "true";
const voiceAfkChannelId =
  process.env.COMMUNITY_VC_AFK_CHANNEL_ID?.trim() || null;
const voiceAfkMinutes = Math.min(
  Math.max(Number(process.env.COMMUNITY_VC_AFK_MINUTES ?? 30) || 30, 1),
  1440,
);
const healthAlertChannelId =
  process.env.COMMUNITY_HEALTH_ALERT_CHANNEL_ID?.trim() || null;
const healthAlertMentionRoleId =
  process.env.COMMUNITY_HEALTH_ALERT_MENTION_ROLE_ID?.trim() || null;
const serviceHealth = new Map<string, boolean>();
const voiceAfkTimers = new Map<string, NodeJS.Timeout>();
let healthCheckRunning = false;
type PollState = {
  question: string;
  options: string[];
  votes: Map<string, number>;
};
const polls = new Map<string, PollState>();
type SuggestionState = {
  text: string;
  authorId: string;
  up: Set<string>;
  down: Set<string>;
};
const suggestions = new Map<string, SuggestionState>();
const roleMenus = new Map<string, string>();
const temporaryRoleTimers = new Map<string, ReturnType<typeof setTimeout>>();
type ReminderState = {
  id: string;
  userId: string;
  channelId: string;
  message: string;
  expiresAt: number;
  repeatMinutes: number | null;
  timer: ReturnType<typeof setTimeout>;
};
const reminders = new Map<string, ReminderState>();
type ScheduledNotification = {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  message: string;
  runAt: number;
  intervalMinutes: number | null;
  timer: ReturnType<typeof setTimeout>;
};
const scheduledNotifications = new Map<string, ScheduledNotification>();
const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_COMMUNITY");
const api = new CoreApiClient({ baseUrl: coreApiUrl, apiKey: coreApiKey });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const presence = new BotPresenceController({
  getPing: () => client.ws.ping,
  activityLabel: "RSS・Webhook・管理",
  setPresence: ({ activity, status }) => {
    client.user?.setPresence({
      activities: [{ name: activity.name, type: ActivityType.Watching }],
      status,
    });
  },
  reportUpdateError: (error) =>
    console.error("[presence-update] Failed to update Discord presence", error),
});
const guildSettings = new CommunityGuildSettingsCache(
  api,
  {
    welcomeChannelId: welcomeChannelId || null,
    waitingVoiceChannelId: waitingVoiceChannelId || null,
    temporaryVoiceCategoryId: temporaryVoiceCategoryId || null,
  },
  reportEventError,
);
const temporaryVoiceManager = new TemporaryVoiceManager(api, reportEventError);
const voiceRecruitment = new VoiceRecruitmentManager({
  roleId: voiceRecruitmentRoleId,
  api,
});
const communityForms = new CommunityForms({
  introChannelId,
  serverRegisterChannelId,
});

function reportEventError(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportError();
}

function reportDiscordIncident(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportIncident();
}

async function dashboardFetch(path: string): Promise<any> {
  const response = await fetch(`${coreApiUrl}${path}`, {
    headers: { authorization: `Bearer ${coreApiKey}` },
  });
  if (!response.ok) throw new Error(`dashboard_api_${response.status}`);
  return response.json();
}

async function dashboardPost(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${coreApiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`dashboard_api_${response.status}`);
}

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: "community" }),
  });
}

async function communityPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${coreApiUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`community_api_${response.status}`);
  return response.json() as Promise<T>;
}

async function communityGet<T>(path: string): Promise<T> {
  const response = await fetch(`${coreApiUrl}${path}`, {
    headers: { authorization: `Bearer ${coreApiKey}` },
  });
  if (!response.ok) throw new Error(`community_api_${response.status}`);
  return response.json() as Promise<T>;
}

async function deliverNotificationOutbox(): Promise<void> {
  const claimed = await communityPost<
    Array<{
      id: string;
      channel_id: string;
      payload: { message?: string; content?: string };
    }>
  >("/v1/notifications/outbox/claim", { limit: 20 });
  const items = Array.isArray(claimed)
    ? claimed
    : ((
        claimed as unknown as {
          items?: Array<{
            id: string;
            channel_id: string;
            payload: { message?: string; content?: string };
          }>;
        }
      ).items ?? []);
  for (const item of items) {
    let delivered = false;
    let errorMessage = "unknown";
    try {
      const channel = await client.channels.fetch(item.channel_id);
      const content =
        item.payload?.content ?? item.payload?.message ?? "通知があります。";
      if (!channel?.isTextBased() || !channel.isSendable())
        throw new Error("channel_not_sendable");
      await channel.send({
        content: `🔔 ${content}`,
        allowedMentions: { parse: [] },
      });
      delivered = true;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : "delivery_failed";
      reportEventError("notification-outbox-delivery", error);
    }
    await communityPost(
      `/v1/notifications/outbox/${encodeURIComponent(item.id)}/complete`,
      { delivered, error: errorMessage },
    );
  }
}

async function communityDelete(path: string): Promise<void> {
  const response = await fetch(`${coreApiUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${coreApiKey}` },
  });
  if (!response.ok) throw new Error(`community_api_${response.status}`);
}

function schedulePersistentNotification(
  notification: Omit<ScheduledNotification, "timer">,
): void {
  const previous = scheduledNotifications.get(notification.id);
  if (previous) clearTimeout(previous.timer);
  const deliver = () => {
    void (async () => {
      try {
        const channel = await client.channels.fetch(notification.channelId);
        if (channel?.isTextBased() && channel.isSendable())
          await channel.send({
            content: `📢 ${notification.message}`,
            allowedMentions: { parse: [] },
          });
        const nextRunAt = notification.intervalMinutes
          ? new Date(
              Date.now() + notification.intervalMinutes * 60_000,
            ).toISOString()
          : undefined;
        await communityPost(
          `/v1/community/scheduled-notifications/${notification.id}/complete`,
          nextRunAt ? { nextRunAt } : {},
        );
        if (nextRunAt)
          schedulePersistentNotification({
            ...notification,
            runAt: new Date(nextRunAt).getTime(),
          });
        else scheduledNotifications.delete(notification.id);
      } catch (error) {
        reportEventError("scheduled-notification-delivery", error);
      }
    })();
  };
  const timer = setTimeout(
    deliver,
    Math.max(0, notification.runAt - Date.now()),
  );
  timer.unref?.();
  scheduledNotifications.set(notification.id, { ...notification, timer });
}

function parseRssItems(xml: string): Array<{
  externalId: string;
  title: string;
  link: string;
  publishedAt?: string;
}> {
  const items: Array<{
    externalId: string;
    title: string;
    link: string;
    publishedAt?: string;
  }> = [];
  for (const match of xml.matchAll(/<(item|entry)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const body = match[2];
    const value = (tag: string) =>
      body
        .match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, "")
        .trim() ?? "";
    const title = value("title").slice(0, 500);
    const link =
      value("link") ||
      body.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ||
      "";
    const externalId = value("guid") || value("id") || link;
    const publishedAt =
      value("pubDate") || value("published") || value("updated") || undefined;
    if (title && link && externalId)
      items.push({
        externalId: externalId.slice(0, 1000),
        title,
        link,
        publishedAt,
      });
  }
  return items.slice(0, 20);
}

async function pollRssFeeds(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const result = await communityGet<{
      items: Array<{
        id: string;
        url: string;
        display_name: string;
        announcement_channel_id: string;
        next_poll_at: string;
      }>;
    }>(`/v1/community/rss-feeds?guildId=${guild.id}`);
    for (const feed of result.items) {
      if (
        feed.next_poll_at &&
        new Date(feed.next_poll_at).getTime() > Date.now()
      )
        continue;
      try {
        const response = await fetch(feed.url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "user-agent": "YanagiBot RSS reader/1.0" },
        });
        if (!response.ok) throw new Error(`rss_http_${response.status}`);
        const xml = await response.text();
        const channel = await client.channels.fetch(
          feed.announcement_channel_id,
        );
        for (const item of parseRssItems(xml)) {
          const saved = await communityPost<{
            inserted: boolean;
            item: { id: string; title: string; link: string } | null;
          }>(`/v1/community/rss-feeds/${feed.id}/items`, item);
          if (
            !saved.inserted ||
            !saved.item ||
            !channel?.isTextBased() ||
            !channel.isSendable()
          )
            continue;
          await channel.send({
            content: `📰 **${feed.display_name}**\n${saved.item.title}\n${saved.item.link}`,
            allowedMentions: { parse: [] },
          });
          await communityPost(
            `/v1/community/rss-items/${saved.item.id}/announced`,
            {},
          );
        }
        await communityPost(`/v1/community/rss-feeds/${feed.id}/polled`, {});
      } catch (error) {
        reportEventError(`rss-poll:${feed.id}`, error);
      }
    }
  }
}

async function restoreScheduledNotifications(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const result = await communityGet<{
      items: Array<{
        id: string;
        channelId: string;
        message: string;
        runAt: string;
        recurrence?: { intervalMinutes?: number };
        createdBy: string;
      }>;
    }>(`/v1/community/scheduled-notifications?guildId=${guild.id}`);
    for (const item of result.items)
      schedulePersistentNotification({
        id: item.id,
        guildId: guild.id,
        userId: item.createdBy,
        channelId: item.channelId,
        message: item.message,
        runAt: new Date(item.runAt).getTime(),
        intervalMinutes: item.recurrence?.intervalMinutes ?? null,
      });
  }
}

async function deliverBirthdays(): Promise<void> {
  const result = await communityGet<{
    items: Array<{
      guildId: string;
      userId: string;
      channelId: string | null;
      month: number;
      day: number;
    }>;
  }>("/v1/community/birthdays/due");
  for (const birthday of result.items) {
    if (!birthday.channelId) continue;
    const channel = await client.channels.fetch(birthday.channelId);
    if (channel?.isTextBased() && channel.isSendable()) {
      await channel.send({
        content: `🎂 <@${birthday.userId}> お誕生日おめでとうございます！`,
        allowedMentions: { users: [birthday.userId] },
      });
      await communityPost("/v1/community/birthdays/announce", {
        guildId: birthday.guildId,
        userId: birthday.userId,
      });
    }
  }
}

function scheduleTemporaryRole(
  guildId: string,
  userId: string,
  roleId: string,
  expiresAt: number,
): void {
  const timerKey = `${guildId}:${userId}:${roleId}`;
  const oldTimer = temporaryRoleTimers.get(timerKey);
  if (oldTimer) clearTimeout(oldTimer);
  const delay = Math.max(0, expiresAt - Date.now());
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId);
        await member.roles.remove(roleId, "期限付きロールの期限切れ");
        await fetch(
          `${coreApiUrl}/v1/community/temporary-roles?guildId=${guildId}&userId=${userId}&roleId=${roleId}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${coreApiKey}` },
          },
        );
      } catch (error) {
        reportEventError("temporary-role-expiry", error);
      }
      temporaryRoleTimers.delete(timerKey);
    })();
  }, delay);
  timer.unref?.();
  temporaryRoleTimers.set(timerKey, timer);
}

async function restoreTemporaryRoles(): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    const result = await communityGet<{
      items: Array<{ user_id: string; role_id: string; expires_at: string }>;
    }>(`/v1/community/temporary-roles?guildId=${guild.id}`);
    for (const item of result.items)
      scheduleTemporaryRole(
        guild.id,
        item.user_id,
        item.role_id,
        new Date(item.expires_at).getTime(),
      );
  }
}

async function checkServiceHealth(): Promise<void> {
  if (!healthAlertChannelId || healthCheckRunning) return;
  healthCheckRunning = true;
  try {
    const channel = await client.channels.fetch(healthAlertChannelId);
    if (!channel?.isTextBased() || !channel.isSendable())
      throw new Error("Health alert channel is not sendable");
    const result = (await dashboardFetch("/v1/dashboard/status")) as {
      bots: Array<{ service: string; online: boolean }>;
    };
    const controls = await communityGet<{
      items: Array<{
        service: string;
        acknowledged_at: string | null;
        silenced_until: string | null;
      }>;
    }>("/v1/health/controls");
    const controlMap = new Map(
      controls.items.map((item) => [item.service, item]),
    );
    for (const bot of result.bots) {
      const previous = serviceHealth.get(bot.service);
      serviceHealth.set(bot.service, bot.online);
      if (previous === undefined || previous === bot.online) continue;
      void dashboardPost("/v1/dashboard/health-events", {
        service: bot.service,
        status: bot.online ? "online" : "offline",
      }).catch((error: unknown) =>
        console.error(
          `[health-event] ${error instanceof Error ? error.message : "Unknown error"}`,
        ),
      );
      const control = controlMap.get(bot.service) ?? controlMap.get("*");
      if (
        !bot.online &&
        control?.silenced_until &&
        new Date(control.silenced_until).getTime() > Date.now()
      )
        continue;
      await channel.send(
        bot.online
          ? `✅ **${bot.service}** が復旧しました。`
          : `${healthAlertMentionRoleId ? `<@&${healthAlertMentionRoleId}> ` : ""}🚨 **${bot.service}** が停止したか、90秒以上応答していません。`,
      );
    }
  } catch (error) {
    console.error(
      `[service-health-monitor] ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  } finally {
    healthCheckRunning = false;
  }
}

function pollContent(poll: PollState): string {
  return [
    `📊 **${poll.question}**`,
    "",
    ...poll.options.map((option, index) => {
      const count = [...poll.votes.values()].filter(
        (vote) => vote === index,
      ).length;
      return `${index + 1}. ${option} — **${count}票**`;
    }),
  ].join("\n");
}

function pollButtons(
  pollId: string,
  poll: PollState,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...poll.options.map((option, index) =>
      new ButtonBuilder()
        .setCustomId(`yanagi-poll:${pollId}:${index}`)
        .setLabel(`${index + 1}. ${option}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary),
    ),
  );
}

function scheduleReminder(
  userId: string,
  channelId: string,
  delayMinutes: number,
  message: string,
  repeatMinutes: number | null = null,
): ReminderState {
  const id = randomUUID().replaceAll("-", "").slice(0, 8);
  const expiresAt = Date.now() + delayMinutes * 60_000;
  let timer: ReturnType<typeof setTimeout>;
  const deliver = () => {
    void (async () => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased() && channel.isSendable()) {
          await channel.send({
            content: `⏰ <@${userId}> リマインダー: ${message}`,
            allowedMentions: { users: [userId] },
          });
        }
      } catch (error) {
        reportEventError("reminder-delivery", error);
      } finally {
        const current = reminders.get(id);
        if (current?.repeatMinutes) {
          current.expiresAt = Date.now() + current.repeatMinutes * 60_000;
          current.timer = setTimeout(deliver, current.repeatMinutes * 60_000);
          current.timer.unref?.();
        } else {
          reminders.delete(id);
        }
      }
    })();
  };
  timer = setTimeout(deliver, delayMinutes * 60_000);
  timer.unref?.();
  const reminder = {
    id,
    userId,
    channelId,
    message,
    expiresAt,
    repeatMinutes,
    timer,
  };
  reminders.set(id, reminder);
  return reminder;
}

function temporaryVoiceGuild(
  guild: Guild,
  categoryId: string | null,
): TemporaryVoiceGuild {
  return {
    id: guild.id,
    async getMemberVoiceChannelId(userId) {
      const member = await guild.members.fetch(userId);
      return member.voice.channelId;
    },
    async createTemporaryVoiceChannel(ownerId) {
      const member = await guild.members.fetch(ownerId);
      const channel = await guild.channels.create({
        name: `${member.displayName.slice(0, 80)}の一時VC`,
        type: ChannelType.GuildVoice,
        ...(categoryId ? { parent: categoryId } : {}),
      });
      return { id: channel.id, memberCount: channel.members.size };
    },
    async moveMember(userId, channelId) {
      const member = await guild.members.fetch(userId);
      await member.voice.setChannel(channelId);
    },
    async fetchTemporaryVoiceChannel(channelId) {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || channel.type !== ChannelType.GuildVoice) return null;
      return { id: channel.id, memberCount: channel.members.size };
    },
    async deleteTemporaryVoiceChannel(channelId) {
      const channel = await guild.channels.fetch(channelId);
      if (channel?.type === ChannelType.GuildVoice) {
        await channel.delete("夜凪鯖の一時VCを整理");
      }
    },
  };
}

async function sendWelcome(
  member: GuildMember,
  channelId: string | null,
): Promise<void> {
  if (!channelId) return;
  const channel = await member.guild.channels.fetch(channelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    throw new Error(
      "Configured welcome channel is missing or cannot receive messages",
    );
  }
  await channel.send({
    content: `ようこそ、${member} さん！夜凪鯖へようこそ。`,
    allowedMentions: { users: [member.id] },
  });
}

async function assignAutoRole(member: GuildMember): Promise<void> {
  if (!autoRoleId) return;
  const role = await member.guild.roles.fetch(autoRoleId);
  if (!role)
    throw new Error(`Configured auto role ${autoRoleId} was not found`);
  if (!member.roles.cache.has(role.id))
    await member.roles.add(role, "夜凪鯖の参加時自動ロール付与");
}

async function sendVoiceLog(
  guild: Guild,
  userId: string,
  action: string,
  channelId: string | null,
): Promise<void> {
  if (!voiceLogChannelId) return;
  const channel = await guild.channels.fetch(voiceLogChannelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    throw new Error(
      "Configured VC log channel is missing or cannot receive messages",
    );
  }
  const label =
    action === "join" ? "参加" : action === "leave" ? "退出" : "移動";
  const target = channelId ? `<#${channelId}>` : "不明なVC";
  await channel.send({
    content: `🔊 <@${userId}> がVCを${label}しました: ${target}`,
    allowedMentions: { users: [], roles: [], parse: [] },
  });
}

function messageContent(message: { content?: string | null }): string | null {
  const content = message.content?.trim();
  return content ? content.slice(0, 1900) : null;
}

function channelAuditSnapshot(
  channel: NonThreadGuildBasedChannel,
): AuditSnapshot {
  const snapshot: AuditSnapshot = {
    channelId: channel.id,
    channelName: channel.name,
    channelType: channel.type,
    parentId: channel.parentId,
  };
  if ("topic" in channel) snapshot.topic = channel.topic;
  if ("bitrate" in channel) snapshot.bitrate = channel.bitrate;
  if ("userLimit" in channel) snapshot.userLimit = channel.userLimit;
  if ("rtcRegion" in channel) snapshot.rtcRegion = channel.rtcRegion;
  if ("rateLimitPerUser" in channel)
    snapshot.rateLimitPerUser = channel.rateLimitPerUser;
  if ("nsfw" in channel) snapshot.nsfw = channel.nsfw;
  return snapshot;
}

function roleAuditSnapshot(role: Role): AuditSnapshot {
  return {
    roleId: role.id,
    roleName: role.name,
    color: role.hexColor,
    hoist: role.hoist,
    mentionable: role.mentionable,
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
  };
}

function recordAudit(
  guildId: string,
  actorId: string | null,
  action: string,
  details: Record<string, unknown>,
): Promise<unknown> {
  return api.recordAuditEvent({
    guildId,
    actorId,
    action,
    eventId: randomUUID(),
    details,
  });
}

client.on(Events.GuildMemberAdd, (member) => {
  void Promise.all([
    guildSettings
      .get(member.guild.id)
      .then((settings) => sendWelcome(member, settings.welcomeChannelId)),
    assignAutoRole(member),
    recordAudit(member.guild.id, member.id, "member_join", {
      userTag: member.user.tag,
    }),
  ]).catch((error: unknown) => reportEventError("member-join", error));
});

client.on(Events.GuildMemberRemove, (member) => {
  void recordAudit(member.guild.id, null, "member_leave", {
    targetId: member.id,
    userTag: member.user.tag,
  }).catch((error: unknown) => reportEventError("member-leave", error));
});

client.on(Events.MessageCreate, (message) => {
  if (
    !message.guild ||
    message.author.bot ||
    !/discord(?:\.gg|\.com\/invite)\/[\w-]+/i.test(message.content)
  )
    return;
  void (async () => {
    try {
      if (message.deletable) await message.delete();
      if (message.channel.isTextBased() && message.channel.isSendable()) {
        const warning = await message.channel.send(
          `⚠️ <@${message.author.id}> 招待リンクはこのチャンネルでは使用できません。`,
        );
        setTimeout(() => {
          void warning.delete().catch(() => undefined);
        }, 10_000).unref?.();
      }
      await recordAudit(
        message.guild!.id,
        message.author.id,
        "invite_link_blocked",
        { channelId: message.channelId },
      );
    } catch (error) {
      reportEventError("invite-link-detection", error);
    }
  })();
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  const changes = auditChanges(
    {
      nickname: oldMember.nickname,
      roleIds: oldMember.roles.cache.map((role) => role.id).sort(),
    },
    {
      nickname: newMember.nickname,
      roleIds: newMember.roles.cache.map((role) => role.id).sort(),
    },
  );
  if (!changes) return;
  void recordAudit(newMember.guild.id, null, "member_update", {
    targetId: newMember.id,
    changes,
  }).catch((error: unknown) => reportEventError("member-update", error));
  const oldRoleIds = new Set(oldMember.roles.cache.keys());
  const newRoleIds = new Set(newMember.roles.cache.keys());
  for (const roleId of [...newRoleIds].filter((id) => !oldRoleIds.has(id))) {
    void recordAudit(newMember.guild.id, null, "member_role_add", {
      targetId: newMember.id,
      roleId,
    }).catch((error: unknown) => reportEventError("member-role-add", error));
  }
  for (const roleId of [...oldRoleIds].filter((id) => !newRoleIds.has(id))) {
    void recordAudit(newMember.guild.id, null, "member_role_remove", {
      targetId: newMember.id,
      roleId,
    }).catch((error: unknown) => reportEventError("member-role-remove", error));
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const change = voiceChange(oldState, newState);
  if (!change || !newState.guild) return;
  const userId = newState.id;
  const guildId = newState.guild.id;
  const timerKey = `${guildId}:${userId}`;
  const oldTimer = voiceAfkTimers.get(timerKey);
  if (oldTimer) {
    clearTimeout(oldTimer);
    voiceAfkTimers.delete(timerKey);
  }
  if (change.action === "join" || change.action === "move") {
    if (!change.channelId) return;
    if (voiceAutoMute && newState.member && !newState.member.user.bot)
      void newState.member.voice
        .setMute(true, "VC参加時の自動ミュート")
        .catch((error) => reportEventError("voice-auto-mute", error));
    if (voiceAfkChannelId && newState.channelId !== voiceAfkChannelId) {
      const timer = setTimeout(() => {
        void newState.member?.voice
          .setChannel(voiceAfkChannelId, "VC無操作によるAFK移動")
          .catch((error) => reportEventError("voice-afk-move", error));
      }, voiceAfkMinutes * 60_000);
      timer.unref?.();
      voiceAfkTimers.set(timerKey, timer);
    }
  }
  const activeChannelId = change.channelId ?? "";
  const tasks: Promise<unknown>[] = [
    change.action === "move"
      ? Promise.all([
          api.stopVoiceSession({
            guildId,
            userId,
            endedAt: new Date().toISOString(),
          }),
          api.startVoiceSession({
            guildId,
            userId,
            channelId: activeChannelId,
            startedAt: new Date().toISOString(),
          }),
        ])
      : change.action === "leave"
        ? api.stopVoiceSession({
            guildId,
            userId,
            endedAt: new Date().toISOString(),
          })
        : api.startVoiceSession({
            guildId,
            userId,
            channelId: change.channelId ?? "",
            startedAt: new Date().toISOString(),
          }),
    api.recordVoiceEvent({
      guildId,
      userId,
      channelId: change.channelId,
      action: change.action,
      eventId: randomUUID(),
    }),
    sendVoiceLog(newState.guild, userId, change.action, change.channelId),
    guildSettings.get(guildId).then(async (settings) => {
      if (!settings.waitingVoiceChannelId) return;
      await temporaryVoiceManager.onVoiceStateChange(
        temporaryVoiceGuild(newState.guild, settings.temporaryVoiceCategoryId),
        userId,
        oldState.channelId,
        newState.channelId,
        settings.waitingVoiceChannelId,
      );
    }),
  ];
  void Promise.all(tasks).catch((error: unknown) =>
    reportEventError("voice-state-update", error),
  );
});

client.on(Events.MessageDelete, (message) => {
  if (!message.guildId || message.author?.bot) return;
  void recordAudit(message.guildId, null, "message_delete", {
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author?.id ?? null,
    content: messageContent(message),
  }).catch((error: unknown) => reportEventError("message-delete", error));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  if (!newMessage.guildId || newMessage.author?.bot) return;
  const before = messageContent(oldMessage);
  const after = messageContent(newMessage);
  if (before === after) return;
  void recordAudit(newMessage.guildId, null, "message_update", {
    channelId: newMessage.channelId,
    messageId: newMessage.id,
    authorId: newMessage.author?.id ?? null,
    before,
    after,
  }).catch((error: unknown) => reportEventError("message-update", error));
});

client.on(Events.ChannelDelete, (channel) => {
  if (!("guild" in channel) || !channel.guild) return;
  const tasks: Promise<unknown>[] = [
    recordAudit(channel.guild.id, null, "channel_delete", {
      channelId: channel.id,
      channelName: "name" in channel ? channel.name : null,
      channelType: channel.type,
    }),
  ];
  tasks.push(
    temporaryVoiceManager.onChannelDeleted(channel.guild.id, channel.id),
  );
  void Promise.all(tasks).catch((error: unknown) =>
    reportEventError("channel-delete", error),
  );
});

client.on(Events.ChannelCreate, (channel) => {
  if (!("guild" in channel) || !channel.guild) return;
  void recordAudit(
    channel.guild.id,
    null,
    "channel_create",
    channelAuditSnapshot(channel),
  ).catch((error: unknown) => reportEventError("channel-create", error));
});

client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
  if (
    !("guild" in oldChannel) ||
    !oldChannel.guild ||
    !("guild" in newChannel) ||
    !newChannel.guild
  )
    return;
  const changes = auditChanges(
    channelAuditSnapshot(oldChannel),
    channelAuditSnapshot(newChannel),
  );
  if (!changes) return;
  void recordAudit(newChannel.guild.id, null, "channel_update", {
    channelId: newChannel.id,
    changes,
  }).catch((error: unknown) => reportEventError("channel-update", error));
});

client.on(Events.GuildRoleCreate, (role) => {
  void recordAudit(
    role.guild.id,
    null,
    "role_create",
    roleAuditSnapshot(role),
  ).catch((error: unknown) => reportEventError("role-create", error));
});

client.on(Events.GuildRoleUpdate, (oldRole, newRole) => {
  const changes = auditChanges(
    roleAuditSnapshot(oldRole),
    roleAuditSnapshot(newRole),
  );
  if (!changes) return;
  void recordAudit(newRole.guild.id, null, "role_update", {
    roleId: newRole.id,
    changes,
  }).catch((error: unknown) => reportEventError("role-update", error));
});

client.on(Events.GuildRoleDelete, (role) => {
  void recordAudit(
    role.guild.id,
    null,
    "role_delete",
    roleAuditSnapshot(role),
  ).catch((error: unknown) => reportEventError("role-delete", error));
});

client.on(Events.GuildBanAdd, (ban) => {
  void recordAudit(ban.guild.id, null, "member_ban", {
    targetId: ban.user.id,
    userTag: ban.user.tag,
  }).catch((error: unknown) => reportEventError("member-ban", error));
});

client.on(Events.GuildBanRemove, (ban) => {
  void recordAudit(ban.guild.id, null, "member_unban", {
    targetId: ban.user.id,
    userTag: ban.user.tag,
  }).catch((error: unknown) => reportEventError("member-unban", error));
});

client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "help"
    ) {
      await interaction.reply({
        content: [
          "**Community Bot コマンド一覧**",
          "`/ping` Botの応答速度を確認",
          "`/announce message:<本文>` このチャンネルへ告知を投稿（管理権限）",
          "`/poll` ボタン式アンケートを作成",
          "`/role` ユーザーへロールを付与・削除（管理権限）",
          "`/remind` リマインダーを設定",
          "`/reminders` 自分のリマインダーを一覧表示",
          "`/remind-cancel` リマインダーをキャンセル",
          "`/notify` 繰り返し可能なカスタム通知を設定",
          "`/notify-cancel` カスタム通知をキャンセル",
          "`/userinfo` ユーザー情報を表示",
          "`/vc-recruit` VC参加者を募集",
          "`/self-intro` 自己紹介を投稿",
          "`/server-register` サーバー登録を投稿",
          "`/server-info` サーバーの基本情報を表示",
          "`/bot-status` Botの稼働状況を表示",
          "`/metrics` API成功・失敗回数を表示（管理者向け）",
          "`/music-history` 音楽再生履歴を表示",
          "`/health-alert-test` 死活監視通知をテスト（管理者向け）",
          "`/health-history` 障害・復旧履歴を表示",
          "`/slowmode` / `/lock` / `/unlock` / `/purge` 管理コマンド",
          "`/warn` / `/modlog` 警告と履歴",
          "`/ticket` 問い合わせチャンネルを作成",
          "`/suggest` 提案を投稿して投票",
          "`/audit-search` 監査ログを検索",
          "`/autorole` / `/role-menu` / `/role-temp` ロール管理",
          "`/nickname` ニックネーム変更",
          "`/verify` 認証ボタンを投稿",
          "`/timezone` タイムゾーン設定",
          "`/schedule` 予約通知を設定",
          "`/announce-schedule` 予約告知を設定（管理権限）",
          "`/schedule-list` / `/schedule-cancel` 予約通知を管理",
          "`/birthday set|list|remove` 誕生日通知設定",
          "`/rss-add` / `/rss-list` / `/rss-remove` RSS通知購読",
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "ping"
    ) {
      await interaction.reply(
        `🏓 Pong! WebSocket: ${Math.max(0, Math.round(client.ws.ping))}ms`,
      );
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "announce"
    ) {
      if (!interaction.memberPermissions?.has("ManageGuild")) {
        await interaction.reply({
          content: "このコマンドにはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const channel = interaction.channel;
      const message = interaction.options.getString("message", true).trim();
      if (!channel?.isTextBased() || !channel.isSendable()) {
        await interaction.reply({
          content: "このチャンネルには投稿できません。",
          ephemeral: true,
        });
        return;
      }
      await channel.send({
        content: `📢 **お知らせ**\n${message}`,
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: "告知を投稿しました。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "poll"
    ) {
      const question = interaction.options.getString("question", true).trim();
      const options = ["option1", "option2", "option3", "option4", "option5"]
        .map((name) => interaction.options.getString(name)?.trim())
        .filter((option): option is string => Boolean(option));
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルにはアンケートを投稿できません。",
          ephemeral: true,
        });
        return;
      }
      const pollId = randomUUID();
      const poll: PollState = { question, options, votes: new Map() };
      polls.set(pollId, poll);
      await interaction.channel.send({
        content: pollContent(poll),
        components: [pollButtons(pollId, poll)],
      });
      await interaction.reply({
        content: "アンケートを投稿しました。ボタンを押して投票できます。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "role"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
      ) {
        await interaction.reply({
          content: "このコマンドにはロール管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const target = await interaction.guild.members.fetch(
        interaction.options.getUser("user", true).id,
      );
      const selectedRole = interaction.options.getRole("role", true);
      const role = await interaction.guild.roles.fetch(selectedRole.id);
      const action = interaction.options.getString("action", true);
      const botMember = interaction.guild.members.me;
      if (
        !role ||
        role.managed ||
        !botMember ||
        botMember.roles.highest.comparePositionTo(role) <= 0
      ) {
        await interaction.reply({
          content: "Botより上位または連携管理中のロールは操作できません。",
          ephemeral: true,
        });
        return;
      }
      if (action === "add")
        await target.roles.add(role, `ロール管理: ${interaction.user.tag}`);
      else
        await target.roles.remove(role, `ロール管理: ${interaction.user.tag}`);
      await interaction.reply({
        content: `${target.user} のロール「${role.name}」を${action === "add" ? "付与" : "削除"}しました。`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "remind"
    ) {
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルにはリマインダーを設定できません。",
          ephemeral: true,
        });
        return;
      }
      const delayMinutes = interaction.options.getInteger(
        "delay_minutes",
        true,
      );
      const message = interaction.options.getString("message", true).trim();
      const reminder = scheduleReminder(
        interaction.user.id,
        interaction.channel.id,
        delayMinutes,
        message,
      );
      await interaction.reply({
        content: `リマインダーを設定しました。ID: \`${reminder.id}\`（<t:${Math.floor(reminder.expiresAt / 1000)}:R>）`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "notify"
    ) {
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルにはカスタム通知を設定できません。",
          ephemeral: true,
        });
        return;
      }
      const delayMinutes = interaction.options.getInteger(
        "delay_minutes",
        true,
      );
      const message = interaction.options.getString("message", true).trim();
      const repeatMinutes =
        interaction.options.getInteger("repeat_minutes") ?? null;
      const notification = scheduleReminder(
        interaction.user.id,
        interaction.channel.id,
        delayMinutes,
        message,
        repeatMinutes,
      );
      await interaction.reply({
        content: `カスタム通知を設定しました。ID: \`${notification.id}\`（<t:${Math.floor(notification.expiresAt / 1000)}:R>）${repeatMinutes ? `、以後${repeatMinutes}分ごと` : ""}`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "reminders"
    ) {
      const ownReminders = [...reminders.values()].filter(
        (reminder) => reminder.userId === interaction.user.id,
      );
      await interaction.reply({
        content:
          ownReminders.length === 0
            ? "設定中のリマインダーはありません。"
            : ownReminders
                .map(
                  (reminder) =>
                    `\`${reminder.id}\` — <t:${Math.floor(reminder.expiresAt / 1000)}:R>${reminder.repeatMinutes ? `（${reminder.repeatMinutes}分ごと）` : ""} — ${reminder.message}`,
                )
                .join("\n"),
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "remind-cancel"
    ) {
      const id = interaction.options.getString("id", true).trim().toLowerCase();
      const reminder = reminders.get(id);
      if (!reminder || reminder.userId !== interaction.user.id) {
        await interaction.reply({
          content: "指定されたリマインダーが見つかりません。",
          ephemeral: true,
        });
        return;
      }
      clearTimeout(reminder.timer);
      reminders.delete(id);
      await interaction.reply({
        content: `リマインダー \`${id}\` をキャンセルしました。`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "notify-cancel"
    ) {
      const id = interaction.options.getString("id", true).trim().toLowerCase();
      const notification = reminders.get(id);
      if (!notification || notification.userId !== interaction.user.id) {
        await interaction.reply({
          content: "指定されたカスタム通知が見つかりません。",
          ephemeral: true,
        });
        return;
      }
      clearTimeout(notification.timer);
      reminders.delete(id);
      await interaction.reply({
        content: `カスタム通知 \`${id}\` をキャンセルしました。`,
        ephemeral: true,
      });
      return;
    }

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "rss-add"
    ) {
      if (
        !interaction.guildId ||
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルにはRSSを設定できません。",
          ephemeral: true,
        });
        return;
      }
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "RSS購読にはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const url = interaction.options.getString("url", true).trim();
      const displayName = interaction.options.getString("name", true).trim();
      const intervalSeconds =
        interaction.options.getInteger("interval_seconds") ?? 900;
      const created = await communityPost<{ feed: { id: string } }>(
        "/v1/community/rss-feeds",
        {
          guildId: interaction.guildId,
          url,
          displayName,
          channelId: interaction.channel.id,
          createdBy: interaction.user.id,
          intervalSeconds,
        },
      );
      await interaction.reply({
        content: `RSS「${displayName}」を登録しました。ID: \`${created.feed.id}\``,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "rss-list"
    ) {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "サーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const feeds = await communityGet<{
        items: Array<{
          id: string;
          display_name: string;
          url: string;
          announcement_channel_id: string;
        }>;
      }>(`/v1/community/rss-feeds?guildId=${interaction.guildId}`);
      await interaction.reply({
        content: feeds.items.length
          ? feeds.items
              .map(
                (feed) =>
                  `\`${feed.id}\` **${feed.display_name}** → <#${feed.announcement_channel_id}>\n${feed.url}`,
              )
              .join("\n")
              .slice(0, 1900)
          : "RSS購読はありません。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "rss-remove"
    ) {
      if (
        !interaction.guildId ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "サーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const id = interaction.options.getString("id", true);
      await communityDelete(
        `/v1/community/rss-feeds/${encodeURIComponent(id)}?guildId=${interaction.guildId}`,
      );
      await interaction.reply({
        content: `RSS購読 \`${id}\` を停止しました。`,
        ephemeral: true,
      });
      return;
    }

    if (
      interaction.isChatInputCommand() &&
      (interaction.commandName === "schedule" ||
        interaction.commandName === "announce-schedule")
    ) {
      if (
        !interaction.guildId ||
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルには予約通知を設定できません。",
          ephemeral: true,
        });
        return;
      }
      if (
        interaction.commandName === "announce-schedule" &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "予約告知にはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const delayMinutes = interaction.options.getInteger(
        "delay_minutes",
        true,
      );
      const message = interaction.options.getString("message", true).trim();
      const intervalMinutes =
        interaction.options.getInteger("repeat_minutes") ?? null;
      const runAt = new Date(Date.now() + delayMinutes * 60_000);
      const created = await communityPost<{ id: string; runAt: string }>(
        "/v1/community/scheduled-notifications",
        {
          guildId: interaction.guildId,
          createdBy: interaction.user.id,
          channelId: interaction.channel.id,
          message,
          runAt: runAt.toISOString(),
          recurrence: intervalMinutes ? { intervalMinutes } : {},
        },
      );
      schedulePersistentNotification({
        id: created.id,
        guildId: interaction.guildId,
        userId: interaction.user.id,
        channelId: interaction.channel.id,
        message,
        runAt: new Date(created.runAt).getTime(),
        intervalMinutes,
      });
      await interaction.reply({
        content: `予約通知を設定しました。ID: \`${created.id}\`（<t:${Math.floor(new Date(created.runAt).getTime() / 1000)}:R>）`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "schedule-list"
    ) {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "サーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const result = await communityGet<{
        items: Array<{
          id: string;
          message: string;
          runAt: string;
          recurrence?: { intervalMinutes?: number };
        }>;
      }>(
        `/v1/community/scheduled-notifications?guildId=${interaction.guildId}&createdBy=${interaction.user.id}`,
      );
      await interaction.reply({
        content: result.items.length
          ? result.items
              .map(
                (item) =>
                  `\`${item.id}\` — <t:${Math.floor(new Date(item.runAt).getTime() / 1000)}:R>${item.recurrence?.intervalMinutes ? `（${item.recurrence.intervalMinutes}分ごと）` : ""} — ${item.message}`,
              )
              .join("\n")
              .slice(0, 1900)
          : "予約通知はありません。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "schedule-cancel"
    ) {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "サーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const id = interaction.options.getString("id", true);
      await communityDelete(
        `/v1/community/scheduled-notifications/${encodeURIComponent(id)}?guildId=${interaction.guildId}&userId=${interaction.user.id}`,
      );
      const pending = scheduledNotifications.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        scheduledNotifications.delete(id);
      }
      await interaction.reply({
        content: `予約通知 \`${id}\` をキャンセルしました。`,
        ephemeral: true,
      });
      return;
    }

    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "birthday"
    ) {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "サーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "set") {
        const month = interaction.options.getInteger("month", true);
        const day = interaction.options.getInteger("day", true);
        const timezone =
          interaction.options.getString("timezone") ?? "Asia/Tokyo";
        await communityPost("/v1/community/birthdays", {
          guildId: interaction.guildId,
          userId: interaction.user.id,
          month,
          day,
          timezone,
          channelId: interaction.channelId,
        });
        await interaction.reply({
          content: `誕生日を ${month}月${day}日に設定しました。`,
          ephemeral: true,
        });
      } else if (subcommand === "list") {
        const result = await communityGet<{
          items: Array<{ userId: string; month: number; day: number }>;
        }>(`/v1/community/birthdays?guildId=${interaction.guildId}`);
        await interaction.reply({
          content: result.items.length
            ? result.items
                .map(
                  (item) => `<@${item.userId}> — ${item.month}月${item.day}日`,
                )
                .join("\n")
            : "誕生日の登録はありません。",
          ephemeral: true,
        });
      } else {
        await communityDelete(
          `/v1/community/birthdays?guildId=${interaction.guildId}&userId=${interaction.user.id}`,
        );
        await interaction.reply({
          content: "誕生日設定を削除しました。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "server-info"
    ) {
      if (!interaction.guild) {
        await interaction.reply({
          content: "このコマンドはサーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: [
          `**${interaction.guild.name}**`,
          `メンバー数: ${interaction.guild.memberCount.toLocaleString()}人`,
          `サーバーID: \`${interaction.guild.id}\``,
          `作成日: <t:${Math.floor(interaction.guild.createdTimestamp / 1000)}:D>`,
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "autorole"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
      ) {
        await interaction.reply({
          content: "ロール管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const role = interaction.options.getRole("role", true);
      autoRoleId = role.id;
      await interaction.reply(
        `参加時の自動ロールを ${role} に設定しました。Bot再起動後も維持する場合は COMMUNITY_AUTO_ROLE_ID に設定してください。`,
      );
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "role-menu"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
      ) {
        await interaction.reply({
          content: "ロール管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルには投稿できません。",
          ephemeral: true,
        });
        return;
      }
      const role = interaction.options.getRole("role", true);
      const id = randomUUID().slice(0, 8);
      roleMenus.set(id, role.id);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`yanagi-role-menu:${id}`)
          .setLabel(`${role.name}を付け外し`)
          .setStyle(ButtonStyle.Primary),
      );
      await interaction.channel.send({
        content: `🎭 ボタンを押すと${role}を付け外しできます。`,
        components: [row],
      });
      await interaction.reply({
        content: "ロールメニューを投稿しました。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "role-temp"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)
      ) {
        await interaction.reply({
          content: "ロール管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const user = interaction.options.getUser("user", true);
      const role = interaction.options.getRole("role", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(
        role.id,
        `${interaction.user.tag} による期限付きロール付与`,
      );
      const expiresAt = Date.now() + minutes * 60_000;
      await communityPost("/v1/community/temporary-roles", {
        guildId: interaction.guild.id,
        userId: user.id,
        roleId: role.id,
        expiresAt: new Date(expiresAt).toISOString(),
        createdBy: interaction.user.id,
      });
      scheduleTemporaryRole(interaction.guild.id, user.id, role.id, expiresAt);
      await interaction.reply(
        `${user} に ${role} を${minutes}分間付与しました。`,
      );
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "nickname"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)
      ) {
        await interaction.reply({
          content: "ニックネーム管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const user = interaction.options.getUser("user", true);
      const nickname = interaction.options.getString("nickname");
      const member = await interaction.guild.members.fetch(user.id);
      await member.setNickname(
        nickname || null,
        `${interaction.user.tag} による変更`,
      );
      await interaction.reply({
        content: nickname
          ? `${user} のニックネームを「${nickname}」に変更しました。`
          : `${user} のニックネームを解除しました。`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "timezone"
    ) {
      if (!interaction.guild) {
        await interaction.reply({
          content: "サーバー内で設定してください。",
          ephemeral: true,
        });
        return;
      }
      const timezone = interaction.options.getString("zone", true).trim();
      try {
        new Intl.DateTimeFormat("ja-JP", { timeZone: timezone }).format();
      } catch {
        await interaction.reply({
          content:
            "有効なIANAタイムゾーンを入力してください（例: Asia/Tokyo）。",
          ephemeral: true,
        });
        return;
      }
      await communityPost("/v1/community/user-preferences", {
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        timezone,
      });
      await interaction.reply({
        content: `タイムゾーンを \`${timezone}\` に設定しました。`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "verify"
    ) {
      if (!verifyRoleId) {
        await interaction.reply({
          content: "`COMMUNITY_VERIFY_ROLE_ID`が設定されていません。",
          ephemeral: true,
        });
        return;
      }
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルには投稿できません。",
          ephemeral: true,
        });
        return;
      }
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("yanagi-verify")
          .setLabel("認証する")
          .setStyle(ButtonStyle.Success),
      );
      await interaction.channel.send({
        content: "✅ 認証する場合はボタンを押してください。",
        components: [row],
      });
      await interaction.reply({
        content: "認証ボタンを投稿しました。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "warn"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
      ) {
        await interaction.reply({
          content: "サーバー内で、メンバーをタイムアウトできる権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const target = interaction.options.getUser("user", true);
      const reason = interaction.options.getString("reason", true).trim();
      const result = await communityPost<{ caseNumber: number }>(
        "/v1/community/moderation-cases",
        {
          guildId: interaction.guild.id,
          targetUserId: target.id,
          actorUserId: interaction.user.id,
          action: "warn",
          reason,
        },
      );
      await interaction.reply(
        `⚠️ ${target} に警告しました。ケース番号: \`${result.caseNumber}\`\n理由: ${reason}`,
      );
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "modlog"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ViewAuditLog)
      ) {
        await interaction.reply({
          content: "監査ログを閲覧する権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const target = interaction.options.getUser("user");
      const action = interaction.options.getString("action");
      const query = new URLSearchParams({
        guildId: interaction.guild.id,
        limit: "20",
      });
      if (target) query.set("targetUserId", target.id);
      if (action) query.set("action", action);
      const result = await communityGet<{
        items: Array<{
          case_number: number;
          target_user_id: string;
          action: string;
          reason: string;
          created_at: string;
        }>;
      }>(`/v1/community/moderation-cases?${query}`);
      await interaction.reply({
        content: result.items.length
          ? result.items
              .map(
                (item) =>
                  `#${item.case_number} **${item.action}** <@${item.target_user_id}> — ${item.reason || "理由なし"} (<t:${Math.floor(new Date(item.created_at).getTime() / 1000)}:R>)`,
              )
              .join("\n")
              .slice(0, 1900)
          : "モデレーション履歴はありません。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "audit-search"
    ) {
      if (
        !interaction.guild ||
        !interaction.memberPermissions?.has(PermissionFlagsBits.ViewAuditLog)
      ) {
        await interaction.reply({
          content: "監査ログを閲覧する権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const query = new URLSearchParams({
        guildId: interaction.guild.id,
        limit: "20",
      });
      const action = interaction.options.getString("action");
      if (action) query.set("action", action);
      const result = await communityGet<{
        items: Array<{
          id: string;
          action: string;
          actor_id: string | null;
          created_at: string;
        }>;
      }>(`/v1/community/audit-search?${query}`);
      await interaction.reply({
        content: result.items.length
          ? result.items
              .map(
                (item) =>
                  `**${item.action}** — ${item.actor_id ? `<@${item.actor_id}>` : "不明"} (<t:${Math.floor(new Date(item.created_at).getTime() / 1000)}:R>)`,
              )
              .join("\n")
              .slice(0, 1900)
          : "監査ログはありません。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "ticket"
    ) {
      if (!interaction.guild || !interaction.guild.channels) {
        await interaction.reply({
          content: "サーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const topic =
        interaction.options
          .getString("topic", true)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 20) || "support";
      const channel = await interaction.guild.channels.create({
        name: `ticket-${topic}-${interaction.user.username}`.slice(0, 90),
        type: ChannelType.GuildText,
        permissionOverwrites: [
          {
            id: interaction.guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel],
          },
          {
            id: interaction.user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          },
          {
            id: client.user!.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageChannels,
            ],
          },
        ],
      });
      await channel.send(
        `🎫 ${interaction.user} の問い合わせチケットです。内容を記入してください。`,
      );
      await interaction.reply({
        content: `チケットを作成しました: ${channel}`,
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "suggest"
    ) {
      if (
        !interaction.channel?.isTextBased() ||
        !interaction.channel.isSendable()
      ) {
        await interaction.reply({
          content: "このチャンネルには投稿できません。",
          ephemeral: true,
        });
        return;
      }
      const text = interaction.options.getString("text", true).trim();
      const id = randomUUID().slice(0, 8);
      suggestions.set(id, {
        text,
        authorId: interaction.user.id,
        up: new Set(),
        down: new Set(),
      });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`yanagi-suggest:${id}:up`)
          .setLabel("賛成 0")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`yanagi-suggest:${id}:down`)
          .setLabel("反対 0")
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.channel.send({
        content: `💡 **提案**\n${text}\n提案者: <@${interaction.user.id}>`,
        components: [row],
      });
      await interaction.reply({
        content: "提案を投稿しました。",
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      ["slowmode", "lock", "unlock", "purge"].includes(interaction.commandName)
    ) {
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
      ) {
        await interaction.reply({
          content: "このコマンドにはチャンネル管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const channel = interaction.channel;
      if (
        !channel ||
        !channel.isTextBased() ||
        !("setRateLimitPerUser" in channel)
      ) {
        await interaction.reply({
          content: "テキストチャンネルでのみ使用できます。",
          ephemeral: true,
        });
        return;
      }
      if (interaction.commandName === "slowmode") {
        const seconds = interaction.options.getInteger("seconds", true);
        await channel.setRateLimitPerUser(
          seconds,
          `${interaction.user.tag} による設定`,
        );
        await interaction.reply(
          `🐢 低速モードを${seconds === 0 ? "解除" : `${seconds}秒`}に設定しました。`,
        );
        return;
      }
      if (
        interaction.commandName === "lock" ||
        interaction.commandName === "unlock"
      ) {
        if (!interaction.guild || !("permissionOverwrites" in channel)) {
          await interaction.reply({
            content: "サーバー内の通常チャンネルで使用してください。",
            ephemeral: true,
          });
          return;
        }
        await channel.permissionOverwrites.edit(
          interaction.guild.roles.everyone,
          { SendMessages: interaction.commandName === "lock" ? false : null },
          { reason: `${interaction.user.tag} によるチャンネル権限変更` },
        );
        await interaction.reply(
          interaction.commandName === "lock"
            ? "🔒 チャンネルをロックしました。"
            : "🔓 チャンネルのロックを解除しました。",
        );
        return;
      }
      const count = interaction.options.getInteger("count", true);
      if (!("bulkDelete" in channel)) {
        await interaction.reply({
          content: "このチャンネルでは一括削除できません。",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const deleted = await channel.bulkDelete(count, true);
      await interaction.editReply(
        `🧹 ${deleted.size}件のメッセージを削除しました。`,
      );
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "bot-status"
    ) {
      try {
        const result = (await dashboardFetch("/v1/dashboard/status")) as {
          bots: Array<{ service: string; online: boolean; lastSeenAt: string }>;
        };
        await interaction.reply({
          content: result.bots.length
            ? result.bots
                .map(
                  (bot) =>
                    `${bot.online ? "🟢" : "🔴"} **${bot.service}** — ${bot.online ? "稼働中" : "停止/応答なし"}（最終確認: <t:${Math.floor(new Date(bot.lastSeenAt).getTime() / 1000)}:R>）`,
                )
                .join("\n")
            : "稼働状況の記録がありません。",
          ephemeral: true,
        });
      } catch {
        await interaction.reply({
          content: "稼働状況を取得できませんでした。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "metrics"
    ) {
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "メトリクスの閲覧にはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }

      const minutes = Math.min(
        Math.max(interaction.options.getInteger("minutes") ?? 60, 1),
        1440,
      );
      try {
        const result = await communityGet<{
          items: Array<{
            metricKey: string;
            dimensions: Record<string, unknown>;
            value: number;
          }>;
        }>(`/v1/metrics?minutes=${minutes}`);
        const lines = result.items
          .slice(0, 20)
          .map(
            (item) =>
              `${item.value} — \`${item.metricKey}\` (${String(item.dimensions.status ?? "unknown")})`,
          );
        await interaction.reply({
          content: lines.length
            ? `📊 過去${minutes}分の集計\n${lines.join("\n")}`
            : "📊 まだメトリクスがありません。",
          ephemeral: true,
        });
      } catch (error) {
        reportEventError("metrics", error);
        await interaction.reply({
          content: "メトリクスを取得できませんでした。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "music-history"
    ) {
      try {
        const result = (await dashboardFetch(
          "/v1/dashboard/music-history",
        )) as {
          items: Array<{
            title: string;
            guildId: string;
            effect: string;
            startedAt: string;
            status: string;
          }>;
        };
        await interaction.reply({
          content: result.items.length
            ? result.items
                .slice(0, 15)
                .map(
                  (item, index) =>
                    `${index + 1}. **${item.title}** — Guild \`${item.guildId}\` / ${item.effect} / <t:${Math.floor(new Date(item.startedAt).getTime() / 1000)}:R>`,
                )
                .join("\n")
            : "音楽再生履歴はありません。",
          ephemeral: true,
        });
      } catch {
        await interaction.reply({
          content: "音楽再生履歴を取得できませんでした。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "health-history"
    ) {
      try {
        const result = (await dashboardFetch(
          "/v1/dashboard/health-history",
        )) as {
          items: Array<{ service: string; status: string; detectedAt: string }>;
        };
        await interaction.reply({
          content: result.items.length
            ? result.items
                .map(
                  (item) =>
                    `${item.status === "offline" ? "🚨" : "✅"} **${item.service}** — ${item.status === "offline" ? "停止" : "復旧"}（<t:${Math.floor(new Date(item.detectedAt).getTime() / 1000)}:R>）`,
                )
                .join("\n")
                .slice(0, 1900)
            : "障害・復旧履歴はありません。",
          ephemeral: true,
        });
      } catch {
        await interaction.reply({
          content: "障害・復旧履歴を取得できませんでした。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "event"
    ) {
      const subcommand = interaction.options.getSubcommand();
      try {
        if (subcommand === "create") {
          const title = interaction.options.getString("title", true);
          const startsAt = interaction.options.getString("starts_at", true);
          const description =
            interaction.options.getString("description") ?? "";
          const result = await communityPost<{
            eventId: string;
            startsAt: string;
          }>("/v1/community/events", {
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            createdBy: interaction.user.id,
            title,
            description,
            startsAt,
          });
          await interaction.reply({
            content: `📅 イベントを作成しました: **${title}** (<t:${Math.floor(new Date(result.startsAt).getTime() / 1000)}:F>)`,
            ephemeral: false,
          });
        } else if (subcommand === "list") {
          const result = await communityGet<{
            items: Array<{
              eventId: string;
              title: string;
              startsAt: string;
              description: string;
            }>;
          }>(`/v1/community/events?guildId=${interaction.guildId}`);
          await interaction.reply({
            content: result.items.length
              ? result.items
                  .map(
                    (item) =>
                      `📅 ${item.eventId.slice(0, 8)} **${item.title}** — <t:${Math.floor(new Date(item.startsAt).getTime() / 1000)}:F>\n${item.description}`,
                  )
                  .join("\n\n")
                  .slice(0, 1900)
              : "予定イベントはありません。",
            ephemeral: true,
          });
        } else {
          const eventId = interaction.options.getString("event_id", true);
          await communityDelete(
            `/v1/community/events/${encodeURIComponent(eventId)}?guildId=${interaction.guildId}&actorId=${interaction.user.id}`,
          );
          await interaction.reply({
            content: "イベントを取消しました。",
            ephemeral: true,
          });
        }
      } catch (error) {
        reportEventError("event-command", error);
        await interaction.reply({
          content:
            "イベント処理に失敗しました。日時はISO 8601形式で指定してください。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      (interaction.commandName === "health-ack" ||
        interaction.commandName === "health-silence")
    ) {
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "障害制御にはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      const service = interaction.options.getString("service", true);
      try {
        if (interaction.commandName === "health-ack") {
          await communityPost("/v1/health/ack", {
            service,
            actorId: interaction.user.id,
          });
          await interaction.reply({
            content: `✅ ${service} の障害を対応済みにしました。`,
            ephemeral: true,
          });
        } else {
          const minutes = interaction.options.getInteger("minutes", true);
          await communityPost("/v1/health/silence", {
            service,
            actorId: interaction.user.id,
            minutes,
          });
          await interaction.reply({
            content: `🔕 ${service} の通知を${minutes}分抑制します。`,
            ephemeral: true,
          });
        }
      } catch (error) {
        reportEventError("health-control", error);
        await interaction.reply({
          content: "障害通知の設定を更新できませんでした。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "health-alert-test"
    ) {
      if (
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await interaction.reply({
          content: "このコマンドにはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }
      if (!healthAlertChannelId) {
        await interaction.reply({
          content: "`COMMUNITY_HEALTH_ALERT_CHANNEL_ID`が設定されていません。",
          ephemeral: true,
        });
        return;
      }
      try {
        const channel = await client.channels.fetch(healthAlertChannelId);
        if (!channel?.isTextBased() || !channel.isSendable())
          throw new Error("Health alert channel is not sendable");
        await channel.send(
          `🧪 死活監視アラートのテスト通知です。実行者: ${interaction.user}`,
        );
        await interaction.reply({
          content: "監視通知チャンネルへテスト通知を送信しました。",
          ephemeral: true,
        });
      } catch (error) {
        console.error(
          `[health-alert-test] ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        await interaction.reply({
          content:
            "テスト通知の送信に失敗しました。Botのチャンネル閲覧・送信権限を確認してください。",
          ephemeral: true,
        });
      }
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "userinfo"
    ) {
      if (!interaction.guild) {
        await interaction.reply({
          content: "このコマンドはサーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const user = interaction.options.getUser("user") ?? interaction.user;
      const member = await interaction.guild.members
        .fetch(user.id)
        .catch(() => null);
      const roles = member
        ? member.roles.cache
            .filter((role) => role.id !== interaction.guild!.id)
            .map((role) => role.toString())
            .join(", ") || "なし"
        : "サーバー未参加";
      await interaction.reply({
        content: [
          `**${user.tag}**`,
          `ユーザーID: \`${user.id}\``,
          `アカウント作成日: <t:${Math.floor(user.createdTimestamp / 1000)}:D>`,
          `参加日: ${member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>` : "不明"}`,
          `ロール: ${roles}`,
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      (interaction.commandName === "self-intro" ||
        interaction.commandName === "server-register")
    ) {
      await communityForms.show(interaction);
      return;
    }
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("yanagi-form:")
    ) {
      await communityForms.handle(interaction);
      return;
    }
    if (
      interaction.isChatInputCommand() &&
      interaction.commandName === "vc-recruit"
    ) {
      if (
        !interaction.guildId ||
        !interaction.member ||
        !("voice" in interaction.member)
      ) {
        await interaction.reply({
          content: "このコマンドはサーバー内で使用してください。",
          ephemeral: true,
        });
        return;
      }
      const member = await interaction.guild?.members.fetch(
        interaction.user.id,
      );
      const voiceChannelId = member?.voice.channelId;
      if (!voiceChannelId) {
        await interaction.reply({
          content: "先に募集したいVCへ参加してから実行してください。",
          ephemeral: true,
        });
        return;
      }
      await voiceRecruitment.showCreateModal(interaction, voiceChannelId);
      return;
    }
    if (
      interaction.isModalSubmit() &&
      interaction.customId.startsWith("yanagi-vc-recruit:create:")
    ) {
      await voiceRecruitment.handleModal(interaction);
      return;
    }
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("yanagi-vc-recruit:")
    ) {
      await voiceRecruitment.handleButton(interaction);
      return;
    }
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("yanagi-role-menu:")
    ) {
      const roleId = roleMenus.get(
        interaction.customId.slice("yanagi-role-menu:".length),
      );
      if (!roleId || !interaction.guild) {
        await interaction.reply({
          content: "このロールメニューは期限切れです。",
          ephemeral: true,
        });
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const hasRole = member.roles.cache.has(roleId);
      if (hasRole) await member.roles.remove(roleId, "ロールメニュー");
      else await member.roles.add(roleId, "ロールメニュー");
      await interaction.reply({
        content: hasRole ? "ロールを外しました。" : "ロールを付与しました。",
        ephemeral: true,
      });
      return;
    }
    if (interaction.isButton() && interaction.customId === "yanagi-verify") {
      if (!verifyRoleId || !interaction.guild) {
        await interaction.reply({
          content: "認証設定がありません。",
          ephemeral: true,
        });
        return;
      }
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(verifyRoleId, "認証ボタン");
      await interaction.reply({ content: "認証しました。", ephemeral: true });
      return;
    }
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("yanagi-poll:")
    ) {
      const [, pollId, optionIndexText] = interaction.customId.split(":");
      const poll = polls.get(pollId);
      const optionIndex = Number(optionIndexText);
      if (
        !poll ||
        !Number.isInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= poll.options.length
      ) {
        await interaction.reply({
          content:
            "このアンケートは終了したか、再起動前に作成されたため投票できません。",
          ephemeral: true,
        });
        return;
      }
      poll.votes.set(interaction.user.id, optionIndex);
      await interaction.update({
        content: pollContent(poll),
        components: [pollButtons(pollId, poll)],
      });
    }
    if (
      interaction.isButton() &&
      interaction.customId.startsWith("yanagi-suggest:")
    ) {
      const [, suggestionId, vote] = interaction.customId.split(":");
      const suggestion = suggestions.get(suggestionId);
      if (!suggestion || (vote !== "up" && vote !== "down")) {
        await interaction.reply({
          content: "この提案は期限切れです。",
          ephemeral: true,
        });
        return;
      }
      suggestion.up.delete(interaction.user.id);
      suggestion.down.delete(interaction.user.id);
      (vote === "up" ? suggestion.up : suggestion.down).add(
        interaction.user.id,
      );
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`yanagi-suggest:${suggestionId}:up`)
          .setLabel(`賛成 ${suggestion.up.size}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`yanagi-suggest:${suggestionId}:down`)
          .setLabel(`反対 ${suggestion.down.size}`)
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.update({ components: [row] });
    }
  })().catch((error: unknown) =>
    reportEventError("voice-recruitment-interaction", error),
  );
});

client.once(Events.ClientReady, (readyClient) => {
  presence.start();
  void restoreTemporaryRoles().catch((error: unknown) =>
    reportEventError("temporary-role-restore", error),
  );
  void restoreScheduledNotifications().catch((error: unknown) =>
    reportEventError("scheduled-notification-restore", error),
  );
  void deliverBirthdays().catch((error: unknown) =>
    reportEventError("birthday-delivery", error),
  );
  void pollRssFeeds().catch((error: unknown) =>
    reportEventError("rss-poll", error),
  );
  const rssMonitor = setInterval(
    () =>
      void pollRssFeeds().catch((error: unknown) =>
        reportEventError("rss-poll", error),
      ),
    60_000,
  );
  rssMonitor.unref?.();
  const birthdayMonitor = setInterval(
    () =>
      void deliverBirthdays().catch((error: unknown) =>
        reportEventError("birthday-delivery", error),
      ),
    60_000,
  );
  birthdayMonitor.unref?.();
  void sendHeartbeat().catch((error: unknown) =>
    reportEventError("dashboard-heartbeat", error),
  );
  const heartbeat = setInterval(
    () =>
      void sendHeartbeat().catch((error: unknown) =>
        reportEventError("dashboard-heartbeat", error),
      ),
    30_000,
  );
  heartbeat.unref?.();
  if (healthAlertChannelId) {
    void checkServiceHealth();
    const healthMonitor = setInterval(() => void checkServiceHealth(), 30_000);
    healthMonitor.unref?.();
  }
  console.info(`Community Bot ready as ${readyClient.user.tag}`);
  void readyClient.application.commands
    .set([
      { name: "help", description: "利用できるコマンド一覧を表示します" },
      { name: "ping", description: "Botの応答速度を確認します" },
      {
        name: "announce",
        description: "このチャンネルへ告知を投稿します",
        options: [
          {
            type: 3,
            name: "message",
            description: "告知本文（最大1900文字）",
            required: true,
            max_length: 1900,
          },
        ],
      },
      {
        name: "poll",
        description: "ボタン式アンケートを作成します",
        options: [
          {
            type: 3,
            name: "question",
            description: "質問（最大200文字）",
            required: true,
            max_length: 200,
          },
          {
            type: 3,
            name: "option1",
            description: "選択肢1",
            required: true,
            max_length: 80,
          },
          {
            type: 3,
            name: "option2",
            description: "選択肢2",
            required: true,
            max_length: 80,
          },
          {
            type: 3,
            name: "option3",
            description: "選択肢3",
            required: false,
            max_length: 80,
          },
          {
            type: 3,
            name: "option4",
            description: "選択肢4",
            required: false,
            max_length: 80,
          },
          {
            type: 3,
            name: "option5",
            description: "選択肢5",
            required: false,
            max_length: 80,
          },
        ],
      },
      {
        name: "role",
        description: "ユーザーのロールを付与・削除します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: true,
          },
          { type: 8, name: "role", description: "対象ロール", required: true },
          {
            type: 3,
            name: "action",
            description: "操作",
            required: true,
            choices: [
              { name: "付与", value: "add" },
              { name: "削除", value: "remove" },
            ],
          },
        ],
      },
      {
        name: "remind",
        description: "指定時間後にリマインダーを送ります",
        options: [
          {
            type: 4,
            name: "delay_minutes",
            description: "何分後か（1〜10080）",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
          {
            type: 3,
            name: "message",
            description: "リマインダー本文",
            required: true,
            max_length: 1000,
          },
        ],
      },
      { name: "reminders", description: "自分のリマインダーを一覧表示します" },
      {
        name: "remind-cancel",
        description: "リマインダーをキャンセルします",
        options: [
          {
            type: 3,
            name: "id",
            description: "リマインダーID",
            required: true,
            min_length: 8,
            max_length: 8,
          },
        ],
      },
      {
        name: "notify",
        description: "繰り返し可能なカスタム通知を設定します",
        options: [
          {
            type: 4,
            name: "delay_minutes",
            description: "初回通知までの分数",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
          {
            type: 3,
            name: "message",
            description: "通知本文",
            required: true,
            max_length: 1000,
          },
          {
            type: 4,
            name: "repeat_minutes",
            description: "繰り返し間隔（省略すると1回のみ）",
            required: false,
            min_value: 1,
            max_value: 10080,
          },
        ],
      },
      {
        name: "notify-cancel",
        description: "カスタム通知をキャンセルします",
        options: [
          {
            type: 3,
            name: "id",
            description: "通知ID",
            required: true,
            min_length: 8,
            max_length: 8,
          },
        ],
      },
      {
        name: "rss-add",
        description: "RSS通知購読を追加します",
        options: [
          {
            type: 3,
            name: "url",
            description: "RSS/AtomフィードURL",
            required: true,
            max_length: 2000,
          },
          {
            type: 3,
            name: "name",
            description: "表示名",
            required: true,
            max_length: 120,
          },
          {
            type: 4,
            name: "interval_seconds",
            description: "確認間隔（60〜604800秒）",
            required: false,
            min_value: 60,
            max_value: 604800,
          },
        ],
      },
      { name: "rss-list", description: "RSS通知購読一覧を表示します" },
      {
        name: "rss-remove",
        description: "RSS通知購読を停止します",
        options: [
          { type: 3, name: "id", description: "購読ID", required: true },
        ],
      },
      {
        name: "schedule",
        description: "予約通知を設定します",
        options: [
          {
            type: 4,
            name: "delay_minutes",
            description: "初回通知までの分数",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
          {
            type: 3,
            name: "message",
            description: "通知本文",
            required: true,
            max_length: 1900,
          },
          {
            type: 4,
            name: "repeat_minutes",
            description: "繰り返し間隔（省略すると1回のみ）",
            required: false,
            min_value: 1,
            max_value: 10080,
          },
        ],
      },
      {
        name: "announce-schedule",
        description: "予約告知を設定します",
        options: [
          {
            type: 4,
            name: "delay_minutes",
            description: "初回告知までの分数",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
          {
            type: 3,
            name: "message",
            description: "告知本文",
            required: true,
            max_length: 1900,
          },
          {
            type: 4,
            name: "repeat_minutes",
            description: "繰り返し間隔（省略すると1回のみ）",
            required: false,
            min_value: 1,
            max_value: 10080,
          },
        ],
      },
      { name: "schedule-list", description: "予約通知を一覧表示します" },
      {
        name: "schedule-cancel",
        description: "予約通知をキャンセルします",
        options: [
          { type: 3, name: "id", description: "予約通知ID", required: true },
        ],
      },
      {
        name: "birthday",
        description: "誕生日通知を管理します",
        options: [
          {
            type: 1,
            name: "set",
            description: "誕生日を登録・更新します",
            options: [
              {
                type: 4,
                name: "month",
                description: "月",
                required: true,
                min_value: 1,
                max_value: 12,
              },
              {
                type: 4,
                name: "day",
                description: "日",
                required: true,
                min_value: 1,
                max_value: 31,
              },
              {
                type: 3,
                name: "timezone",
                description: "IANAタイムゾーン",
                required: false,
                max_length: 64,
              },
            ],
          },
          { type: 1, name: "list", description: "誕生日一覧を表示します" },
          { type: 1, name: "remove", description: "自分の誕生日を削除します" },
        ],
      },
      {
        name: "userinfo",
        description: "ユーザー情報を表示します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: false,
          },
        ],
      },
      { name: "vc-recruit", description: "VC参加者を募集します" },
      { name: "self-intro", description: "自己紹介モーダルを開きます" },
      {
        name: "server-register",
        description: "サーバー登録モーダルを開きます",
      },
      { name: "server-info", description: "サーバーの基本情報を表示します" },
      {
        name: "slowmode",
        description: "このチャンネルの低速モードを設定します",
        options: [
          {
            type: 4,
            name: "seconds",
            description: "秒数（0〜21600）",
            required: true,
            min_value: 0,
            max_value: 21600,
          },
        ],
      },
      { name: "lock", description: "このチャンネルをロックします" },
      { name: "unlock", description: "このチャンネルのロックを解除します" },
      {
        name: "purge",
        description: "メッセージを一括削除します",
        options: [
          {
            type: 4,
            name: "count",
            description: "削除件数（1〜100）",
            required: true,
            min_value: 1,
            max_value: 100,
          },
        ],
      },
      {
        name: "warn",
        description: "ユーザーに警告を記録します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: true,
          },
          {
            type: 3,
            name: "reason",
            description: "理由",
            required: true,
            max_length: 1000,
          },
        ],
      },
      {
        name: "modlog",
        description: "モデレーション履歴を表示します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: false,
          },
          { type: 3, name: "action", description: "操作種別", required: false },
        ],
      },
      {
        name: "ticket",
        description: "問い合わせチャンネルを作成します",
        options: [
          {
            type: 3,
            name: "topic",
            description: "問い合わせの種類",
            required: true,
            max_length: 40,
          },
        ],
      },
      {
        name: "suggest",
        description: "提案を投稿します",
        options: [
          {
            type: 3,
            name: "text",
            description: "提案内容",
            required: true,
            max_length: 1000,
          },
        ],
      },
      {
        name: "audit-search",
        description: "監査ログを検索します",
        options: [
          {
            type: 3,
            name: "action",
            description: "アクション名",
            required: false,
            max_length: 100,
          },
        ],
      },
      {
        name: "autorole",
        description: "参加時の自動ロールを設定します",
        options: [
          {
            type: 8,
            name: "role",
            description: "自動付与するロール",
            required: true,
          },
        ],
      },
      {
        name: "role-menu",
        description: "ロール付与ボタンを投稿します",
        options: [
          { type: 8, name: "role", description: "対象ロール", required: true },
        ],
      },
      {
        name: "role-temp",
        description: "期限付きでロールを付与します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: true,
          },
          { type: 8, name: "role", description: "対象ロール", required: true },
          {
            type: 4,
            name: "minutes",
            description: "付与時間（分）",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
        ],
      },
      {
        name: "nickname",
        description: "ニックネームを設定・解除します",
        options: [
          {
            type: 6,
            name: "user",
            description: "対象ユーザー",
            required: true,
          },
          {
            type: 3,
            name: "nickname",
            description: "新しい名前（省略で解除）",
            required: false,
            max_length: 32,
          },
        ],
      },
      { name: "verify", description: "認証ボタンを投稿します" },
      {
        name: "timezone",
        description: "自分のタイムゾーンを設定します",
        options: [
          {
            type: 3,
            name: "zone",
            description: "IANAタイムゾーン（例: Asia/Tokyo）",
            required: true,
            max_length: 64,
          },
        ],
      },
      { name: "bot-status", description: "Botの稼働状況を表示します" },
      {
        name: "metrics",
        description: "APIの成功・失敗回数を表示します",
        options: [
          {
            type: 4,
            name: "minutes",
            description: "集計期間（分）",
            required: false,
            min_value: 1,
            max_value: 1440,
          },
        ],
      },
      { name: "music-history", description: "音楽再生履歴を表示します" },
      {
        name: "health-alert-test",
        description: "死活監視通知の送信テストを行います",
      },
      { name: "health-history", description: "障害・復旧履歴を表示します" },
      {
        name: "event",
        description: "イベントを作成・一覧・取消します",
        options: [
          {
            type: 1,
            name: "create",
            description: "イベント作成",
            options: [
              {
                type: 3,
                name: "title",
                description: "イベント名",
                required: true,
                max_length: 200,
              },
              {
                type: 3,
                name: "starts_at",
                description: "開始日時（ISO 8601）",
                required: true,
                max_length: 64,
              },
              {
                type: 3,
                name: "description",
                description: "説明",
                required: false,
                max_length: 1000,
              },
            ],
          },
          { type: 1, name: "list", description: "予定一覧" },
          {
            type: 1,
            name: "cancel",
            description: "イベント取消",
            options: [
              {
                type: 3,
                name: "event_id",
                description: "イベントID",
                required: true,
                min_length: 8,
                max_length: 64,
              },
            ],
          },
        ],
      },
      {
        name: "health-ack",
        description: "障害を対応済みにします",
        options: [
          {
            type: 3,
            name: "service",
            description: "対象サービス",
            required: true,
            min_length: 1,
            max_length: 32,
          },
        ],
      },
      {
        name: "health-silence",
        description: "障害通知を一時抑制します",
        options: [
          {
            type: 3,
            name: "service",
            description: "対象サービス",
            required: true,
            min_length: 1,
            max_length: 32,
          },
          {
            type: 4,
            name: "minutes",
            description: "抑制分数",
            required: true,
            min_value: 1,
            max_value: 10080,
          },
        ],
      },
    ])
    .catch((error: unknown) =>
      reportEventError("community-command-registration", error),
    );
  if (!welcomeChannelId) {
    console.info(
      "COMMUNITY_WELCOME_CHANNEL_ID is not set; environment settings can enable welcome messages",
    );
  }
  if (!waitingVoiceChannelId) {
    console.info(
      "COMMUNITY_WAITING_VOICE_CHANNEL_ID is not set; environment settings can enable temporary voice channels",
    );
  }
  if (waitingVoiceChannelId && !temporaryVoiceCategoryId) {
    console.info(
      "COMMUNITY_TEMP_VOICE_CATEGORY_ID is not set; temporary channels will be created without a category",
    );
  }
  void Promise.all(
    Array.from(readyClient.guilds.cache.values()).flatMap((guild) => [
      temporaryVoiceManager.reconcileGuild(
        temporaryVoiceGuild(guild, temporaryVoiceCategoryId || null),
      ),
      api
        .listVoiceRecruitments(guild.id)
        .then((recruitments) =>
          voiceRecruitment.restoreRecruitments(recruitments, readyClient),
        ),
    ]),
  ).catch((error: unknown) =>
    reportEventError("temporary-voice-reconciliation", error),
  );
  const outboxTimer = setInterval(
    () =>
      void deliverNotificationOutbox().catch((error) =>
        reportEventError("notification-outbox-claim", error),
      ),
    10_000,
  );
  outboxTimer.unref?.();
});

client.on(Events.Error, (error) =>
  reportDiscordIncident("discord-client", error),
);
client.on(Events.ShardError, (error) =>
  reportDiscordIncident("discord-shard", error),
);
client.on(Events.Invalidated, () =>
  reportDiscordIncident(
    "discord-session-invalidated",
    new Error("Discord session was invalidated"),
  ),
);

try {
  await client.login(token);
} catch (error) {
  await client.destroy();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    presence.stop();
    client.destroy();
  });
}
