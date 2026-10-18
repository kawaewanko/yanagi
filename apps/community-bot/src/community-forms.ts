import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";

type FormConfig = {
  introChannelId: string | null;
  serverRegisterChannelId: string | null;
};

export class CommunityForms {
  constructor(private readonly config: FormConfig) {}

  async show(interaction: ChatInputCommandInteraction): Promise<void> {
    if (interaction.commandName === "self-intro") {
      const modal = new ModalBuilder()
        .setCustomId("yanagi-form:self-intro")
        .setTitle("自己紹介");
      const introduction = new TextInputBuilder()
        .setCustomId("introduction")
        .setLabel("自己紹介文")
        .setPlaceholder("名前、趣味、ひとことなど")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(introduction),
      );
      await interaction.showModal(modal);
      return;
    }
    if (interaction.commandName === "server-register") {
      const modal = new ModalBuilder()
        .setCustomId("yanagi-form:server-register")
        .setTitle("サーバーを登録");
      const invite = new TextInputBuilder()
        .setCustomId("invite")
        .setLabel("招待リンク")
        .setPlaceholder("https://discord.gg/xxxxx")
        .setStyle(TextInputStyle.Short)
        .setMaxLength(200)
        .setRequired(true);
      const announcement = new TextInputBuilder()
        .setCustomId("announcement")
        .setLabel("宣伝文")
        .setPlaceholder("サーバーの紹介文を入力してください")
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(invite),
        new ActionRowBuilder<TextInputBuilder>().addComponents(announcement),
      );
      await interaction.showModal(modal);
    }
  }

  async handle(interaction: ModalSubmitInteraction): Promise<void> {
    const isIntro = interaction.customId === "yanagi-form:self-intro";
    const isServerRegister =
      interaction.customId === "yanagi-form:server-register";
    if (!isIntro && !isServerRegister) return;
    const configuredChannelId = isIntro
      ? this.config.introChannelId
      : this.config.serverRegisterChannelId;
    const channel = configuredChannelId
      ? await interaction.guild?.channels.fetch(configuredChannelId)
      : interaction.channel;
    if (!channel?.isTextBased() || !channel.isSendable()) {
      await interaction.reply({
        content: "投稿先チャンネルが設定されていないか、投稿権限がありません。",
        ephemeral: true,
      });
      return;
    }
    if (isIntro) {
      const introduction = interaction.fields
        .getTextInputValue("introduction")
        .trim();
      await channel.send({
        content: `👋 **${interaction.user.displayName} さんの自己紹介**\n${introduction}`,
        allowedMentions: { parse: [] },
      });
      await interaction.reply({
        content: "自己紹介を投稿しました。",
        ephemeral: true,
      });
      return;
    }
    const invite = interaction.fields.getTextInputValue("invite").trim();
    const announcement = interaction.fields
      .getTextInputValue("announcement")
      .trim();
    if (!/^https?:\/\/discord\.gg\/[A-Za-z0-9_-]+$/.test(invite)) {
      await interaction.reply({
        content: "Discord招待リンクの形式が正しくありません。",
        ephemeral: true,
      });
      return;
    }
    await channel.send({
      content: `📣 **サーバー登録**\n${announcement}\n${invite}`,
      allowedMentions: { parse: [] },
    });
    await interaction.reply({
      content: "サーバー登録を投稿しました。",
      ephemeral: true,
    });
  }
}
