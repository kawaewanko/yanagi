CREATE TABLE IF NOT EXISTS admin_session_guilds (
  session_id TEXT NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  guild_name TEXT NOT NULL,
  PRIMARY KEY (session_id, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_session_guilds_guild
  ON admin_session_guilds(guild_id, session_id);
