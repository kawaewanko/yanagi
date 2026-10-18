CREATE TABLE IF NOT EXISTS guilds (
  guild_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  points BIGINT NOT NULL DEFAULT 0 CHECK (points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS point_transactions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount <> 0),
  reason TEXT NOT NULL CHECK (reason IN ('message', 'voice', 'fortune', 'redemption', 'raffle_entry', 'admin')),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, idempotency_key),
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_point_transactions_member
  ON point_transactions(guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_status SMALLINT,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, idempotency_key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);

CREATE TABLE IF NOT EXISTS fortune_draws (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  draw_date DATE NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('daikichi', 'chukichi', 'kichi', 'shokichi', 'suekichi', 'kyo')),
  points INTEGER NOT NULL CHECK (points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, user_id, draw_date),
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rewards (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  cost INTEGER NOT NULL CHECK (cost > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, id)
);

CREATE TABLE IF NOT EXISTS reward_redemptions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reward_id BIGINT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, idempotency_key),
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id),
  FOREIGN KEY (guild_id, reward_id)
    REFERENCES rewards(guild_id, id)
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_member
  ON reward_redemptions(guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS raffles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  prize JSONB NOT NULL,
  entry_cost INTEGER NOT NULL DEFAULT 0 CHECK (entry_cost >= 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'drawn')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  UNIQUE (guild_id, id)
);

CREATE TABLE IF NOT EXISTS raffle_entries (
  raffle_id BIGINT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 1 CHECK (entry_count = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (raffle_id, user_id),
  FOREIGN KEY (guild_id, raffle_id)
    REFERENCES raffles(guild_id, id) ON DELETE CASCADE,
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS raffle_results (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  raffle_id BIGINT NOT NULL,
  draw_number INTEGER NOT NULL CHECK (draw_number > 0),
  user_id TEXT NOT NULL,
  prize JSONB NOT NULL,
  redrawn_from BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (raffle_id, draw_number),
  UNIQUE (raffle_id, id),
  FOREIGN KEY (raffle_id, user_id)
    REFERENCES raffle_entries(raffle_id, user_id),
  FOREIGN KEY (raffle_id, redrawn_from)
    REFERENCES raffle_results(raffle_id, id)
);

CREATE TABLE IF NOT EXISTS temporary_voice_channels (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delete_after TIMESTAMPTZ,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS tts_jobs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  error_code TEXT,
  audio_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tts_jobs_fifo ON tts_jobs(created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  actor_id TEXT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_retention ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_guild ON audit_logs(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('join', 'leave', 'move')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_logs_retention ON voice_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_voice_logs_guild ON voice_logs(guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  guild_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);
