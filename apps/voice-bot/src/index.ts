import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  Client,
  ChannelType,
  Events,
  GatewayIntentBits,
  ActivityType,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import play from "play-dl";
import { CoreApiClient, CoreApiError } from "@yanagi/core-api-client";
import { BotPresenceController } from "@yanagi/bot-presence";
import { voiceCommandDefinitions, type VoiceBotMode } from "./commands.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const token = required("VOICE_BOT_TOKEN");
const coreApiUrl = required("CORE_API_URL");
const coreApiKey = required("CORE_API_KEY_VOICE");
const modeValue = process.env.VOICE_BOT_MODE?.trim() ?? "all";
if (!(["all", "tts", "music"] as const).includes(modeValue as VoiceBotMode)) {
  throw new Error("VOICE_BOT_MODE must be all, tts, or music");
}
const mode = modeValue as VoiceBotMode;
const serviceName =
  process.env.BOT_SERVICE_NAME?.trim() ||
  (mode === "tts" ? "tts" : mode === "music" ? "music" : "voice");
const api = new CoreApiClient({ baseUrl: coreApiUrl, apiKey: coreApiKey });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});
const presence = new BotPresenceController({
  getPing: () => client.ws.ping,
  activityLabel:
    mode === "tts" ? "読み上げ" : mode === "music" ? "音楽再生" : "音楽・TTS",
  setPresence: ({ activity, status }) => {
    client.user?.setPresence({
      activities: [{ name: activity.name, type: ActivityType.Watching }],
      status,
    });
  },
  reportUpdateError: (error) =>
    console.error("[presence-update] Failed to update Discord presence", error),
});
const commandData = voiceCommandDefinitions(mode).map((command) =>
  command.toJSON(),
);
const rest = new REST({ version: "10" }).setToken(token);
const playbackQueues = new Map<string, Promise<void>>();
const voiceConnections = new Map<string, ReturnType<typeof joinVoiceChannel>>();
const activePlayers = new Map<string, ReturnType<typeof createAudioPlayer>>();
type MusicTrack = { url: string; title: string; requesterId: string };
type MusicEffect = "none" | "bassboost" | "nightcore" | "vaporwave" | "8d";
type MusicState = {
  queue: MusicTrack[];
  current: MusicTrack | null;
  player: ReturnType<typeof createAudioPlayer> | null;
  playing: boolean;
  loop: boolean;
  effect: MusicEffect;
  volume: number;
  skipRequested: boolean;
};
const musicStates = new Map<string, MusicState>();

async function sendHeartbeat(): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ service: serviceName }),
  });
}

async function recordMusicStart(
  guildId: string,
  track: MusicTrack,
  effect: MusicEffect,
): Promise<void> {
  await fetch(`${coreApiUrl}/v1/dashboard/music-history`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${coreApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      guildId,
      requesterId: track.requesterId,
      title: track.title,
      url: track.url,
      effect,
    }),
  });
}

async function musicApi<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${coreApiKey}`);
  if (init?.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(`${coreApiUrl}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`music_api_${response.status}`);
  return response.json() as Promise<T>;
}

