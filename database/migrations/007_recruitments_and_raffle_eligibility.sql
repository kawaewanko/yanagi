ALTER TABLE raffles
  ADD COLUMN IF NOT EXISTS eligibility JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS vc_recruitments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  post_channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  voice_channel_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
  activity TEXT NOT NULL CHECK (length(activity) BETWEEN 1 AND 500),
  max_participants INTEGER NOT NULL CHECK (max_participants BETWEEN 2 AND 99),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_vc_recruitments_expiry
  ON vc_recruitments(expires_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS vc_recruitment_participants (
  recruitment_id BIGINT NOT NULL REFERENCES vc_recruitments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (recruitment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_vc_recruitment_participants_recruitment
  ON vc_recruitment_participants(recruitment_id, joined_at);

CREATE INDEX IF NOT EXISTS idx_temporary_voice_cleanup
  ON temporary_voice_channels(delete_after) WHERE delete_after IS NOT NULL;
