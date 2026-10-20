ALTER TABLE notification_outbox
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

CREATE INDEX IF NOT EXISTS notification_outbox_claim_token_idx
  ON notification_outbox (id, claim_token)
  WHERE claim_token IS NOT NULL;
***
