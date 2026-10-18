CREATE TABLE voice_guild_settings (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(guild_id) ON DELETE CASCADE,
  auto_mute BOOLEAN NOT NULL DEFAULT FALSE,
  auto_role_id TEXT CHECK (auto_role_id IS NULL OR auto_role_id ~ '^[0-9]{1,32}$'),
  afk_channel_id TEXT CHECK (afk_channel_id IS NULL OR afk_channel_id ~ '^[0-9]{1,32}$'),
  afk_timeout SMALLINT CHECK (afk_timeout IS NULL OR afk_timeout IN (60, 300, 900, 1800, 3600)),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((afk_channel_id IS NULL) = (afk_timeout IS NULL))
);

CREATE TABLE voice_channel_controls (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL CHECK (channel_id ~ '^[0-9]{1,32}$'),
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  lock_original_connect TEXT NOT NULL DEFAULT 'inherit'
    CHECK (lock_original_connect IN ('allow', 'deny', 'inherit')),
  user_limit SMALLINT NOT NULL DEFAULT 0 CHECK (user_limit BETWEEN 0 AND 99),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE voice_stay_sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL CHECK (channel_id ~ '^[0-9]{1,32}$'),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  CHECK (left_at IS NULL OR left_at >= joined_at)
);

CREATE UNIQUE INDEX voice_stay_sessions_active_member_idx
  ON voice_stay_sessions(guild_id, user_id) WHERE left_at IS NULL;
CREATE INDEX voice_stay_sessions_leaderboard_idx
  ON voice_stay_sessions(guild_id, joined_at DESC, user_id);
