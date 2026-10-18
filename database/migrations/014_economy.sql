ALTER TABLE point_transactions DROP CONSTRAINT IF EXISTS point_transactions_reason_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_reason_check CHECK (reason IN ('message', 'voice', 'fortune', 'redemption', 'raffle_entry', 'admin', 'daily', 'work', 'crime'));

CREATE TABLE point_cooldowns (
  guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  next_available_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, action)
);
