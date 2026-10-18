import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
} from "discord.js";
import type { CoreApiClient, VoiceRecruitment } from "@yanagi/core-api-client";

const CUSTOM_ID_PREFIX = "yanagi-vc-recruit";
const DEFAULT_DURATION_MINUTES = 60;
const MAX_DURATION_MINUTES = 24 * 60;
const MAX_PARTICIPANTS = 99;

type Recruitment = {
  id: string;
  guildId: string;
  postChannelId: string;
  messageId: string;
  voiceChannelId: string;
  creatorId: string;
  title: string;
  activity: string;
  maxParticipants: number;
  expiresAt: number;
  participantIds: string[];
  closed: boolean;
  persistentId?: string;
};

type RecruitmentApi = Pick<
  CoreApiClient,
  | "createVoiceRecruitment"
  | "updateVoiceRecruitmentParticipant"
  | "closeVoiceRecruitment"
>;

export type VoiceRecruitmentConfig = {
  roleId?: string | null;
  now?: () => number;
  idFactory?: () => string;
  api?: RecruitmentApi;
};

export function voiceRecruitmentCommand() {
  return {
    name: "vc-recruit",
    description: "VC参加者を募集します",
  } as const;
}

export class VoiceRecruitmentManager {
  private readonly recruitments = new Map<string, Recruitment>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly roleId: string | null;
  private readonly api?: RecruitmentApi;

  constructor(config: VoiceRecruitmentConfig = {}) {
    this.roleId = config.roleId ?? null;
    this.now = config.now ?? (() => Date.now());
    this.idFactory = config.idFactory ?? (() => crypto.randomUUID());
    this.api = config.api;
  }

