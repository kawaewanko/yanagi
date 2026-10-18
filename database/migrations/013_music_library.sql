CREATE TABLE music_favorites (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id, url)
);

CREATE TABLE music_playlists (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guild_id, user_id, name)
);

CREATE TABLE music_playlist_tracks (
  playlist_id BIGINT NOT NULL REFERENCES music_playlists(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (playlist_id, position)
);

CREATE INDEX music_playlists_owner_idx ON music_playlists (guild_id, user_id);
