import type { GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import {
  assignAutoRoleIfAllowed,
  isAutoRoleBlacklisted,
  parseAutoRoleBlacklist,
} from "./auto-role.js";

function memberFixture(userId: string, existingRoleIds: string[] = []) {
  const fetch = vi.fn();
  const add = vi.fn().mockResolvedValue(undefined);
  const member = {
    id: userId,
    guild: { roles: { fetch } },
    roles: { cache: new Map(existingRoleIds.map((id) => [id, { id }])), add },
  } as unknown as GuildMember;
  return { member, fetch, add };
}

describe("auto-role blacklist", () => {
  it("parses comma-separated Discord user IDs and ignores invalid values", () => {
    const blacklist = parseAutoRoleBlacklist(
      " 123456789012345678,invalid, ,987654321098765432 ",
    );

    expect([...blacklist]).toEqual([
      "123456789012345678",
      "987654321098765432",
    ]);
  });

  it("matches only exact user IDs", () => {
    const blacklist = parseAutoRoleBlacklist("123456789012345678");

    expect(isAutoRoleBlacklisted("123456789012345678", blacklist)).toBe(true);
    expect(isAutoRoleBlacklisted("123456789012345679", blacklist)).toBe(false);
  });

  it("does not fetch or add a role for a blacklisted user", async () => {
    const { member, fetch, add } = memberFixture("123456789012345678");
    const blacklist = parseAutoRoleBlacklist("123456789012345678");

    await expect(
      assignAutoRoleIfAllowed(member, "role-1", blacklist),
    ).resolves.toBe(false);

    expect(fetch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("fetches and adds the configured role for an allowed user", async () => {
    const { member, fetch, add } = memberFixture("123456789012345678");
    const role = { id: "role-1" };
    fetch.mockResolvedValue(role);

    await expect(
      assignAutoRoleIfAllowed(member, "role-1", new Set()),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith("role-1");
    expect(add).toHaveBeenCalledWith(role, "夜凪鯖の参加時自動ロール付与");
  });

  it("does not add a role that the member already has", async () => {
    const { member, fetch, add } = memberFixture("123456789012345678", [
      "role-1",
    ]);
    fetch.mockResolvedValue({ id: "role-1" });

    await expect(
      assignAutoRoleIfAllowed(member, "role-1", new Set()),
    ).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith("role-1");
    expect(add).not.toHaveBeenCalled();
  });

  it("fails clearly when the configured role does not exist", async () => {
    const { member, fetch, add } = memberFixture("123456789012345678");
    fetch.mockResolvedValue(null);

    await expect(
      assignAutoRoleIfAllowed(member, "missing-role", new Set()),
    ).rejects.toThrow("Configured auto role missing-role was not found");
    expect(add).not.toHaveBeenCalled();
  });
});
