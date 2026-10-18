CREATE TABLE bot_status (
  service TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE music_play_history (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  effect TEXT NOT NULL DEFAULT 'none',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started'
);

CREATE INDEX music_play_history_started_idx ON music_play_history (started_at DESC);
CREATE INDEX music_play_history_guild_idx ON music_play_history (guild_id, started_at DESC);
