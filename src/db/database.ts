import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema';

type SqlParam = string | number | null;
type DailyMetricRow = { date: string; value: number; detail: string | null };
type DateValueRow = { date: string; value: number };
type LatestMetricRow = { date: string; value: number };
type ChangeRow = { id: number; timestamp: string; type: string; description: string };
type ImpactResultRow = {
  metric_name: string;
  before_value: number;
  after_value: number;
  change_pct: number;
  verdict: string;
};
type CountRow = { c: number };
type DateRangeRow = { min: string | null; max: string | null };
type MetricNameRow = { metric_name: string };
type DashboardMetricRow = {
  date: string;
  metric_name: string;
  value: number;
  detail: string | null;
};

function getDefaultDbPath(): string {
  const dir = path.join(os.homedir(), '.claude-vitals');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'vitals.db');
}

export class VitalsDB {
  db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || getDefaultDbPath());
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init() {
    this.db.exec(SCHEMA_SQL);
    this.migrate();
  }

  private migrate() {
    this.addColumnIfMissing('tool_calls', 'tool_call_id', 'TEXT');
    this.addColumnIfMissing('sessions', 'source_path', 'TEXT');
    this.addColumnIfMissing('sessions', 'source_mtime_ms', 'INTEGER');
    this.addColumnIfMissing('sessions', 'source_size_bytes', 'INTEGER');
    this.addColumnIfMissing('sessions', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(tool_call_id);');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_tool_results_use_id ON tool_results(tool_use_id);',
    );
  }

  private addColumnIfMissing(table: string, column: string, typeDecl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
  }

  // --- Sessions ---
  insertSession(s: {
    id: string;
    project_path: string;
    project_name?: string;
    started_at?: string;
    ended_at?: string;
    model?: string;
    version?: string;
    cwd?: string;
    git_branch?: string;
    total_messages?: number;
    total_user_prompts?: number;
    total_tool_calls?: number;
    source_path?: string;
    source_mtime_ms?: number;
    source_size_bytes?: number;
    provider?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, project_path, project_name, started_at, ended_at, model, version, cwd, git_branch, total_messages, total_user_prompts, total_tool_calls, scanned_at, source_path, source_mtime_ms, source_size_bytes, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
    `);
    stmt.run(
      s.id,
      s.project_path,
      s.project_name || null,
      s.started_at || null,
      s.ended_at || null,
      s.model || null,
      s.version || null,
      s.cwd || null,
      s.git_branch || null,
      s.total_messages || 0,
      s.total_user_prompts || 0,
      s.total_tool_calls || 0,
      s.source_path || null,
      s.source_mtime_ms ?? null,
      s.source_size_bytes ?? null,
      s.provider || 'claude',
    );
  }

  isSessionScanned(sessionId: string): boolean {
    const row = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as
      | { id: string }
      | undefined;
    return !!row;
  }

  getSessionSourceMeta(sessionId: string):
    | {
        source_path: string | null;
        source_mtime_ms: number | null;
        source_size_bytes: number | null;
      }
    | undefined {
    return this.db
      .prepare('SELECT source_path, source_mtime_ms, source_size_bytes FROM sessions WHERE id = ?')
      .get(sessionId) as
      | {
          source_path: string | null;
          source_mtime_ms: number | null;
          source_size_bytes: number | null;
        }
      | undefined;
  }

  deleteSessionData(sessionId: string) {
    const stmts = [
      'DELETE FROM tool_results WHERE session_id = ?',
      'DELETE FROM tool_calls WHERE session_id = ?',
      'DELETE FROM thinking_blocks WHERE session_id = ?',
      'DELETE FROM user_prompts WHERE session_id = ?',
      'DELETE FROM laziness_violations WHERE session_id = ?',
      'DELETE FROM reasoning_loops WHERE session_id = ?',
      'DELETE FROM self_admitted_failures WHERE session_id = ?',
      'DELETE FROM messages WHERE session_id = ?',
      'DELETE FROM sessions WHERE id = ?',
    ];
    for (const sql of stmts) {
      this.db.prepare(sql).run(sessionId);
    }
  }

  updateBashSuccessForSession(sessionId: string) {
    this.db
      .prepare(
        `
      UPDATE tool_calls
      SET bash_success = CASE
        WHEN EXISTS (
          SELECT 1 FROM tool_results tr
          WHERE tr.session_id = tool_calls.session_id
            AND tr.tool_use_id = tool_calls.tool_call_id
            AND tr.is_error = 1
        ) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM tool_results tr
          WHERE tr.session_id = tool_calls.session_id
            AND tr.tool_use_id = tool_calls.tool_call_id
        ) THEN 1
        ELSE NULL
      END
      WHERE session_id = ?
        AND category = 'bash'
        AND tool_call_id IS NOT NULL
    `,
      )
      .run(sessionId);
  }

  // --- Messages ---
  insertMessage(m: {
    session_id: string;
    uuid?: string;
    parent_uuid?: string;
    type: string;
    role?: string;
    timestamp?: string;
    model?: string;
    content_text?: string;
    content_length?: number;
    is_sidechain?: boolean;
    prompt_id?: string;
    request_id?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, uuid, parent_uuid, type, role, timestamp, model, content_text, content_length, is_sidechain, prompt_id, request_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      m.session_id,
      m.uuid || null,
      m.parent_uuid || null,
      m.type,
      m.role || null,
      m.timestamp || null,
      m.model || null,
      m.content_text || null,
      m.content_length || 0,
      m.is_sidechain ? 1 : 0,
      m.prompt_id || null,
      m.request_id || null,
      m.input_tokens || null,
      m.output_tokens || null,
      m.cache_creation_tokens || null,
      m.cache_read_tokens || null,
    );
    return Number(r.lastInsertRowid);
  }

  // --- Tool Calls ---
  insertToolCall(tc: {
    session_id: string;
    message_id?: number;
    message_uuid?: string;
    tool_call_id?: string;
    tool_name: string;
    tool_input_json?: string;
    target_file?: string;
    timestamp?: string;
    sequence_num?: number;
    category?: string;
    is_mutation?: boolean;
    is_research?: boolean;
    bash_command?: string;
    bash_is_build?: boolean;
    bash_is_test?: boolean;
    bash_is_git?: boolean;
    bash_success?: boolean | null;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO tool_calls (session_id, message_id, message_uuid, tool_call_id, tool_name, tool_input_json, target_file, timestamp, sequence_num, category, is_mutation, is_research, bash_command, bash_is_build, bash_is_test, bash_is_git, bash_success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tc.session_id,
      tc.message_id || null,
      tc.message_uuid || null,
      tc.tool_call_id || null,
      tc.tool_name,
      tc.tool_input_json || null,
      tc.target_file || null,
      tc.timestamp || null,
      tc.sequence_num || null,
      tc.category || null,
      tc.is_mutation ? 1 : 0,
      tc.is_research ? 1 : 0,
      tc.bash_command || null,
      tc.bash_is_build ? 1 : 0,
      tc.bash_is_test ? 1 : 0,
      tc.bash_is_git ? 1 : 0,
      tc.bash_success === null || tc.bash_success === undefined ? null : tc.bash_success ? 1 : 0,
    );
  }

  // --- Tool Results ---
  insertToolResult(tr: {
    session_id: string;
    tool_use_id?: string;
    message_uuid?: string;
    content_text?: string;
    content_length?: number;
    is_error?: boolean;
    timestamp?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO tool_results (session_id, tool_use_id, message_uuid, content_text, content_length, is_error, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tr.session_id,
      tr.tool_use_id || null,
      tr.message_uuid || null,
      tr.content_text || null,
      tr.content_length || 0,
      tr.is_error ? 1 : 0,
      tr.timestamp || null,
    );
  }

  // --- Thinking Blocks ---
  insertThinkingBlock(tb: {
    session_id: string;
    message_id?: number;
    message_uuid?: string;
    is_redacted?: boolean;
    content_length?: number;
    signature_length?: number;
    estimated_depth?: number;
    timestamp?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO thinking_blocks (session_id, message_id, message_uuid, is_redacted, content_length, signature_length, estimated_depth, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tb.session_id,
      tb.message_id || null,
      tb.message_uuid || null,
      tb.is_redacted ? 1 : 0,
      tb.content_length || 0,
      tb.signature_length || 0,
      tb.estimated_depth || 0,
      tb.timestamp || null,
    );
  }

  // --- User Prompts ---
  insertUserPrompt(up: {
    session_id: string;
    message_uuid?: string;
    timestamp?: string;
    content_text?: string;
    content_length?: number;
    word_count?: number;
    has_frustration?: boolean;
    positive_word_count?: number;
    negative_word_count?: number;
    is_interrupt?: boolean;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO user_prompts (session_id, message_uuid, timestamp, content_text, content_length, word_count, has_frustration, positive_word_count, negative_word_count, is_interrupt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      up.session_id,
      up.message_uuid || null,
      up.timestamp || null,
      up.content_text || null,
      up.content_length || 0,
      up.word_count || 0,
      up.has_frustration ? 1 : 0,
      up.positive_word_count || 0,
      up.negative_word_count || 0,
      up.is_interrupt ? 1 : 0,
    );
  }

  // --- Laziness Violations ---
  insertLazinessViolation(lv: {
    session_id: string;
    message_uuid?: string;
    timestamp?: string;
    category: string;
    matched_phrase: string;
    surrounding_text?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO laziness_violations (session_id, message_uuid, timestamp, category, matched_phrase, surrounding_text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      lv.session_id,
      lv.message_uuid || null,
      lv.timestamp || null,
      lv.category,
      lv.matched_phrase,
      lv.surrounding_text || null,
    );
  }

  // --- Reasoning Loops ---
  insertReasoningLoop(rl: {
    session_id: string;
    message_uuid?: string;
    timestamp?: string;
    matched_phrase: string;
    surrounding_text?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO reasoning_loops (session_id, message_uuid, timestamp, matched_phrase, surrounding_text)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      rl.session_id,
      rl.message_uuid || null,
      rl.timestamp || null,
      rl.matched_phrase,
      rl.surrounding_text || null,
    );
  }

  // --- Self-Admitted Failures ---
  insertSelfAdmittedFailure(sf: {
    session_id: string;
    message_uuid?: string;
    timestamp?: string;
    matched_phrase: string;
    surrounding_text?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO self_admitted_failures (session_id, message_uuid, timestamp, matched_phrase, surrounding_text)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      sf.session_id,
      sf.message_uuid || null,
      sf.timestamp || null,
      sf.matched_phrase,
      sf.surrounding_text || null,
    );
  }

  // --- Daily Metrics ---
  upsertDailyMetric(dm: {
    date: string;
    metric_name: string;
    metric_value: number;
    metric_detail?: string;
    model?: string;
    project_path?: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO daily_metrics (date, metric_name, metric_value, metric_detail, model, project_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      dm.date,
      dm.metric_name,
      dm.metric_value,
      dm.metric_detail || null,
      dm.model || '_all',
      dm.project_path || '_all',
    );
  }

  // --- Changes ---
  insertChange(c: {
    timestamp: string;
    type: string;
    description: string;
    file_path?: string;
    file_hash?: string;
    content_snapshot?: string;
    word_count?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO changes (timestamp, type, description, file_path, file_hash, content_snapshot, word_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      c.timestamp,
      c.type,
      c.description,
      c.file_path || null,
      c.file_hash || null,
      c.content_snapshot || null,
      c.word_count || null,
    );
    return Number(r.lastInsertRowid);
  }

  // --- Impact Results ---
  insertImpactResult(ir: {
    change_id: number;
    metric_name: string;
    before_value: number;
    after_value: number;
    change_pct: number;
    verdict: string;
  }) {
    const stmt = this.db.prepare(`
      INSERT INTO impact_results (change_id, metric_name, before_value, after_value, change_pct, verdict)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      ir.change_id,
      ir.metric_name,
      ir.before_value,
      ir.after_value,
      ir.change_pct,
      ir.verdict,
    );
  }

  // --- Query helpers ---
  getDailyMetrics(
    metricName: string,
    days: number = 30,
    model?: string,
    project?: string,
  ): DailyMetricRow[] {
    let sql = `SELECT date, metric_value as value, metric_detail as detail FROM daily_metrics WHERE metric_name = ? AND date >= date('now', ?)`;
    const params: SqlParam[] = [metricName, `-${days} days`];
    if (model) {
      sql += ' AND model = ?';
      params.push(model);
    } else {
      sql += ' AND model = ?';
      params.push('_all');
    }
    if (project) {
      sql += ' AND project_path = ?';
      params.push(project);
    } else {
      sql += ' AND project_path = ?';
      params.push('_all');
    }
    sql += ' ORDER BY date ASC';
    return this.db.prepare(sql).all(...params) as DailyMetricRow[];
  }

  getMetricForDateRange(metricName: string, startDate: string, endDate: string): DateValueRow[] {
    return this.db
      .prepare(
        `
      SELECT date, metric_value as value FROM daily_metrics
      WHERE metric_name = ? AND date >= ? AND date <= ? AND model = '_all' AND project_path = '_all'
      ORDER BY date ASC
    `,
      )
      .all(metricName, startDate, endDate) as DateValueRow[];
  }

  getLatestMetric(metricName: string): LatestMetricRow | undefined {
    return this.db
      .prepare(
        `
      SELECT date, metric_value as value FROM daily_metrics
      WHERE metric_name = ? AND model = '_all' AND project_path = '_all'
      ORDER BY date DESC LIMIT 1
    `,
      )
      .get(metricName) as LatestMetricRow | undefined;
  }

  getAllChanges(): ChangeRow[] {
    return this.db
      .prepare('SELECT id, timestamp, type, description FROM changes ORDER BY timestamp DESC')
      .all() as ChangeRow[];
  }

  getImpactResults(changeId: number): ImpactResultRow[] {
    return this.db
      .prepare(
        'SELECT metric_name, before_value, after_value, change_pct, verdict FROM impact_results WHERE change_id = ?',
      )
      .all(changeId) as ImpactResultRow[];
  }

  getSessionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as CountRow).c;
  }

  getToolCallCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM tool_calls').get() as CountRow).c;
  }

  getDateRange(): DateRangeRow | undefined {
    return this.db.prepare('SELECT MIN(date) as min, MAX(date) as max FROM daily_metrics').get() as
      | DateRangeRow
      | undefined;
  }

  getAllMetricNames(): string[] {
    return (
      this.db
        .prepare('SELECT DISTINCT metric_name FROM daily_metrics ORDER BY metric_name')
        .all() as MetricNameRow[]
    ).map((r) => r.metric_name);
  }

  getAllDailyMetricsForDashboard(days: number = 90): DashboardMetricRow[] {
    return this.db
      .prepare(
        `
      SELECT date, metric_name, metric_value as value, metric_detail as detail
      FROM daily_metrics
      WHERE date >= date('now', ?) AND model = '_all' AND project_path = '_all'
      ORDER BY date ASC, metric_name ASC
    `,
      )
      .all(`-${days} days`) as DashboardMetricRow[];
  }

  close() {
    this.db.close();
  }
}
