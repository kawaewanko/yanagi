import type { GuildMember, Role } from "discord.js";

const DISCORD_USER_ID_PATTERN = /^\d{1,32}$/;

export function parseAutoRoleBlacklist(
  rawValue: string | undefined,
): ReadonlySet<string> {
  return new Set(
    (rawValue ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => DISCORD_USER_ID_PATTERN.test(value)),
  );
}

export function isAutoRoleBlacklisted(
  userId: string,
  blacklist: ReadonlySet<string>,
): boolean {
  return blacklist.has(userId);
}

export async function assignAutoRoleIfAllowed(
  member: GuildMember,
  roleId: string | null,
  blacklist: ReadonlySet<string>,
): Promise<boolean> {
  if (!roleId || isAutoRoleBlacklisted(member.id, blacklist)) return false;
  let role: Role | null;
  try {
    role = await member.guild.roles.fetch(roleId);
  } catch (error) {
    throw new Error(`auto_role_fetch_failed:${roleId}`, { cause: error });
  }
  if (!role) throw new Error(`Configured auto role ${roleId} was not found`);
  if (!member.roles.cache.has(role.id)) {
    try {
      await member.roles.add(role, "夜凪鯖の参加時自動ロール付与");
    } catch (error) {
      throw new Error(`auto_role_assign_failed:${roleId}`, { cause: error });
    }
  }
  return true;
}
