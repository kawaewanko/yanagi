CREATE TABLE IF NOT EXISTS voice_sessions (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_sessions_active_idx ON voice_sessions (guild_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS voice_sessions_leaderboard_idx ON voice_sessions (guild_id, user_id, duration_seconds DESC);
