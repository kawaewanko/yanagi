CREATE TABLE rss_feeds (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  announcement_channel_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_seconds INTEGER NOT NULL DEFAULT 900 CHECK (interval_seconds BETWEEN 60 AND 604800),
  etag TEXT,
  last_modified TEXT,
  last_polled_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, url)
);

CREATE INDEX rss_feeds_poll_idx ON rss_feeds (next_poll_at) WHERE enabled;
CREATE INDEX rss_feeds_guild_idx ON rss_feeds (guild_id, created_at DESC);

CREATE TABLE rss_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  feed_id BIGINT NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 1000),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  link TEXT NOT NULL CHECK (length(link) BETWEEN 1 AND 2000),
  summary TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  announced_at TIMESTAMPTZ,
  UNIQUE (feed_id, external_id)
);

CREATE INDEX rss_items_feed_idx ON rss_items (feed_id, published_at DESC NULLS LAST, discovered_at DESC);
CREATE INDEX rss_items_unannounced_idx ON rss_items (feed_id, discovered_at) WHERE announced_at IS NULL;

CREATE TABLE birthdays (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
  day SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 31),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  announcement_channel_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_announced_year INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX birthdays_due_idx ON birthdays (month, day) WHERE enabled;
CREATE INDEX birthdays_guild_idx ON birthdays (guild_id, month, day) WHERE enabled;

CREATE TABLE scheduled_notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('announcement', 'birthday', 'rss', 'reminder')),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
  run_at TIMESTAMPTZ NOT NULL,
  recurrence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'sent', 'cancelled', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  idempotency_key TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, idempotency_key)
);

CREATE INDEX scheduled_notifications_due_idx ON scheduled_notifications (run_at) WHERE status = 'scheduled';
CREATE INDEX scheduled_notifications_guild_idx ON scheduled_notifications (guild_id, created_at DESC);
