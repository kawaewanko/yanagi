import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import {
  CoreApiError,
  type CoreApiClient,
  type Reward,
} from "@yanagi/core-api-client";
import { randomInt } from "node:crypto";

type GameApi = Pick<
  CoreApiClient,
  | "getPointBalance"
  | "claimDaily"
  | "workForPoints"
  | "commitCrime"
  | "getPointLeaderboard"
  | "getPointHistory"
  | "transferPoints"
  | "getPeriodLeaderboard"
  | "getAchievements"
  | "drawFortune"
  | "listRewards"
  | "redeemReward"
  | "createRaffle"
  | "listRaffles"
  | "startRaffle"
  | "enterRaffle"
  | "closeRaffle"
  | "drawRaffle"
  | "redrawRaffle"
  | "getRaffleHistory"
>;

type MiniGameStats = {
  coinflips: number;
  heads: number;
  tails: number;
  diceRolls: number;
  diceSum: number;
  diceMax: number;
  rps: number;
  slots: number;
  eightball: number;
  random: number;
};
const miniGameStats = new Map<string, MiniGameStats>();

function statsFor(guildId: string, userId: string): MiniGameStats {
  const key = `${guildId}:${userId}`;
  const current = miniGameStats.get(key) ?? {
    coinflips: 0,
    heads: 0,
    tails: 0,
    diceRolls: 0,
    diceSum: 0,
    diceMax: 0,
    rps: 0,
    slots: 0,
    eightball: 0,
    random: 0,
  };
  miniGameStats.set(key, current);
  return current;
}

function totalGames(stats: MiniGameStats): number {
  return (
    stats.coinflips +
    stats.diceRolls +
    stats.rps +
    stats.slots +
    stats.eightball +
    stats.random
  );
}