  async showCreateModal(
    interaction: ChatInputCommandInteraction,
    voiceChannelId: string,
  ): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:create:${voiceChannelId}`)
      .setTitle("VC募集を作成");
    const title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("募集タイトル")
      .setPlaceholder("例：一緒にゲームしませんか？")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(100)
      .setRequired(true);
    const activity = new TextInputBuilder()
      .setCustomId("activity")
      .setLabel("VCでやること")
      .setPlaceholder("例：雑談、ゲーム、作業通話など")
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(true);
    const participants = new TextInputBuilder()
      .setCustomId("participants")
      .setLabel("募集人数（自分を含む最大人数）")
      .setPlaceholder("例：5")
      .setStyle(TextInputStyle.Short)
      .setMaxLength(2)
      .setRequired(true);
    const duration = new TextInputBuilder()
      .setCustomId("duration")
      .setLabel("募集時間（分、省略可）")
      .setPlaceholder(`例：60（未入力なら${DEFAULT_DURATION_MINUTES}分）`)
      .setStyle(TextInputStyle.Short)
      .setMaxLength(4)
      .setRequired(false);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(title),
      new ActionRowBuilder<TextInputBuilder>().addComponents(activity),
      new ActionRowBuilder<TextInputBuilder>().addComponents(participants),
      new ActionRowBuilder<TextInputBuilder>().addComponents(duration),
    );
    await interaction.showModal(modal);
  }

  async restoreRecruitments(
    records: VoiceRecruitment[],
    client: Client,
  ): Promise<void> {
    for (const record of records) {
      const expiresAt = new Date(record.expiresAt).getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) continue;
      try {
        const channel = await client.channels.fetch(record.postChannelId);
        if (!channel?.isTextBased() || !("messages" in channel)) continue;
        const message = await channel.messages.fetch(record.messageId);
        const recruitment: Recruitment = {
          id: record.recruitmentId,
          persistentId: record.recruitmentId,
          guildId: record.guildId,
          postChannelId: record.postChannelId,
          messageId: record.messageId,
          voiceChannelId: record.voiceChannelId,
          creatorId: record.creatorId,
          title: record.title,
          activity: record.activity,
          maxParticipants: record.maxParticipants,
          expiresAt,
          participantIds: record.participantIds,
          closed: record.status !== "open",
        };
        this.recruitments.set(recruitment.id, recruitment);
        await message.edit({
          embeds: [this.buildEmbed(recruitment)],
          components: [this.buildButtons(recruitment)],
        });
        this.scheduleExpiry(recruitment);
      } catch (error) {
        console.error(
          `[voice-recruitment-persistence] restore failed for ${record.messageId}`,
          error,
        );
      }
    }
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const [, , voiceChannelId] = interaction.customId.split(":");
    const channel = interaction.channel;
    if (
      !voiceChannelId ||
      !interaction.guildId ||
      !channel?.isTextBased() ||
      !("send" in channel)
    ) {
      await interaction.reply({
        content: "この募集はサーバー内のテキストチャンネルで作成してください。",
        ephemeral: true,
      });
      return;
    }
    const maxParticipants = this.parseInteger(
      interaction.fields.getTextInputValue("participants"),
      2,
      MAX_PARTICIPANTS,
    );
    const duration = this.parseInteger(
      interaction.fields.getTextInputValue("duration") ||
        String(DEFAULT_DURATION_MINUTES),
      1,
      MAX_DURATION_MINUTES,
    );
    if (maxParticipants === null || duration === null) {
      await interaction.reply({
        content: `人数は2〜${MAX_PARTICIPANTS}、時間は1〜${MAX_DURATION_MINUTES}分で入力してください。`,
        ephemeral: true,
      });
      return;
    }

    const recruitment: Recruitment = {
      id: this.idFactory(),
      guildId: interaction.guildId,
      postChannelId: interaction.channelId ?? "",
      messageId: "",
      voiceChannelId,
      creatorId: interaction.user.id,
      title: interaction.fields.getTextInputValue("title").trim(),
      activity: interaction.fields.getTextInputValue("activity").trim(),
      maxParticipants,
      expiresAt: this.now() + duration * 60_000,
      participantIds: [interaction.user.id],
      closed: false,
    };
    const message = await channel.send({
      content: this.roleId ? `<@&${this.roleId}>` : undefined,
      embeds: [this.buildEmbed(recruitment)],
      components: [this.buildButtons(recruitment)],
      allowedMentions: this.roleId ? { roles: [this.roleId] } : { parse: [] },
    });
    recruitment.messageId = message.id;
    this.recruitments.set(recruitment.id, recruitment);
    if (this.api) {
      try {
        const stored = await this.api.createVoiceRecruitment({
          guildId: recruitment.guildId,
          postChannelId: recruitment.postChannelId,
          messageId: recruitment.messageId,
          voiceChannelId: recruitment.voiceChannelId,
          creatorId: recruitment.creatorId,
          title: recruitment.title,
          activity: recruitment.activity,
          maxParticipants: recruitment.maxParticipants,
          expiresAt: new Date(recruitment.expiresAt).toISOString(),
        });
        recruitment.persistentId = stored.recruitmentId;
      } catch (error) {
        console.error("[voice-recruitment-persistence] create failed", error);
      }
    }
    this.scheduleExpiry(recruitment);
    await interaction.reply({
      content: `VC募集を投稿しました（${duration}分間）。`,
      ephemeral: true,
    });
  }

  async handleButton(interaction: ButtonInteraction): Promise<void> {
    const [, action, id] = interaction.customId.split(":");
    if (!id) return;
    const recruitment = this.recruitments.get(id);
    if (!recruitment) {
      await interaction.reply({
        content:
          "この募集は終了したか、Botの再起動前に作成されたため操作できません。",
        ephemeral: true,
      });
      return;
    }
    if (this.now() >= recruitment.expiresAt) recruitment.closed = true;
    if (action === "close") {
      if (
        interaction.user.id !== recruitment.creatorId &&
        !interaction.memberPermissions?.has("ManageGuild")
      ) {
        await interaction.reply({
          content: "募集主またはサーバー管理者のみ締め切れます。",
          ephemeral: true,
        });
        return;
      }
      recruitment.closed = true;
      if (this.api && recruitment.persistentId) {
        await this.api.closeVoiceRecruitment(
          recruitment.persistentId,
          recruitment.guildId,
        );
      }
    } else if (recruitment.closed) {
      await interaction.reply({
        content: "この募集は終了しています。",
        ephemeral: true,
      });
      return;
    } else if (action === "join") {
      if (!recruitment.participantIds.includes(interaction.user.id)) {
        if (recruitment.participantIds.length >= recruitment.maxParticipants) {
          await interaction.reply({
            content: "募集人数に達しています。",
            ephemeral: true,
          });
          return;
        }
        recruitment.participantIds.push(interaction.user.id);
        if (this.api && recruitment.persistentId) {
          await this.api.updateVoiceRecruitmentParticipant(
            recruitment.persistentId,
            {
              guildId: recruitment.guildId,
              userId: interaction.user.id,
              action: "join",
            },
          );
        }
      }
    } else if (action === "leave") {
      recruitment.participantIds = recruitment.participantIds.filter(
        (userId) => userId !== interaction.user.id,
      );
      if (this.api && recruitment.persistentId) {
        await this.api.updateVoiceRecruitmentParticipant(
          recruitment.persistentId,
          {
            guildId: recruitment.guildId,
            userId: interaction.user.id,
            action: "leave",
          },
        );
      }
      if (recruitment.participantIds.length === 0) recruitment.closed = true;
    } else {
      return;
    }
    await interaction.update({
      embeds: [this.buildEmbed(recruitment)],
      components: [this.buildButtons(recruitment)],
    });
    if (recruitment.closed) this.clear(recruitment.id);
  }

  private buildEmbed(recruitment: Recruitment): EmbedBuilder {
    const remaining = Math.max(0, recruitment.expiresAt - this.now());
    const status =
      recruitment.closed || remaining === 0
        ? "締切"
        : `${recruitment.participantIds.length}/${recruitment.maxParticipants}人`;
    return new EmbedBuilder()
      .setTitle(`🎙️ ${recruitment.title}`)
      .setDescription(recruitment.activity)
      .addFields(
        {
          name: "募集VC",
          value: `<#${recruitment.voiceChannelId}>`,
          inline: true,
        },
        {
          name: "参加者",
          value: `${status}\n${recruitment.participantIds.map((id) => `<@${id}>`).join("、")}`,
          inline: true,
        },
      )
      .setFooter({
        text: `募集ID: ${recruitment.id} / 募集主: ${recruitment.creatorId}`,
      })
      .setColor(recruitment.closed ? 0x747f8d : 0x5865f2);
  }

  private buildButtons(
    recruitment: Recruitment,
  ): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:join:${recruitment.id}`)
        .setLabel("参加する")
        .setStyle(ButtonStyle.Success)
        .setDisabled(recruitment.closed),
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:leave:${recruitment.id}`)
        .setLabel("参加を取り消す")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(recruitment.closed),
      new ButtonBuilder()
        .setCustomId(`${CUSTOM_ID_PREFIX}:close:${recruitment.id}`)
        .setLabel("募集を締め切る")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(recruitment.closed),
    );
  }

  private scheduleExpiry(recruitment: Recruitment): void {
    const delay = Math.max(1, recruitment.expiresAt - this.now());
    this.timers.set(
      recruitment.id,
      setTimeout(() => {
        const current = this.recruitments.get(recruitment.id);
        if (current) current.closed = true;
        this.timers.delete(recruitment.id);
      }, delay),
    );
  }

  private clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.recruitments.delete(id);
  }

  private parseInteger(value: string, min: number, max: number): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max
      ? parsed
      : null;
  }
}
