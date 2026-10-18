CREATE INDEX IF NOT EXISTS idx_point_transactions_retention
  ON point_transactions(created_at);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_retention
  ON admin_sessions(created_at);