export function gameCommandDefinitions(): Array<
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
> {
  return [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("利用できるコマンド一覧を表示します"),
    new SlashCommandBuilder()
      .setName("ping")
      .setDescription("Botの応答速度を確認します"),
    new SlashCommandBuilder()
      .setName("coinflip")
      .setDescription("コインを投げます"),
    new SlashCommandBuilder()
      .setName("dice")
      .setDescription("サイコロを振ります")
      .addIntegerOption((option) =>
        option
          .setName("sides")
          .setDescription("面数（2〜100、既定は6）")
          .setMinValue(2)
          .setMaxValue(100),
      ),
    new SlashCommandBuilder()
      .setName("rps")
      .setDescription("じゃんけんでBotと勝負します")
      .addStringOption((option) =>
        option
          .setName("choice")
          .setDescription("出す手")
          .setRequired(true)
          .addChoices(
            { name: "グー", value: "rock" },
            { name: "チョキ", value: "scissors" },
            { name: "パー", value: "paper" },
          ),
      ),
    new SlashCommandBuilder()
      .setName("slots")
      .setDescription("スロットを回します"),
    new SlashCommandBuilder()
      .setName("eightball")
      .setDescription("質問にランダムで答えます")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("質問")
          .setRequired(true)
          .setMaxLength(500),
      ),
    new SlashCommandBuilder()
      .setName("random")
      .setDescription("指定範囲からランダムに数字を選びます")
      .addIntegerOption((option) =>
        option
          .setName("min")
          .setDescription("最小値（既定は1）")
          .setMinValue(-1_000_000),
      )
      .addIntegerOption((option) =>
        option
          .setName("max")
          .setDescription("最大値（既定は100）")
          .setMaxValue(1_000_000),
      ),
    new SlashCommandBuilder()
      .setName("game-stats")
      .setDescription("ミニゲームの詳細統計を表示します")
      .addUserOption((option) =>
        option.setName("user").setDescription("対象ユーザー（省略すると自分）"),
      ),
    new SlashCommandBuilder()
      .setName("game-ranking")
      .setDescription("ミニゲームのサーバー内ランキングを表示します")
      .addStringOption((option) =>
        option
          .setName("game")
          .setDescription("集計対象")
          .addChoices(
            { name: "全ゲーム", value: "all" },
            { name: "コイン投げ", value: "coinflip" },
            { name: "サイコロ", value: "dice" },
            { name: "じゃんけん", value: "rps" },
            { name: "スロット", value: "slots" },
            { name: "8ボール", value: "eightball" },
            { name: "数字抽選", value: "random" },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("表示人数（3〜10、既定は10）")
          .setMinValue(3)
          .setMaxValue(10),
      ),
    new SlashCommandBuilder()
      .setName("points")
      .setDescription("現在のポイント残高を表示します"),
    new SlashCommandBuilder()
      .setName("balance")
      .setDescription("現在のポイント残高を表示します"),
    new SlashCommandBuilder()
      .setName("daily")
      .setDescription("1日1回ポイントを受け取ります"),
    new SlashCommandBuilder()
      .setName("leaderboard")
      .setDescription("ポイントランキングを表示します")
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("表示人数（3〜25、既定は10）")
          .setMinValue(3)
          .setMaxValue(25),
      ),
    new SlashCommandBuilder()
      .setName("point-history")
      .setDescription("ポイントの取得・消費履歴を表示します")
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("表示件数")
          .setMinValue(1)
          .setMaxValue(50),
      ),
    new SlashCommandBuilder()
      .setName("point-transfer")
      .setDescription("他のユーザーへポイントを送ります")
      .addUserOption((option) =>
        option.setName("user").setDescription("送付先").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription("送付ポイント")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(1000000),
      ),
    new SlashCommandBuilder()
      .setName("period-leaderboard")
      .setDescription("週間・月間ポイントランキングを表示します")
      .addStringOption((option) =>
        option
          .setName("period")
          .setDescription("期間")
          .setRequired(true)
          .addChoices(
            { name: "週間", value: "week" },
            { name: "月間", value: "month" },
          ),
      )
      .addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("表示人数")
          .setMinValue(3)
          .setMaxValue(25),
      ),
    new SlashCommandBuilder()
      .setName("achievement")
      .setDescription("実績・バッジ一覧を表示します"),
    new SlashCommandBuilder()
      .setName("work")
      .setDescription("働いてポイントを獲得します"),
    new SlashCommandBuilder()
      .setName("crime")
      .setDescription("リスクを取ってポイントを獲得します"),
    new SlashCommandBuilder()
      .setName("fortune")
      .setDescription("今日のおみくじを引きます"),
    new SlashCommandBuilder()
      .setName("rewards")
      .setDescription("交換できる景品一覧を表示します"),
    new SlashCommandBuilder()
      .setName("shop")
      .setDescription("ポイントショップを表示します"),
    new SlashCommandBuilder()
      .setName("redeem")
      .setDescription("ポイントを使って景品を交換します")
      .addIntegerOption((option) =>
        option
          .setName("reward_id")
          .setDescription("景品一覧に表示されるID")
          .setRequired(true)
          .setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("buy")
      .setDescription("ポイントショップの商品を購入します")
      .addIntegerOption((option) =>
        option
          .setName("reward_id")
          .setDescription("商品ID")
          .setRequired(true)
          .setMinValue(1),
      ),
    new SlashCommandBuilder()
      .setName("raffle")
      .setDescription("抽選を管理・参加します")
      .addSubcommand((command) =>
        command
          .setName("create")
          .setDescription("抽選を作成します（サーバー管理権限が必要）")
          .addStringOption((option) =>
            option
              .setName("title")
              .setDescription("抽選名")
              .setRequired(true)
              .setMaxLength(100),
          )
          .addStringOption((option) =>
            option
              .setName("prize")
              .setDescription("景品名")
              .setRequired(true)
              .setMaxLength(200),
          )
          .addIntegerOption((option) =>
            option
              .setName("cost")
              .setDescription("参加費（ポイント）")
              .setRequired(true)
              .setMinValue(0),
          )
          .addIntegerOption((option) =>
            option
              .setName("min_points")
              .setDescription("参加に必要な最低保有ポイント")
              .setMinValue(0),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("list")
          .setDescription("このサーバーの抽選一覧を表示します"),
      )
      .addSubcommand((command) =>
        command
          .setName("start")
          .setDescription(
            "抽選の参加受付を開始します（作成者・サーバー管理権限）",
          )
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          )
          .addIntegerOption((option) =>
            option
              .setName("duration_minutes")
              .setDescription("受付時間（分、省略すると手動終了）")
              .setMinValue(1)
              .setMaxValue(10_080),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("enter")
          .setDescription("抽選に参加します")
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("close")
          .setDescription("参加受付を終了します（作成者・サーバー管理権限）")
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("draw")
          .setDescription("当選者を決定します（作成者・サーバー管理権限）")
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("redraw")
          .setDescription(
            "過去の当選者を除いて再抽選します（作成者・サーバー管理権限）",
          )
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((command) =>
        command
          .setName("history")
          .setDescription("抽選の参加者と結果を表示します")
          .addIntegerOption((option) =>
            option
              .setName("raffle_id")
              .setDescription("抽選ID")
              .setRequired(true)
              .setMinValue(1),
          ),
      ),
  ];
}

const fortuneLabels: Record<string, string> = {
  daikichi: "大吉",
  chukichi: "中吉",
  kichi: "吉",
  shokichi: "小吉",
  suekichi: "末吉",
  kyo: "凶",
};

const raffleStatusLabels: Record<string, string> = {
  draft: "準備中",
  open: "受付中",
  closed: "受付終了",
  drawn: "当選者決定",
};

function rewardDescription(rewards: Reward[]): string {
  if (rewards.length === 0) return "現在交換できる景品はありません。";
  return rewards
    .slice(0, 25)
    .map(
      (reward) =>
        `**${reward.name}**（ID: \`${reward.id}\`） — ${reward.cost} pt\n${reward.description || "説明なし"}`,
    )
    .join("\n\n")
    .slice(0, 4000);
}

function commandError(error: unknown): string {
  if (error instanceof CoreApiError) {
    if (error.code === "already_drawn_today")
      return "おみくじは今日はもう引いています。明日また挑戦してください。";
    if (error.code === "daily_cooldown")
      return "デイリーボーナスは今日は受け取り済みです。";
    if (error.code === "work_cooldown")
      return "次の仕事まで、もう少し待ってください。";
    if (error.code === "crime_cooldown")
      return "次の挑戦まで、もう少し待ってください。";
    if (error.code === "insufficient_points")
      return "ポイントが不足しているため交換できません。";
    if (error.code === "reward_not_found")
      return "指定された景品が見つからないか、現在交換できません。";
    if (error.code === "already_entered_raffle")
      return "この抽選にはすでに参加しています。";
    if (error.code === "raffle_not_open")
      return "この抽選は現在参加を受け付けていません。";
    if (error.code === "raffle_not_found")
      return "指定された抽選が見つかりません。";
    if (error.code === "raffle_has_no_entries")
      return "参加者がいないため抽選できません。";
    if (error.code === "raffle_eligibility_not_met")
      return "この抽選の参加条件を満たしていません。";
    if (error.code === "raffle_role_eligibility_not_met")
      return "必要なロールを持っていないため参加できません。";
    if (error.code === "no_eligible_reroll_winners")
      return "再抽選できる未当選の参加者がいません。";
    if (error.code === "raffle_creator_required")
      return "この操作は抽選作成者のみ実行できます。";
    if (error.code === "raffle_must_be_closed")
      return "抽選を終了してから当選者を決定してください。";
    return "サーバーとの通信に失敗しました。少し待ってから再度お試しください。";
  }
  return "処理中にエラーが発生しました。時間をおいて再度お試しください。";
}

export async function handleGameCommand(
  interaction: ChatInputCommandInteraction,
  api: GameApi,
  reportError: (error: unknown) => void,
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "このコマンドはサーバー内で使用してください。",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (interaction.commandName) {
      case "help": {
        await interaction.reply({
          content: [
            "**Game Bot コマンド一覧**",
            "`/ping` Botの応答速度を確認",
            "`/coinflip` コインを投げる",
            "`/dice sides:<面数>` サイコロを振る",
            "`/rps choice:<手>` じゃんけん",
            "`/slots` スロット",
            "`/eightball question:<質問>` ランダム回答",
            "`/random [min:<最小>] [max:<最大>]` 数字抽選",
            "`/game-stats [user:<ユーザー>]` ミニゲーム統計を表示",
            "`/game-ranking [game:<対象>]` サーバー内ランキングを表示",
            "`/points` ポイント残高を表示",
            "`/balance` ポイント残高を表示",
            "`/daily` 毎日ポイントを受け取る",
            "`/leaderboard` ポイントランキングを表示",
            "`/work` / `/crime` クールダウン付きポイントゲーム",
            "`/fortune` 今日のおみくじを引く",
            "`/rewards` 交換できる景品を表示",
            "`/shop` ポイントショップを表示",
            "`/redeem reward_id:<ID>` 景品を交換",
            "`/buy reward_id:<ID>` ショップの商品を購入",
            "`/raffle` 抽選の作成・参加・運営",
          ].join("\n"),
          ephemeral: true,
        });
        return;
      }
      case "ping": {
        await interaction.reply(
          `🏓 Pong! WebSocket: ${Math.max(0, Math.round(interaction.client.ws.ping))}ms`,
        );
        return;
      }
      case "coinflip": {
        const result = randomInt(0, 2) === 0 ? "表" : "裏";
        const stats = statsFor(interaction.guildId, interaction.user.id);
        stats.coinflips += 1;
        if (result === "表") stats.heads += 1;
        else stats.tails += 1;
        await interaction.reply({
          content: `🪙 コインの結果は **${result}** です！`,
          ephemeral: false,
        });
        return;
      }
      case "dice": {
        const sides = interaction.options.getInteger("sides") ?? 6;
        const result = randomInt(1, sides + 1);
        const stats = statsFor(interaction.guildId, interaction.user.id);
        stats.diceRolls += 1;
        stats.diceSum += result;
        stats.diceMax = Math.max(stats.diceMax, result);
        await interaction.reply({
          content: `🎲 ${sides}面ダイスの結果は **${result}** です！`,
          ephemeral: false,
        });
        return;
      }
      case "rps": {
        const choice = interaction.options.getString("choice", true);
        const hands = ["rock", "scissors", "paper"] as const;
        const bot = hands[randomInt(0, hands.length)];
        const labels = { rock: "グー", scissors: "チョキ", paper: "パー" };
        const result =
          choice === bot
            ? "あいこ"
            : hands[
                  (hands.indexOf(choice as (typeof hands)[number]) + 1) % 3
                ] === bot
              ? "勝ち"
              : "負け";
        statsFor(interaction.guildId, interaction.user.id).rps += 1;
        await interaction.reply(
          `✊ あなた: **${labels[choice as keyof typeof labels]}** / Bot: **${labels[bot]}** — **${result}**！`,
        );
        return;
      }
      case "slots": {
        const symbols = ["🍒", "🍋", "🔔", "⭐", "💎"];
        const result = Array.from(
          { length: 3 },
          () => symbols[randomInt(0, symbols.length)],
        );
        const won = result.every((symbol) => symbol === result[0]);
        statsFor(interaction.guildId, interaction.user.id).slots += 1;
        await interaction.reply(
          `🎰 ${result.join(" | ")}\n${won ? "大当たり！" : "もう一度挑戦してみてください。"}`,
        );
        return;
      }
      case "eightball": {
        const answers = [
          "はい、きっとそうです。",
          "たぶんそうです。",
          "まだ分かりません。",
          "今はやめておくのがよさそうです。",
          "いいえ、難しそうです。",
        ];
        statsFor(interaction.guildId, interaction.user.id).eightball += 1;
        await interaction.reply(`🎱 ${answers[randomInt(0, answers.length)]}`);
        return;
      }
      case "random": {
        const min = interaction.options.getInteger("min") ?? 1;
        const max = interaction.options.getInteger("max") ?? 100;
        if (min > max) {
          await interaction.reply({
            content: "最小値は最大値以下にしてください。",
            ephemeral: true,
          });
          return;
        }
        statsFor(interaction.guildId, interaction.user.id).random += 1;
        await interaction.reply(
          `🔢 ${min}〜${max} の抽選結果: **${randomInt(min, max + 1)}**`,
        );
        return;
      }
      case "game-stats": {
        const user = interaction.options.getUser("user") ?? interaction.user;
        const stats = miniGameStats.get(`${interaction.guildId}:${user.id}`);
        if (!stats || totalGames(stats) === 0) {
          await interaction.reply({
            content: `${user.username} のミニゲーム記録はまだありません。`,
            ephemeral: true,
          });
          return;
        }
        const headRate = stats.coinflips
          ? ((stats.heads / stats.coinflips) * 100).toFixed(1)
          : "0.0";
        const diceAverage = stats.diceRolls
          ? (stats.diceSum / stats.diceRolls).toFixed(2)
          : "0.00";
        await interaction.reply({
          content: [
            `📈 **${user.username} のミニゲーム統計**`,
            `総プレイ数: **${totalGames(stats)}**回`,
            `コイン投げ: ${stats.coinflips}回（表 ${stats.heads} / 裏 ${stats.tails}、表率 ${headRate}%）`,
            `サイコロ: ${stats.diceRolls}回（平均 ${diceAverage}、最高 ${stats.diceMax}）`,
            `じゃんけん: ${stats.rps}回 / スロット: ${stats.slots}回 / 8ボール: ${stats.eightball}回 / 数字抽選: ${stats.random}回`,
          ].join("\n"),
          ephemeral: true,
        });
        return;
      }
      case "game-ranking": {
        const game = interaction.options.getString("game") ?? "all";
        const limit = interaction.options.getInteger("limit") ?? 10;
        const prefix = `${interaction.guildId}:`;
        const scoreOf = (stats: MiniGameStats): number =>
          game === "all"
            ? totalGames(stats)
            : game === "coinflip"
              ? stats.coinflips
              : game === "dice"
                ? stats.diceRolls
                : stats[game as "rps" | "slots" | "eightball" | "random"];
        const entries = [...miniGameStats.entries()]
          .filter(
            ([key, stats]) => key.startsWith(prefix) && scoreOf(stats) > 0,
          )
          .map(([key, stats]) => ({
            userId: key.slice(prefix.length),
            stats,
            score: scoreOf(stats),
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, limit);
        if (entries.length === 0) {
          await interaction.reply({
            content: "まだミニゲームの記録がありません。",
            ephemeral: true,
          });
          return;
        }
        const lines = await Promise.all(
          entries.map(async (entry, index) => {
            const member = await interaction.guild?.members
              .fetch(entry.userId)
              .catch(() => null);
            return `${index + 1}. ${member?.user ?? `<@${entry.userId}>`} — **${entry.score}回**`;
          }),
        );
        const gameLabels: Record<string, string> = {
          all: "全ゲーム",
          coinflip: "コイン投げ",
          dice: "サイコロ",
          rps: "じゃんけん",
          slots: "スロット",
          eightball: "8ボール",
          random: "数字抽選",
        };
        await interaction.reply({
          content: `🏆 **ミニゲームランキング（${gameLabels[game] ?? "全ゲーム"}）**\n${lines.join("\n")}`,
          ephemeral: false,
        });
        return;
      }
      case "points":
      case "balance": {
        const balance = await api.getPointBalance(
          interaction.guildId,
          interaction.user.id,
        );
        await interaction.reply({
          content: `現在の残高は **${balance.points} ポイント**です。`,
          ephemeral: true,
        });
        return;
      }
      case "daily": {
        const result = await api.claimDaily(
          interaction.guildId,
          interaction.user.id,
        );
        await interaction.reply(
          `🎁 デイリーボーナスとして **${result.awarded}ポイント**獲得しました！`,
        );
        return;
      }
      case "leaderboard": {
        const entries = await api.getPointLeaderboard(
          interaction.guildId,
          interaction.options.getInteger("limit") ?? 10,
        );
        await interaction.reply({
          content: entries.length
            ? entries
                .map(
                  (entry) =>
                    `${entry.rank}. <@${entry.userId}> — **${entry.points} pt**`,
                )
                .join("\n")
            : "ランキング対象者がいません。",
          ephemeral: true,
        });
        return;
      }
      case "point-history": {
        const items = await api.getPointHistory(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getInteger("limit") ?? 20,
        );
        await interaction.reply({
          content: items.length
            ? items
                .map(
                  (item) =>
                    `${item.amount >= 0 ? "➕" : "➖"} **${item.amount} pt** — ${item.reason} (<t:${Math.floor(new Date(item.createdAt).getTime() / 1000)}:R>)`,
                )
                .join("\n")
            : "ポイント履歴はありません。",
          ephemeral: true,
        });
        return;
      }
      case "point-transfer": {
        const user = interaction.options.getUser("user", true);
        const amount = interaction.options.getInteger("amount", true);
        const result = await api.transferPoints(
          interaction.guildId,
          interaction.user.id,
          user.id,
          amount,
        );
        await interaction.reply({
          content: `🎁 <@${user.id}> へ **${result.transferred}ポイント**送付しました。`,
          ephemeral: true,
        });
        return;
      }
      case "period-leaderboard": {
        const period = interaction.options.getString("period", true) as
          | "week"
          | "month";
        const entries = await api.getPeriodLeaderboard(
          interaction.guildId,
          period,
          interaction.options.getInteger("limit") ?? 10,
        );
        await interaction.reply({
          content: entries.length
            ? `${period === "week" ? "週間" : "月間"}ランキング\n${entries.map((entry) => `${entry.rank}. <@${entry.userId}> — **${entry.points} pt**`).join("\n")}`
            : "ランキング対象者がいません。",
          ephemeral: true,
        });
        return;
      }
      case "achievement": {
        const items = await api.getAchievements(
          interaction.guildId,
          interaction.user.id,
        );
        await interaction.reply({
          content: items.length
            ? items
                .map(
                  (item) =>
                    `${item.earnedAt ? "✅" : "⬜"} ${item.badge} **${item.name}** — ${item.description}${item.earnedAt ? ` (<t:${Math.floor(new Date(item.earnedAt).getTime() / 1000)}:d>)` : ""}`,
                )
                .join("\n")
            : "実績はありません。",
          ephemeral: true,
        });
        return;
      }
      case "work": {
        const result = await api.workForPoints(
          interaction.guildId,
          interaction.user.id,
        );
        await interaction.reply(
          `💼 仕事をして **${result.awarded}ポイント**獲得しました！`,
        );
        return;
      }
      case "crime": {
        const result = await api.commitCrime(
          interaction.guildId,
          interaction.user.id,
        );
        await interaction.reply(
          result.success
            ? `🕶️ 犯行成功！ **${result.awarded}ポイント**獲得しました。`
            : "🚓 犯行に失敗しました。今回はポイントを獲得できませんでした。",
        );
        return;
      }
      case "fortune": {
        const result = await api.drawFortune(
          interaction.guildId,
          interaction.user.id,
          interaction.id,
        );
        await interaction.reply({
          content: `今日のおみくじは **${fortuneLabels[result.result] ?? result.result}**！${result.points}ポイント獲得しました。`,
          ephemeral: true,
        });
        return;
      }

      case "rewards": {
        const rewards = await api.listRewards(interaction.guildId);
        const embed = new EmbedBuilder()
          .setTitle("交換できる景品")
          .setDescription(rewardDescription(rewards))
          .setColor(0x5865f2);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }
      case "shop": {
        const rewards = await api.listRewards(interaction.guildId);
        await interaction.reply({
          content: rewardDescription(rewards),
          ephemeral: true,
        });
        return;
      }
      case "buy":
      case "redeem": {
        const rewardId = interaction.options.getInteger("reward_id", true);
        const redemption = await api.redeemReward(
          String(rewardId),
          interaction.guildId,
          interaction.user.id,
          interaction.id,
        );
        await interaction.reply({
          content: `景品を交換しました（交換番号: \`${redemption.redemptionId}\`、${redemption.cost}ポイント）。`,
          ephemeral: true,
        });
        return;
      }
      case "raffle": {
        const subcommand = interaction.options.getSubcommand();
        const raffleId = interaction.options.getInteger("raffle_id");
        const isManagementAction = [
          "create",
          "start",
          "close",
          "draw",
          "redraw",
        ].includes(subcommand);
        if (
          isManagementAction &&
          !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        ) {
          await interaction.reply({
            content: "この操作にはサーバー管理権限が必要です。",
            ephemeral: true,
          });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        if (subcommand === "create") {
          const raffle = await api.createRaffle(
            {
              guildId: interaction.guildId,
              createdBy: interaction.user.id,
              title: interaction.options.getString("title", true),
              prize: { name: interaction.options.getString("prize", true) },
              entryCost: interaction.options.getInteger("cost", true),
              eligibility: {
                minPoints: interaction.options.getInteger("min_points") ?? 0,
              },
            },
            interaction.id,
          );
          await interaction.editReply(
            `抽選「${raffle.title}」を作成しました（ID: \`${raffle.raffleId}\`）。開始するには \`/raffle start\` を実行してください。`,
          );
          return;
        }
        if (subcommand === "list") {
          const raffles = await api.listRaffles(interaction.guildId);
          const description = raffles.length
            ? raffles
                .map(
                  (raffle) =>
                    `**${raffle.title}**（ID: \`${raffle.raffleId}\`、${raffleStatusLabels[raffle.status] ?? raffle.status}） — ${raffle.entryCost} pt\n景品: ${String(raffle.prize.name ?? "景品")}`,
                )
                .join("\n\n")
                .slice(0, 4000)
            : "抽選はまだありません。";
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle("抽選一覧")
                .setDescription(description)
                .setColor(0x5865f2),
            ],
          });
          return;
        }
        if (subcommand === "enter") {
          const roleIds =
            interaction.member &&
            "roles" in interaction.member &&
            interaction.member.roles &&
            "cache" in interaction.member.roles
              ? [...interaction.member.roles.cache.keys()]
              : [];
          const entry = await api.enterRaffle(
            String(raffleId),
            interaction.guildId,
            interaction.user.id,
            interaction.id,
            roleIds,
          );
          await interaction.editReply(
            `抽選に参加しました。参加費として ${entry.cost} ポイントを使用しました。`,
          );
          return;
        }
        if (subcommand === "start") {
          const durationMinutes =
            interaction.options.getInteger("duration_minutes");
          await api.startRaffle(
            String(raffleId),
            {
              guildId: interaction.guildId,
              actorId: interaction.user.id,
              ...(durationMinutes !== null ? { durationMinutes } : {}),
            },
            interaction.id,
          );
          await interaction.editReply(
            `抽選 \`${raffleId}\` の受付を開始しました。`,
          );
          return;
        }
        if (subcommand === "close") {
          await api.closeRaffle(
            String(raffleId),
            interaction.guildId,
            interaction.user.id,
            interaction.id,
          );
          await interaction.editReply(
            `抽選 \`${raffleId}\` の受付を終了しました。`,
          );
          return;
        }
        if (subcommand === "draw" || subcommand === "redraw") {
          const result =
            subcommand === "draw"
              ? await api.drawRaffle(
                  String(raffleId),
                  interaction.guildId,
                  interaction.user.id,
                  interaction.id,
                )
              : await api.redrawRaffle(
                  String(raffleId),
                  interaction.guildId,
                  interaction.user.id,
                  interaction.id,
                );
          void interaction.client.users
            .fetch(result.winnerId)
            .then((winner) =>
              winner.send(
                `🎉 抽選「${String(result.prize.name ?? "景品")}」に当選しました！\nサーバー: ${interaction.guild?.name ?? interaction.guildId}`,
              ),
            )
            .catch((error: unknown) => reportError(error));
          await interaction.editReply(
            `🎉 当選者は <@${result.winnerId}> です！景品: **${String(result.prize.name ?? "景品")}**`,
          );
          return;
        }
        if (subcommand === "history") {
          const history = await api.getRaffleHistory(
            String(raffleId),
            interaction.guildId,
          );
          const entrants = history.entries.length
            ? history.entries.map((entry) => `<@${entry.userId}>`).join(", ")
            : "参加者なし";
          const winners = history.results.length
            ? history.results
                .map(
                  (result) => `第${result.drawNumber}回: <@${result.userId}>`,
                )
                .join("\n")
            : "抽選結果なし";
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setTitle(history.raffle.title)
                .setDescription(
                  `参加者（${history.entries.length}人）: ${entrants}\n\n当選履歴:\n${winners}`.slice(
                    0,
                    4000,
                  ),
                )
                .setColor(0x5865f2),
            ],
          });
          return;
        }
        await interaction.editReply("未対応の抽選コマンドです。");
        return;
      }
      default:
        await interaction.reply({
          content: "未対応のコマンドです。",
          ephemeral: true,
        });
    }
  } catch (error) {
    reportError(error);
    const message = commandError(error);
    if (interaction.deferred || interaction.replied)
      await interaction.editReply({ content: message });
    else await interaction.reply({ content: message, ephemeral: true });
  }
}
