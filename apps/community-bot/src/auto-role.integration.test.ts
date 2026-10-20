import type { GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { assignAutoRoleIfAllowed } from "./auto-role.js";

function discordMember(options?: {
  role?: { id: string } | null;
  fetchError?: Error;
  addError?: Error;
}) {
  const fetch = vi.fn(async () => {
    if (options?.fetchError) throw options.fetchError;
    return options?.role ?? { id: "role-auto" };
  });
  const add = vi.fn(async () => {
    if (options?.addError) throw options.addError;
  });
  return {
    member: {
      id: "123456789012345678",
      guild: {
        id: "guild-production-like",
        roles: { fetch },
      },
      roles: { cache: new Map(), add },
    } as unknown as GuildMember,
    fetch,
    add,
  };
}

describe("auto-role Discord-like integration", () => {
  it("assigns a fetched role for a new member in a production-like guild", async () => {
    const { member, fetch, add } = discordMember({ role: { id: "role-auto" } });

    await expect(
      assignAutoRoleIfAllowed(member, "role-auto", new Set()),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith("role-auto");
    expect(add).toHaveBeenCalledWith(
      { id: "role-auto" },
      "夜凪鯖の参加時自動ロール付与",
    );
  });

  it("returns a contextual error when Discord role fetch is denied", async () => {
    const { member, add } = discordMember({
      fetchError: new Error("Missing Access"),
    });

    await expect(
      assignAutoRoleIfAllowed(member, "role-auto", new Set()),
    ).rejects.toThrow("auto_role_fetch_failed:role-auto");
    expect(add).not.toHaveBeenCalled();
  });

  it("returns a contextual error when Discord rejects role assignment", async () => {
    const { member, add } = discordMember({
      addError: new Error("Missing Permissions"),
    });

    await expect(
      assignAutoRoleIfAllowed(member, "role-auto", new Set()),
    ).rejects.toThrow("auto_role_assign_failed:role-auto");
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("does not call Discord role APIs for a blacklisted member", async () => {
    const { member, fetch, add } = discordMember();

    await expect(
      assignAutoRoleIfAllowed(
        member,
        "role-auto",
        new Set(["123456789012345678"]),
      ),
    ).resolves.toBe(false);

    expect(fetch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
