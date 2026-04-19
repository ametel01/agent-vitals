export const SCHEMA_SQL = `
-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  project_name TEXT,
  started_at TEXT,
  ended_at TEXT,
  model TEXT,
  version TEXT,
  cwd TEXT,
  git_branch TEXT,
  total_messages INTEGER DEFAULT 0,
  total_user_prompts INTEGER DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  scanned_at TEXT NOT NULL,
  source_path TEXT,
  source_mtime_ms INTEGER,
  source_size_bytes INTEGER,
  provider TEXT NOT NULL DEFAULT 'claude'
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  uuid TEXT,
  parent_uuid TEXT,
  type TEXT NOT NULL,          -- user, assistant, system, tool_result, attachment, etc
  role TEXT,
  timestamp TEXT,
  model TEXT,
  content_text TEXT,           -- flattened text content
  content_length INTEGER DEFAULT 0,
  is_sidechain INTEGER DEFAULT 0,
  prompt_id TEXT,
  request_id TEXT,
  -- usage data
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_read_tokens INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Tool calls extracted from assistant messages
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id INTEGER,
  message_uuid TEXT,
  tool_call_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT,        -- JSON string of input
  target_file TEXT,            -- extracted file path for Read/Edit/Write
  timestamp TEXT,
  sequence_num INTEGER,        -- order within session
  -- classification
  category TEXT,               -- read, edit, write, search, bash, agent, other
  is_mutation INTEGER DEFAULT 0,
  is_research INTEGER DEFAULT 0,
  -- for bash calls
  bash_command TEXT,
  bash_is_build INTEGER DEFAULT 0,
  bash_is_test INTEGER DEFAULT 0,
  bash_is_git INTEGER DEFAULT 0,
  bash_success INTEGER,        -- null if unknown, 1 success, 0 failure
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Tool results
CREATE TABLE IF NOT EXISTS tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_use_id TEXT,
  message_uuid TEXT,
  content_text TEXT,
  content_length INTEGER DEFAULT 0,
  is_error INTEGER DEFAULT 0,
  timestamp TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Thinking blocks from assistant messages
CREATE TABLE IF NOT EXISTS thinking_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id INTEGER,
  message_uuid TEXT,
  is_redacted INTEGER DEFAULT 0,  -- 1 if content is empty but signature exists
  content_length INTEGER DEFAULT 0,
  signature_length INTEGER DEFAULT 0,
  estimated_depth INTEGER DEFAULT 0,  -- estimated chars of thinking
  timestamp TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Pre-computed daily metrics
CREATE TABLE IF NOT EXISTS daily_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,           -- YYYY-MM-DD
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metric_detail TEXT,          -- JSON for breakdowns
  provider TEXT NOT NULL DEFAULT '_all',  -- claude, codex, or _all (aggregate)
  model TEXT,                  -- for model segmentation
  project_path TEXT,
  UNIQUE(date, metric_name, provider, model, project_path)
);

-- User prompts (extracted for sentiment/frustration analysis)
CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  timestamp TEXT,
  content_text TEXT,
  content_length INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  -- pre-computed signals
  has_frustration INTEGER DEFAULT 0,
  positive_word_count INTEGER DEFAULT 0,
  negative_word_count INTEGER DEFAULT 0,
  is_interrupt INTEGER DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Laziness / stop hook violations
CREATE TABLE IF NOT EXISTS laziness_violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  timestamp TEXT,
  category TEXT NOT NULL,      -- ownership_dodging, permission_seeking, premature_stopping, known_limitation, session_length
  matched_phrase TEXT,
  surrounding_text TEXT,       -- context around the match
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Reasoning loops (self-corrections in assistant output)
CREATE TABLE IF NOT EXISTS reasoning_loops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  timestamp TEXT,
  matched_phrase TEXT,
  surrounding_text TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Self-admitted quality failures
CREATE TABLE IF NOT EXISTS self_admitted_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_uuid TEXT,
  timestamp TEXT,
  matched_phrase TEXT,
  surrounding_text TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Change events (auto-detected + manual annotations)
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,           -- auto, manual
  description TEXT NOT NULL,
  file_path TEXT,
  file_hash TEXT,
  content_snapshot TEXT,
  word_count INTEGER,
  provider TEXT NOT NULL DEFAULT 'claude'
);

-- Impact analysis results
CREATE TABLE IF NOT EXISTS impact_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  before_value REAL,
  after_value REAL,
  change_pct REAL,
  verdict TEXT,                -- improved, degraded, stable
  provider TEXT NOT NULL DEFAULT '_all',
  FOREIGN KEY (change_id) REFERENCES changes(id)
);

-- Config for custom laziness phrases
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_category ON tool_calls(category);
CREATE INDEX IF NOT EXISTS idx_thinking_session ON thinking_blocks(session_id);
CREATE INDEX IF NOT EXISTS idx_thinking_timestamp ON thinking_blocks(timestamp);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics(date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_name ON daily_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_user_prompts_timestamp ON user_prompts(timestamp);
CREATE INDEX IF NOT EXISTS idx_laziness_session ON laziness_violations(session_id);
CREATE INDEX IF NOT EXISTS idx_laziness_timestamp ON laziness_violations(timestamp);
CREATE INDEX IF NOT EXISTS idx_changes_timestamp ON changes(timestamp);
`;
