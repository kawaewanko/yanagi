ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
ALTER TABLE notification_outbox
  ADD CONSTRAINT notification_outbox_kind_check
  CHECK (kind IN ('rss', 'birthday', 'scheduled', 'reminder', 'health', 'system', 'event', 'poll', 'suggestion', 'ticket', 'youtube', 'twitch', 'webhook'));

CREATE TABLE external_notification_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id BIGINT NOT NULL REFERENCES external_subscriptions(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 500),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (subscription_id, external_id)
);
CREATE INDEX external_notification_events_subscription_idx
  ON external_notification_events (subscription_id, discovered_at DESC);

CREATE INDEX external_subscriptions_kind_poll_idx
  ON external_subscriptions (kind, next_poll_at, id) WHERE enabled AND next_poll_at IS NOT NULL;
