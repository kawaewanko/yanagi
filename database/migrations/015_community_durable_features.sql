ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_kind_check
  CHECK (kind IN ('rss', 'birthday', 'scheduled', 'reminder', 'health', 'system', 'event', 'poll', 'suggestion', 'ticket'));

CREATE TABLE community_events (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  starts_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  cancelled_by TEXT,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status <> 'cancelled') OR (cancelled_at IS NOT NULL))
);

CREATE INDEX community_events_guild_schedule_idx
  ON community_events (guild_id, starts_at) WHERE status = 'scheduled';

CREATE TABLE community_tickets (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX community_tickets_guild_status_idx
  ON community_tickets (guild_id, status, created_at DESC);

CREATE TABLE community_polls (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 200),
  options JSONB NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 2 AND 5)
);

CREATE UNIQUE INDEX community_polls_message_idx ON community_polls (message_id);
CREATE INDEX community_polls_due_idx ON community_polls (ends_at) WHERE status = 'open';

CREATE TABLE community_poll_votes (
  poll_id TEXT NOT NULL REFERENCES community_polls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  option_index SMALLINT NOT NULL CHECK (option_index BETWEEN 0 AND 4),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (poll_id, user_id)
);

CREATE TABLE community_suggestions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX community_suggestions_message_idx ON community_suggestions (message_id);
CREATE INDEX community_suggestions_due_idx ON community_suggestions (ends_at) WHERE status = 'open';

CREATE TABLE community_suggestion_votes (
  suggestion_id TEXT NOT NULL REFERENCES community_suggestions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  vote TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE health_alert_controls (
  service TEXT PRIMARY KEY CHECK (length(service) BETWEEN 1 AND 32),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  silenced_until TIMESTAMPTZ,
  silenced_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
