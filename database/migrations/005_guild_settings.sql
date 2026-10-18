CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY REFERENCES guilds(guild_id) ON DELETE CASCADE,
  welcome_channel_id TEXT CHECK (welcome_channel_id IS NULL OR welcome_channel_id ~ '^[0-9]{1,32}$'),
  waiting_voice_channel_id TEXT CHECK (waiting_voice_channel_id IS NULL OR waiting_voice_channel_id ~ '^[0-9]{1,32}$'),
  temporary_voice_category_id TEXT CHECK (temporary_voice_category_id IS NULL OR temporary_voice_category_id ~ '^[0-9]{1,32}$'),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
