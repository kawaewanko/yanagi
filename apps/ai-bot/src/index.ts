import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from "discord.js";
import { BotPresenceController } from "@yanagi/bot-presence";
import { CoreApiClient } from "@yanagi/core-api-client";
import { aiCommandDefinitions, handleAiCommand } from "./commands.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token = required("AI_BOT_TOKEN");
const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_AI");
const api = new CoreApiClient({
  baseUrl: coreApiUrl,
  apiKey: coreApiKey,
  timeoutMs: 60_000,
});
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const presence = new BotPresenceController({
  getPing: () => client.ws.ping,
  activityLabel: "AI・翻訳・要約",
  setPresence: ({ activity, status }) => {
    client.user?.setPresence({
      activities: [{ name: activity.name, type: ActivityType.Watching }],
      status,
    });
  },
  reportUpdateError: (error) =>
    console.error("[presence-update] Failed to update Discord presence", error),
});
const commandData = aiCommandDefinitions().map((command) => command.toJSON());
const rest = new REST({ version: "10" }).setToken(token);

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: "ai" }),
  });
}

function reportError(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportError();
}

function reportIncident(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportIncident();
}

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  void handleAiCommand(interaction, api, (error) =>
    reportError(`command:${interaction.commandName}`, error),
  ).catch((error: unknown) =>
    reportError(`interaction:${interaction.commandName}`, error),
  );
});

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
  void registerCommands(readyClient.application.id, [
    ...readyClient.guilds.cache.keys(),
  ])
    .then(() =>
      console.info(
        `Registered AI Bot commands for ${readyClient.guilds.cache.size} guilds`,
      ),
    )
    .catch((error: unknown) => reportError("command-registration", error));
  console.info(`AI Bot ready as ${readyClient.user.tag}`);
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

client.on(Events.Error, (error) => reportIncident("discord-client", error));
client.on(Events.ShardError, (error) => reportIncident("discord-shard", error));
client.on(Events.Invalidated, () =>
  reportIncident(
    "discord-session-invalidated",
    new Error("Discord session was invalidated"),
  ),
);

try {
  await client.login(token);
} catch (error) {
  presence.stop();
  await client.destroy();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    presence.stop();
    client.destroy();
  });
}
