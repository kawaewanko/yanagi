CREATE TABLE health_events (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online', 'offline')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX health_events_detected_idx ON health_events (detected_at DESC);
