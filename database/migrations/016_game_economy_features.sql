
ALTER TABLE point_transactions DROP CONSTRAINT IF EXISTS point_transactions_reason_check;
ALTER TABLE point_transactions ADD CONSTRAINT point_transactions_reason_check CHECK (
  reason IN (
    'message', 'voice', 'fortune', 'redemption', 'raffle_entry', 'admin',
    'daily', 'work', 'crime', 'transfer_out', 'transfer_in'
  )
);

ALTER TABLE rewards ADD COLUMN IF NOT EXISTS stock INTEGER;
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS sales_start_at TIMESTAMPTZ;
ALTER TABLE rewards ADD COLUMN IF NOT EXISTS sales_end_at TIMESTAMPTZ;
ALTER TABLE rewards ADD CONSTRAINT rewards_stock_check CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE rewards ADD CONSTRAINT rewards_sales_period_check CHECK (
  sales_start_at IS NULL OR sales_end_at IS NULL OR sales_end_at > sales_start_at
);

CREATE TABLE achievement_definitions (
  achievement_key TEXT PRIMARY KEY CHECK (achievement_key ~ '^[a-z0-9_]{1,64}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 200),
  badge TEXT NOT NULL CHECK (length(badge) BETWEEN 1 AND 32),
  sort_order SMALLINT NOT NULL UNIQUE
);

CREATE TABLE member_achievements (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  achievement_key TEXT NOT NULL REFERENCES achievement_definitions(achievement_key) ON DELETE RESTRICT,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, achievement_key),
  FOREIGN KEY (guild_id, user_id)
    REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);

CREATE INDEX idx_member_achievements_member
  ON member_achievements(guild_id, user_id, earned_at DESC);

INSERT INTO achievement_definitions (achievement_key, name, description, badge, sort_order) VALUES
  ('first_point', 'はじめの一歩', '初めてポイントを獲得する', '🌱', 10),
  ('point_collector', 'ポイントコレクター', '累計1,000ポイントを獲得する', '💰', 20),
  ('daily_regular', '毎日ログイン', 'デイリーボーナスを7回受け取る', '📅', 30),
  ('shopper', 'お買い物上手', 'ショップで景品を1回交換する', '🛍️', 40),
  ('generous', 'やさしい送り主', 'ほかのメンバーへポイントを送付する', '🎁', 50);