function getMusicState(guildId: string): MusicState {
  const state = musicStates.get(guildId) ?? {
    queue: [],
    current: null,
    player: null,
    playing: false,
    loop: false,
    effect: "none" as MusicEffect,
    volume: 1,
    skipRequested: false,
  };
  musicStates.set(guildId, state);
  return state;
}

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[voice-tts] ${message}`);
  presence.reportError();
}

function reportDiscordIncident(eventName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`[${eventName}] ${message}`);
  presence.reportIncident();
}

function userError(error: unknown): string {
  if (error instanceof CoreApiError) {
    if (error.code === "tts_job_not_found")
      return "読み上げジョブが見つかりません。";
    if (error.code === "timeout") return "読み上げ処理がタイムアウトしました。";
    return "読み上げサービスに接続できません。少し待ってから再度お試しください。";
  }
  if (error instanceof Error && error.message === "tts_job_failed") {
    return "音声合成に失敗しました。時間をおいて再度お試しください。";
  }
  if (error instanceof Error && error.message === "tts_job_timeout") {
    return "読み上げ待ち時間を超えました。しばらくしてから再度お試しください。";
  }
  if (error instanceof Error && error.message === "voice_connection_timeout") {
    return "ボイスチャンネルに接続できませんでした。Botの接続権限をご確認ください。";
  }
  return "読み上げ中にエラーが発生しました。";
}

async function waitForAudio(
  jobId: string,
  guildId: string,
  requesterId: string,
): Promise<Uint8Array> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = await api.getTtsJob(jobId, guildId, requesterId);
    if (state.status === "succeeded")
      return api.getTtsAudio(jobId, guildId, requesterId);
    if (state.status === "failed") throw new Error("tts_job_failed");
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("tts_job_timeout");
}

async function playAudio(
  channelId: string,
  guildId: string,
  adapterCreator: Parameters<typeof joinVoiceChannel>[0]["adapterCreator"],
  audio: Uint8Array,
): Promise<void> {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  const player = createAudioPlayer();
  try {
    let connectionTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Ready, 20_000),
        new Promise<never>((_, reject) => {
          connectionTimeout = setTimeout(
            () => reject(new Error("voice_connection_timeout")),
            20_000,
          );
        }),
      ]);
    } finally {
      if (connectionTimeout) clearTimeout(connectionTimeout);
    }
    connection.subscribe(player);
    activePlayers.set(guildId, player);
    const resource = createAudioResource(Readable.from([Buffer.from(audio)]), {
      inputType: StreamType.Arbitrary,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        player.removeListener(AudioPlayerStatus.Idle, onIdle);
        player.removeListener("error", onError);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onIdle = () => finish(resolve);
      const onError = (error: Error) => finish(() => reject(error));
      timeout = setTimeout(
        () => finish(() => reject(new Error("voice_playback_timeout"))),
        120_000,
      );
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once("error", onError);
      try {
        player.play(resource);
      } catch (error) {
        finish(() => reject(error));
      }
    });
  } finally {
    if (activePlayers.get(guildId) === player) activePlayers.delete(guildId);
    player.stop(true);
    connection.destroy();
  }
}

async function enqueuePlayback(
  key: string,
  action: () => Promise<void>,
): Promise<void> {
  const previous = playbackQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  playbackQueues.set(key, current);
  try {
    await current;
  } finally {
    if (playbackQueues.get(key) === current) playbackQueues.delete(key);
  }
}

function effectFilter(effect: MusicEffect): string | null {
  if (effect === "bassboost") return "bass=g=8";
  if (effect === "nightcore") return "asetrate=48000*1.25,aresample=48000";
  if (effect === "vaporwave") return "asetrate=48000*0.8,aresample=48000";
  if (effect === "8d") return "apulsator=hz=0.08";
  return null;
}

async function playNextMusic(guildId: string): Promise<void> {
  const state = getMusicState(guildId);
  if (state.playing) return;
  const track = state.queue.shift();
  const connection = voiceConnections.get(guildId);
  if (!track || !connection) return;
  state.playing = true;
  state.current = track;
  const player = createAudioPlayer();
  state.player = player;
  connection.subscribe(player);
  try {
    const source = await play.stream(track.url, {
      discordPlayerCompatibility: true,
    });
    void recordMusicStart(guildId, track, state.effect).catch(
      (error: unknown) => reportError(error),
    );
    const filter = effectFilter(state.effect);
    let transcoder: ReturnType<typeof spawn> | null = null;
    let resource;
    if (filter) {
      transcoder = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          "pipe:0",
          "-af",
          filter,
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      if (!transcoder.stdin || !transcoder.stdout)
        throw new Error("ffmpeg_pipe_unavailable");
      source.stream.pipe(transcoder.stdin);
      resource = createAudioResource(transcoder.stdout, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
    } else {
      resource = createAudioResource(source.stream, {
        inputType: source.type,
        inlineVolume: true,
      });
    }
    resource.volume?.setVolume(state.volume);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        player.removeListener(AudioPlayerStatus.Idle, onIdle);
        player.removeListener("error", onError);
      };
      const onIdle = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      player.once(AudioPlayerStatus.Idle, onIdle);
      player.once("error", onError);
      player.play(resource);
      transcoder?.once("error", onError);
    });
    transcoder?.kill();
  } catch (error) {
    reportError(error);
  } finally {
    if (state.loop && !state.skipRequested) state.queue.unshift(track);
    state.skipRequested = false;
    player.stop(true);
    if (state.player === player) state.player = null;
    state.current = null;
    state.playing = false;
    if (state.queue.length > 0 && voiceConnections.has(guildId))
      void playNextMusic(guildId);
  }
}

async function ensureMusicConnection(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) throw new Error("guild_required");
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.voice.channel) throw new Error("voice_channel_required");
  if (voiceConnections.has(interaction.guild.id)) return;
  const connection = joinVoiceChannel({
    channelId: member.voice.channel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  voiceConnections.set(interaction.guild.id, connection);
}

async function handleMusicCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使用してください。",
      ephemeral: true,
    });
    return;
  }
  const state = getMusicState(interaction.guild.id);
  if (interaction.commandName === "music-play") {
    const sourceText = (
      interaction.options.getString("query") ??
      interaction.options.getString("url")
    )?.trim();
    if (!sourceText) {
      await interaction.reply({
        content: "`url`または`query`のどちらかを入力してください。",
        ephemeral: true,
      });
      return;
    }
    await ensureMusicConnection(interaction);
    let tracks: MusicTrack[];
    try {
      const parsedUrl = (() => {
        try {
          return new URL(sourceText);
        } catch {
          return null;
        }
      })();
      if (
        parsedUrl &&
        (parsedUrl.searchParams.has("list") ||
          parsedUrl.pathname.startsWith("/playlist"))
      ) {
        const playlist = await play.playlist_info(sourceText, {
          incomplete: true,
        });
        const videos = await playlist.all_videos();
        tracks = videos
          .slice(0, 50)
          .filter((video) => Boolean(video.url))
          .map((video) => ({
            url: video.url,
            title: video.title || video.url,
            requesterId: interaction.user.id,
          }));
      } else if (parsedUrl) {
        tracks = [
          {
            url: sourceText,
            title: sourceText,
            requesterId: interaction.user.id,
          },
        ];
      } else {
        const results = await play.search(sourceText, {
          limit: 1,
          source: { youtube: "video" },
        });
        if (!results[0]?.url) throw new Error("music_search_empty");
        tracks = [
          {
            url: results[0].url,
            title: results[0].title || sourceText,
            requesterId: interaction.user.id,
          },
        ];
      }
    } catch (error) {
      reportError(error);
      await interaction.reply({
        content:
          "音源の取得に失敗しました。URLまたは検索語を確認してください。",
        ephemeral: true,
      });
      return;
    }
    if (tracks.length === 0) {
      await interaction.reply({
        content: "再生できる音源が見つかりませんでした。",
        ephemeral: true,
      });
      return;
    }
    state.queue.push(...tracks);
    void playNextMusic(interaction.guild.id);
    await interaction.reply(`🎵 ${tracks.length}曲をキューに追加しました。`);
    return;
  }
  if (interaction.commandName === "music-queue") {
    const lines = [
      state.current ? `再生中: ${state.current.title}` : "再生中: なし",
      ...state.queue.map((track, index) => `${index + 1}. ${track.title}`),
    ];
    await interaction.reply({
      content: lines.join("\n").slice(0, 1900),
      ephemeral: true,
    });
    return;
  }
  if (
    interaction.commandName === "music-pause" ||
    interaction.commandName === "music-resume"
  ) {
    if (!state.player) {
      await interaction.reply({
        content: "再生中の音楽はありません。",
        ephemeral: true,
      });
      return;
    }
    const changed =
      interaction.commandName === "music-pause"
        ? state.player.pause()
        : state.player.unpause();
    await interaction.reply({
      content: changed
        ? interaction.commandName === "music-pause"
          ? "音楽を一時停止しました。"
          : "音楽を再開しました。"
        : "状態を変更できませんでした。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-loop") {
    state.loop = interaction.options.getBoolean("enabled", true);
    await interaction.reply(
      `🔁 ループ再生を${state.loop ? "有効" : "無効"}にしました。`,
    );
    return;
  }
  if (interaction.commandName === "music-effect") {
    state.effect = interaction.options.getString("effect", true) as MusicEffect;
    await interaction.reply(
      `🎛️ エフェクトを **${state.effect}** に設定しました。次の曲から適用されます。`,
    );
    return;
  }
  if (interaction.commandName === "music-volume") {
    const percent = interaction.options.getInteger("percent", true);
    state.volume = percent / 100;
    await interaction.reply(
      `🔊 音量を **${percent}%** に設定しました。次の曲から適用されます。`,
    );
    return;
  }
  if (interaction.commandName === "music-shuffle") {
    for (let index = state.queue.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      [state.queue[index], state.queue[target]] = [
        state.queue[target],
        state.queue[index],
      ];
    }
    await interaction.reply({
      content: state.queue.length
        ? `🔀 ${state.queue.length}曲をシャッフルしました。`
        : "待機中の曲はありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-remove") {
    const position = interaction.options.getInteger("position", true);
    const removed = state.queue.splice(position - 1, 1)[0];
    await interaction.reply({
      content: removed
        ? `🗑️ キューから「${removed.title}」を削除しました。`
        : "指定位置の曲が見つかりません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-clear") {
    const count = state.queue.length;
    state.queue.length = 0;
    await interaction.reply({
      content: count
        ? `🧹 待機中の${count}曲を消去しました。`
        : "待機中の曲はありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-now-playing") {
    await interaction.reply({
      content: state.current
        ? `🎵 **${state.current.title}**\nエフェクト: ${state.effect}\n音量: ${Math.round(state.volume * 100)}%\nループ: ${state.loop ? "有効" : "無効"}`
        : "現在再生中の曲はありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-ranking") {
    const days = interaction.options.getInteger("days") ?? 30;
    const result = await musicApi<{
      items: Array<{ title: string; url: string; plays: number }>;
      days: number;
    }>(
      `/v1/music/ranking?guildId=${encodeURIComponent(interaction.guild.id)}&days=${days}&limit=10`,
    );
    const content = result.items.length
      ? result.items
          .map(
            (item, index) =>
              `${index + 1}. **${item.title}** — ${item.plays}回`,
          )
          .join("\n")
      : "再生履歴がありません。";
    await interaction.reply({
      content: `🎧 過去${result.days}日間の再生ランキング\n${content}`.slice(
        0,
        1900,
      ),
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-favorite-add") {
    if (!state.current) {
      await interaction.reply({
        content: "現在再生中の曲がありません。",
        ephemeral: true,
      });
      return;
    }
    await musicApi("/v1/music/favorites", {
      method: "POST",
      body: JSON.stringify({
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        url: state.current.url,
        title: state.current.title,
      }),
    });
    await interaction.reply({
      content: `⭐ 「${state.current.title}」をお気に入りに登録しました。`,
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-favorites") {
    const result = await musicApi<{
      items: Array<{ title: string; url: string }>;
    }>(
      `/v1/music/favorites?guildId=${encodeURIComponent(interaction.guild.id)}&userId=${encodeURIComponent(interaction.user.id)}`,
    );
    await interaction.reply({
      content: result.items.length
        ? result.items
            .map(
              (item, index) => `${index + 1}. **${item.title}**\n${item.url}`,
            )
            .join("\n")
            .slice(0, 1900)
        : "お気に入りはありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-favorite-remove") {
    const url = interaction.options.getString("url", true);
    await musicApi(
      `/v1/music/favorites?guildId=${encodeURIComponent(interaction.guild.id)}&userId=${encodeURIComponent(interaction.user.id)}&url=${encodeURIComponent(url)}`,
      { method: "DELETE" },
    );
    await interaction.reply({
      content: "お気に入りから削除しました。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-playlist-save") {
    if (!state.current) {
      await interaction.reply({
        content: "現在再生中の曲がありません。",
        ephemeral: true,
      });
      return;
    }
    const name = interaction.options.getString("name", true).trim();
    const playlist = await musicApi<{ playlistId: number }>(
      "/v1/music/playlists",
      {
        method: "POST",
        body: JSON.stringify({
          guildId: interaction.guild.id,
          userId: interaction.user.id,
          name,
        }),
      },
    );
    await musicApi("/v1/music/playlists/tracks", {
      method: "POST",
      body: JSON.stringify({
        playlistId: playlist.playlistId,
        url: state.current.url,
        title: state.current.title,
      }),
    });
    await interaction.reply({
      content: `📚 「${state.current.title}」をプレイリスト「${name}」へ保存しました。`,
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-playlist-list") {
    const result = await musicApi<{
      items: Array<{ name: string; track_count: number }>;
    }>(
      `/v1/music/playlists?guildId=${encodeURIComponent(interaction.guild.id)}&userId=${encodeURIComponent(interaction.user.id)}`,
    );
    await interaction.reply({
      content: result.items.length
        ? result.items
            .map((item) => `• **${item.name}** (${item.track_count}曲)`)
            .join("\n")
        : "プレイリストはありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "music-playlist-play") {
    const name = interaction.options.getString("name", true).trim();
    const playlists = await musicApi<{
      items: Array<{ id: number; name: string }>;
    }>(
      `/v1/music/playlists?guildId=${encodeURIComponent(interaction.guild.id)}&userId=${encodeURIComponent(interaction.user.id)}`,
    );
    const playlist = playlists.items.find((item) => item.name === name);
    if (!playlist) {
      await interaction.reply({
        content: "指定したプレイリストが見つかりません。",
        ephemeral: true,
      });
      return;
    }
    const tracks = await musicApi<{
      items: Array<{ url: string; title: string }>;
    }>(`/v1/music/playlists/tracks?playlistId=${playlist.id}`);
    if (!tracks.items.length) {
      await interaction.reply({
        content: "プレイリストに曲がありません。",
        ephemeral: true,
      });
      return;
    }
    await ensureMusicConnection(interaction);
    state.queue.push(
      ...tracks.items.map((track) => ({
        ...track,
        requesterId: interaction.user.id,
      })),
    );
    void playNextMusic(interaction.guild.id);
    await interaction.reply(
      `📚 プレイリスト「${name}」から${tracks.items.length}曲をキューに追加しました。`,
    );
    return;
  }
  if (interaction.commandName === "music-skip") {
    if (!state.player) {
      await interaction.reply({
        content: "スキップする音楽はありません。",
        ephemeral: true,
      });
      return;
    }
    state.skipRequested = true;
    state.player.stop(true);
    await interaction.reply("⏭️ 現在の曲をスキップしました。");
    return;
  }
  state.queue.length = 0;
  state.loop = false;
  state.skipRequested = true;
  state.player?.stop(true);
  state.current = null;
  await interaction.reply("⏹️ 音楽を停止し、キューを消去しました。");
}

async function handleTtsCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使用してください。",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  const text = interaction.options.getString("text", true).trim();
  if (!text) {
    await interaction.reply({
      content: "読み上げる文章を入力してください。",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const member = await guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel) {
    await interaction.editReply("先にボイスチャンネルへ参加してください。");
    return;
  }

  try {
    await enqueuePlayback(guild.id, async () => {
      const job = await api.createTtsJob(
        {
          guildId: guild.id,
          requesterId: interaction.user.id,
          text,
        },
        interaction.id,
      );
      await interaction.editReply("🗣️ 読み上げ音声を準備しています…");
      const audio = await waitForAudio(
        job.jobId,
        guild.id,
        interaction.user.id,
      );
      await playAudio(
        voiceChannel.id,
        guild.id,
        guild.voiceAdapterCreator,
        audio,
      );
      await interaction.editReply("🔊 読み上げました。");
    });
  } catch (error) {
    reportError(error);
    await interaction.editReply(userError(error));
  }
}

async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.reply({
    content: [
      "**Voice Bot コマンド一覧**",
      "`/ping` Botの応答速度を確認",
      "`/join` 自分が参加中のVCへBotを呼ぶ",
      "`/leave` BotをVCから退出させる",
      "`/stop` 再生中の読み上げを停止",
      "`/tts text:<文章>` 参加中のボイスチャンネルで読み上げ",
      "`/music-play url:<URL>` 音楽をキューに追加（プレイリスト対応）",
      "`/music-play query:<検索語>` YouTube検索から再生",
      "`/music-queue` 音楽キューを表示",
      "`/music-pause` / `/music-resume` 一時停止・再開",
      "`/music-skip` / `/music-stop` スキップ・停止",
      "`/music-loop enabled:<true|false>` ループ再生",
      "`/music-effect effect:<種類>` Bass Boost・Nightcore・Vaporwave・8D",
      "`/music-volume percent:<0〜200>` 音量設定",
      "`/music-shuffle` / `/music-remove` / `/music-clear` キュー管理",
      "`/music-now-playing` 現在曲と再生設定を表示",
      "`/music-ranking days:<日数>` サーバー内の再生ランキング",
      "`/music-favorite-add` / `/music-favorites` / `/music-favorite-remove` お気に入り管理",
      "`/music-playlist-save` / `/music-playlist-list` / `/music-playlist-play` プレイリスト管理",
    ].join("\n"),
    ephemeral: true,
  });
}

async function handleVoiceControlCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使用してください。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "leave") {
    activePlayers.get(interaction.guild.id)?.stop(true);
    activePlayers.delete(interaction.guild.id);
    const connection = voiceConnections.get(interaction.guild.id);
    if (!connection) {
      await interaction.reply({
        content: "Botはボイスチャンネルに参加していません。",
        ephemeral: true,
      });
      return;
    }
    connection.destroy();
    voiceConnections.delete(interaction.guild.id);
    await interaction.reply("ボイスチャンネルから退出しました。");
    return;
  }
  if (interaction.commandName === "stop") {
    const player = activePlayers.get(interaction.guild.id);
    if (!player) {
      await interaction.reply({
        content: "再生中の読み上げはありません。",
        ephemeral: true,
      });
      return;
    }
    player.stop(true);
    activePlayers.delete(interaction.guild.id);
    await interaction.reply("読み上げを停止しました。");
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!member.voice.channel) {
    await interaction.reply({
      content: "先にボイスチャンネルへ参加してください。",
      ephemeral: true,
    });
    return;
  }
  voiceConnections.get(interaction.guild.id)?.destroy();
  const connection = joinVoiceChannel({
    channelId: member.voice.channel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    voiceConnections.set(interaction.guild.id, connection);
    await interaction.reply(`🔊 ${member.voice.channel} に参加しました。`);
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

async function handleVcAdminCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.guild ||
    !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
  ) {
    await interaction.reply({
      content: "VC管理にはチャンネル管理権限が必要です。",
      ephemeral: true,
    });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const source = member.voice.channel;
  if (!source || source.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "先に操作対象のボイスチャンネルへ参加してください。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.commandName === "vc-lock") {
    await source.permissionOverwrites.edit(
      interaction.guild.roles.everyone,
      { Connect: false },
      { reason: `${interaction.user.tag} によるVCロック` },
    );
    await interaction.reply("🔒 VCをロックしました。");
    return;
  }
  if (interaction.commandName === "vc-limit") {
    const limit = interaction.options.getInteger("limit", true);
    await source.setUserLimit(limit);
    await interaction.reply(
      `👥 VCの人数制限を${limit === 0 ? "無制限" : `${limit}人`}にしました。`,
    );
    return;
  }
  if (interaction.commandName === "vc-move") {
    const target = interaction.guild.channels.cache.get(
      interaction.options.getChannel("channel", true).id,
    );
    if (!target || target.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: "移動先は通常のVCを指定してください。",
        ephemeral: true,
      });
      return;
    }
    await Promise.all(
      [...source.members.values()]
        .filter((voiceMember) => !voiceMember.user.bot)
        .map((voiceMember) => voiceMember.voice.setChannel(target)),
    );
    await interaction.reply(
      `🚚 ${source.name} の参加者を ${target.name} へ移動しました。`,
    );
    return;
  }
  const members = [...source.members.values()].filter(
    (voiceMember) => !voiceMember.user.bot,
  );
  await interaction.reply({
    content: `📊 **${source.name}**\n参加者: ${members.length}人\n${members.map((voiceMember) => `• ${voiceMember.displayName}`).join("\n") || "参加者はいません。"}`,
    ephemeral: true,
  });
}

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "help") {
    void handleHelpCommand(interaction).catch((error: unknown) =>
      reportError(error),
    );
    return;
  }
  if (interaction.commandName === "ping") {
    void interaction
      .reply(`🏓 Pong! WebSocket: ${Math.max(0, Math.round(client.ws.ping))}ms`)
      .catch((error: unknown) => reportError(error));
    return;
  }
  if (
    interaction.commandName === "join" ||
    interaction.commandName === "leave" ||
    interaction.commandName === "stop"
  ) {
    void handleVoiceControlCommand(interaction).catch((error: unknown) => {
      reportError(error);
      const message =
        error instanceof Error && error.message === "voice_connection_timeout"
          ? "ボイスチャンネルに接続できませんでした。Botの権限をご確認ください。"
          : "ボイスチャンネル操作に失敗しました。";
      if (interaction.deferred || interaction.replied)
        void interaction.editReply(message);
      else void interaction.reply({ content: message, ephemeral: true });
    });
    return;
  }
  if (
    ["vc-lock", "vc-limit", "vc-move", "vc-stats"].includes(
      interaction.commandName,
    )
  ) {
    void handleVcAdminCommand(interaction).catch((error: unknown) => {
      reportError(error);
      if (interaction.deferred || interaction.replied)
        void interaction.editReply("VC操作に失敗しました。");
      else
        void interaction.reply({
          content: "VC操作に失敗しました。",
          ephemeral: true,
        });
    });
    return;
  }
  if (interaction.commandName.startsWith("music-")) {
    void handleMusicCommand(interaction).catch((error: unknown) => {
      reportError(error);
      const message =
        error instanceof Error && error.message === "voice_channel_required"
          ? "先にボイスチャンネルへ参加してください。"
          : "音楽操作に失敗しました。URLとBotの接続権限をご確認ください。";
      if (interaction.deferred || interaction.replied)
        void interaction.editReply(message);
      else void interaction.reply({ content: message, ephemeral: true });
    });
    return;
  }
  if (interaction.commandName !== "tts") return;
  void handleTtsCommand(interaction).catch((error: unknown) => {
    reportError(error);
    if (interaction.deferred || interaction.replied) {
      void interaction
        .editReply(userError(error))
        .catch((replyError: unknown) => reportError(replyError));
    } else {
      void interaction
        .reply({ content: userError(error), ephemeral: true })
        .catch((replyError: unknown) => reportError(replyError));
    }
  });
});

client.once(Events.ClientReady, (readyClient) => {
  presence.start();
  void sendHeartbeat().catch((error: unknown) => reportError(error));
  const heartbeat = setInterval(
    () => void sendHeartbeat().catch((error: unknown) => reportError(error)),
    30_000,
  );
  heartbeat.unref?.();
  console.info(`Voice Bot ready as ${readyClient.user.tag}`);
  void registerCommands(readyClient.application.id, [
    ...readyClient.guilds.cache.keys(),
  ])
    .then(() => {
      console.info(
        `Registered Voice Bot commands for ${readyClient.guilds.cache.size} guilds`,
      );
    })
    .catch((error: unknown) => reportError(error));
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
  presence.stop();
  await client.destroy();
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    presence.stop();
    for (const state of musicStates.values()) {
      state.queue.length = 0;
      state.player?.stop(true);
    }
    musicStates.clear();
    for (const connection of voiceConnections.values()) connection.destroy();
    voiceConnections.clear();
    client.destroy();
  });
}
