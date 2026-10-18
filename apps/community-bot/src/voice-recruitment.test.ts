import { describe, expect, it, vi } from "vitest";
import { VoiceRecruitmentManager } from "./voice-recruitment.js";

describe("VoiceRecruitmentManager", () => {
  it("rejects invalid participant counts without posting", async () => {
    const send = vi.fn();
    const reply = vi.fn();
    const manager = new VoiceRecruitmentManager({
      roleId: null,
      idFactory: () => "recruit-1",
    });
    const interaction: any = {
      customId: "yanagi-vc-recruit:create:voice-1",
      guildId: "guild-1",
      channelId: "text-1",
      channel: { isTextBased: () => true, send },
      fields: {
        getTextInputValue: (key: string) =>
          ({
            title: "募集",
            activity: "ゲーム",
            participants: "1",
            duration: "60",
          })[key] ?? "",
      },
      user: { id: "user-1" },
      reply,
    };
    await manager.handleModal(interaction);
    expect(send).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("posts a recruitment with the creator already joined", async () => {
    const message = { id: "message-1" };
    const send = vi.fn(async () => message);
    const reply = vi.fn();
    const manager = new VoiceRecruitmentManager({
      roleId: null,
      idFactory: () => "recruit-1",
      now: () => 0,
    });
    const interaction: any = {
      customId: "yanagi-vc-recruit:create:voice-1",
      guildId: "guild-1",
      channelId: "text-1",
      channel: { isTextBased: () => true, send },
      fields: {
        getTextInputValue: (key: string) =>
          ({
            title: "募集",
            activity: "ゲーム",
            participants: "5",
            duration: "60",
          })[key] ?? "",
      },
      user: { id: "user-1" },
      reply,
    };
    await manager.handleModal(interaction);
    const calls = send.mock.calls as any[];
    const payload = calls[0][0] as any;
    expect(send).toHaveBeenCalledOnce();
    expect(payload.embeds[0].data.fields[1].value).toContain("1/5人");
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });
});
