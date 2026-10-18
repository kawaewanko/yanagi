ALTER TABLE tts_jobs
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tts_jobs_expired_claims
  ON tts_jobs(claimed_at)
  WHERE status = 'processing';
