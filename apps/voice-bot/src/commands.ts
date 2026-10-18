import {
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";

export type VoiceBotMode = "all" | "tts" | "music";

export function voiceCommandDefinitions(
  mode: VoiceBotMode = "all",
): SlashCommandOptionsOnlyBuilder[] {
  const commands = [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("利用できるコマンド一覧を表示します"),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Botの応答速度を確認します"),
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("自分が参加中のボイスチャンネルへBotを呼びます"),
    new SlashCommandBuilder()
      .setName("vc-lock")
      .setDescription("現在のVCへの新規入室を制限します"),
    new SlashCommandBuilder()
      .setName("vc-limit")
      .setDescription("現在のVCの人数制限を設定します")
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("人数（0で無制限）")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(99),
      ),
    new SlashCommandBuilder()
      .setName("vc-move")
      .setDescription("現在のVC参加者を別のVCへ移動します")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("移動先VC").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("vc-stats")
      .setDescription("現在のVC参加者統計を表示します"),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Botをボイスチャンネルから退出させます"),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("再生中の読み上げを停止します"),
    new SlashCommandBuilder()
      .setName("tts")
      .setDescription("参加中のボイスチャンネルで文章を読み上げます")
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription("読み上げる文章（最大500文字）")
          .setRequired(true)
          .setMaxLength(500),
      ),
    new SlashCommandBuilder()
      .setName("music-play")
      .setDescription("音源URL・プレイリスト・検索語をキューへ追加します")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("音源URLまたはYouTubeプレイリストURL")
          .setRequired(false)
          .setMaxLength(500),
      )
      .addStringOption((option) =>
        option
          .setName("query")
          .setDescription("YouTubeのキーワード検索")
          .setRequired(false)
          .setMaxLength(500),
      ),
    new SlashCommandBuilder()
      .setName("music-queue")
      .setDescription("音楽キューを表示します"),
    new SlashCommandBuilder()
      .setName("music-skip")
      .setDescription("現在の曲をスキップします"),
    new SlashCommandBuilder()
      .setName("music-pause")
      .setDescription("音楽を一時停止します"),
    new SlashCommandBuilder()
      .setName("music-resume")
      .setDescription("音楽を再開します"),
    new SlashCommandBuilder()
      .setName("music-stop")
      .setDescription("音楽を停止してキューを消去します"),
    new SlashCommandBuilder()
      .setName("music-loop")
      .setDescription("現在の曲のループ再生を設定します")
      .addBooleanOption((option) =>
        option
          .setName("enabled")
          .setDescription("ループを有効にするか")
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("music-effect")
      .setDescription("音声エフェクトを設定します")
      .addStringOption((option) =>
        option
          .setName("effect")
          .setDescription("適用するエフェクト")
          .setRequired(true)
          .addChoices(
            { name: "通常", value: "none" },
            { name: "Bass Boost", value: "bassboost" },
            { name: "Nightcore", value: "nightcore" },
            { name: "Vaporwave", value: "vaporwave" },
            { name: "8D", value: "8d" },
          ),
      ),
    new SlashCommandBuilder()
      .setName("music-volume")
      .setDescription("音楽の音量を設定します（次の曲から適用）")
      .addIntegerOption((option) =>
        option
          .setName("percent")
          .setDescription("音量（0〜200%）")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(200),
      ),
    new SlashCommandBuilder()
      .setName("music-shuffle")
      .setDescription("待機中の音楽キューをシャッフルします"),
    new SlashCommandBuilder()
      .setName("music-remove")
      .setDescription("待機中のキューから曲を削除します")
      .addIntegerOption((option) =>
        option
          .setName("position")
          .setDescription("キュー内の位置")
          .setRequired(true)
          .setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("music-clear")
      .setDescription("待機中の音楽キューを消去します"),
    new SlashCommandBuilder()
      .setName("music-now-playing")
      .setDescription("現在の再生曲と設定を表示します"),
    new SlashCommandBuilder()
      .setName("music-ranking")
      .setDescription("サーバー内の音楽再生ランキングを表示します")
      .addIntegerOption((option) =>
        option
          .setName("days")
          .setDescription("集計日数（1〜365）")
          .setRequired(false)
          .setMinValue(1)
          .setMaxValue(365),
      ),
    new SlashCommandBuilder()
      .setName("music-favorite-add")
      .setDescription("現在の曲をお気に入りに登録します"),
    new SlashCommandBuilder()
      .setName("music-favorites")
      .setDescription("お気に入り一覧を表示します"),
    new SlashCommandBuilder()
      .setName("music-favorite-remove")
      .setDescription("お気に入りから曲を削除します")
      .addStringOption((option) =>
        option
          .setName("url")
          .setDescription("削除する曲のURL")
          .setRequired(true)
          .setMaxLength(1000),
      ),
    new SlashCommandBuilder()
      .setName("music-playlist-save")
      .setDescription("現在の曲をプレイリストへ保存します")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("プレイリスト名")
          .setRequired(true)
          .setMaxLength(80),
      ),
    new SlashCommandBuilder()
      .setName("music-playlist-list")
      .setDescription("保存したプレイリスト一覧を表示します"),
    new SlashCommandBuilder()
      .setName("music-playlist-play")
      .setDescription("保存したプレイリストをキューへ追加します")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("プレイリスト名")
          .setRequired(true)
          .setMaxLength(80),
      ),
  ];
  if (mode === "all") return commands;
  const allowed =
    mode === "tts"
      ? new Set([
          "help",
          "ping",
          "join",
          "vc-lock",
          "vc-limit",
          "vc-move",
          "vc-stats",
          "leave",
          "stop",
          "tts",
        ])
      : new Set([
          "help",
          "ping",
          "join",
          "leave",
          "stop",
          "music-play",
          "music-queue",
          "music-skip",
          "music-pause",
          "music-resume",
          "music-stop",
          "music-loop",
          "music-effect",
          "music-volume",
          "music-shuffle",
          "music-remove",
          "music-clear",
          "music-now-playing",
          "music-ranking",
          "music-favorite-add",
          "music-favorites",
          "music-favorite-remove",
          "music-playlist-save",
          "music-playlist-list",
          "music-playlist-play",
        ]);
  return commands.filter((command) => allowed.has(command.name));
}
