PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS profiles (
  uniqe TEXT PRIMARY KEY,
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_members (
  day_key TEXT NOT NULL,
  language TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  uniqe TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  total_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, language, difficulty, uniqe)
);
CREATE INDEX IF NOT EXISTS daily_members_board
  ON daily_members(day_key, language, difficulty, total_score DESC);

CREATE TABLE IF NOT EXISTS difficulty_words (
  day_key TEXT NOT NULL,
  language TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  word_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, language, difficulty, word_index)
);

CREATE TABLE IF NOT EXISTS member_words (
  day_key TEXT NOT NULL,
  language TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  uniqe TEXT NOT NULL,
  word_index INTEGER NOT NULL,
  value TEXT NOT NULL,
  guesswork_json TEXT NOT NULL DEFAULT '[]',
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day_key, language, difficulty, uniqe, word_index)
);
CREATE INDEX IF NOT EXISTS member_words_lookup
  ON member_words(day_key, language, difficulty, uniqe, word_index DESC);

CREATE TABLE IF NOT EXISTS premium_scores (
  language TEXT NOT NULL,
  uniqe TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  premium_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (language, uniqe)
);
CREATE INDEX IF NOT EXISTS premium_scores_rank
  ON premium_scores(language, premium_score DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS device_tokens (
  token TEXT PRIMARY KEY,
  uniqe TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'prod',
  bundle_id TEXT NOT NULL DEFAULT 'com.barak.wordzap',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_tokens_user
  ON device_tokens(uniqe, environment);

CREATE TABLE IF NOT EXISTS pvp_words (
  match_id TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  word_length INTEGER NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pvp_words_created
  ON pvp_words(created_at);
