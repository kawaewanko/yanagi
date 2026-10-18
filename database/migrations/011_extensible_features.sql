CREATE TABLE guild_feature_settings (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL CHECK (feature_key ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, feature_key)
);

CREATE TABLE user_preferences (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
  locale TEXT NOT NULL DEFAULT 'ja-JP' CHECK (length(locale) BETWEEN 2 AND 20),
  notification_preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE notification_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'birthday', 'scheduled', 'reminder', 'health', 'system')),
  payload JSONB NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  dedupe_key TEXT,
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, dedupe_key)
);

CREATE INDEX notification_outbox_claim_idx ON notification_outbox (scheduled_at, id) WHERE status = 'pending';
CREATE INDEX notification_outbox_retry_idx ON notification_outbox (updated_at) WHERE status IN ('processing', 'failed');

CREATE TABLE external_subscriptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('rss', 'youtube', 'twitch', 'webhook')),
  target TEXT NOT NULL CHECK (length(target) BETWEEN 1 AND 2000),
  channel_id TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  next_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, kind, target, channel_id)
);

CREATE INDEX external_subscriptions_poll_idx ON external_subscriptions (next_poll_at) WHERE enabled;

CREATE TABLE moderation_cases (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  case_number INTEGER NOT NULL,
  target_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('note', 'warn', 'timeout', 'kick', 'ban', 'unban')),
  reason TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 1000),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, case_number)
);

CREATE INDEX moderation_cases_target_idx ON moderation_cases (guild_id, target_user_id, created_at DESC);

CREATE TABLE metric_buckets (
  bucket_start TIMESTAMPTZ NOT NULL,
  guild_id TEXT REFERENCES guilds(guild_id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL CHECK (length(metric_key) BETWEEN 1 AND 120),
  dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  value BIGINT NOT NULL DEFAULT 0 CHECK (value >= 0),
  PRIMARY KEY (bucket_start, guild_id, metric_key, dimensions)
);

CREATE INDEX metric_buckets_lookup_idx ON metric_buckets (guild_id, metric_key, bucket_start DESC);
