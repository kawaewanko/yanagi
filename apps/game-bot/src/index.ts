import {
  Client,
  Events,
  GatewayIntentBits,
  ActivityType,
  REST,
  Routes,
} from "discord.js";
import { CoreApiClient } from "@yanagi/core-api-client";
import { BotPresenceController } from "@yanagi/bot-presence";
import { gameCommandDefinitions, handleGameCommand } from "./commands.js";
import { VoiceRewardScheduler } from "./voice-rewards.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token = required("GAME_BOT_TOKEN");
const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_GAME");
const api = new CoreApiClient({
  baseUrl: coreApiUrl,
  apiKey: coreApiKey,
  timeoutMs: 30_000,
});
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const presence = new BotPresenceController({
  getPing: () => client.ws.ping,
  activityLabel: "ゲーム・ポイント・抽選",
  setPresence: ({ activity, status }) => {
    client.user?.setPresence({
      activities: [{ name: activity.name, type: ActivityType.Watching }],
      status,
    });
  },
  reportUpdateError: (error) =>
    console.error("[presence-update] Failed to update Discord presence", error),
});
const voiceRewards = new VoiceRewardScheduler(api, (error) =>
  reportError("voice-point", error),
);
const commandData = gameCommandDefinitions().map((command) => command.toJSON());
const rest = new REST({ version: "10" }).setToken(token);

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: "game" }),
  });
}

function reportError(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportError();
}

function reportDiscordIncident(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportIncident();
}

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId || message.author.bot) return;
  void api
    .awardMessagePoint({
      guildId: message.guildId,
      userId: message.author.id,
      messageId: message.id,
    })
    .catch((error: unknown) => reportError("message-point", error));
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (!newState.guild) return;
  if (newState.channelId) {
    voiceRewards.start(newState.guild.id, newState.id);
  } else if (oldState.channelId) {
    voiceRewards.stop(newState.guild.id, newState.id);
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleGameCommand(interaction, api, (error) =>
    reportError(`command:${interaction.commandName}`, error),
  ).catch((error: unknown) =>
    reportError(`interaction:${interaction.commandName}`, error),
  );
});

async function registerCommands(
  applicationId: string,
  guildIds: string[],
): Promise<void> {
  for (const guildId of guildIds) {
    await rest.put(Routes.applicationGuildCommands(applicationId, guildId), {
      body: commandData,
    });
  }
}

client.once(Events.ClientReady, (readyClient) => {
  presence.start();
  void sendHeartbeat().catch((error: unknown) =>
    reportError("dashboard-heartbeat", error),
  );
  const heartbeat = setInterval(
    () =>
      void sendHeartbeat().catch((error: unknown) =>
        reportError("dashboard-heartbeat", error),
      ),
    30_000,
  );
  heartbeat.unref?.();
  console.info(`Game Bot ready as ${readyClient.user.tag}`);
  void registerCommands(readyClient.application.id, [
    ...readyClient.guilds.cache.keys(),
  ])
    .then(() => {
      console.info(
        `Registered Game Bot commands for ${readyClient.guilds.cache.size} guilds`,
      );
    })
    .catch((error: unknown) => reportError("command-registration", error));

  for (const guild of readyClient.guilds.cache.values()) {
    for (const voiceState of guild.voiceStates.cache.values()) {
      if (
        voiceState.member &&
        !voiceState.member.user.bot &&
        voiceState.channelId
      ) {
        voiceRewards.start(guild.id, voiceState.id);
      }
    }
  }
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
  voiceRewards.stopAll();
  presence.stop();
  await client.destroy();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    voiceRewards.stopAll();
    presence.stop();
    client.destroy();
  });
}
