import type Database from 'better-sqlite3';
import type { VitalsDB } from '../db/database';

type FirstToolCategory = 'read' | 'edit' | 'search' | 'bash' | 'write' | 'agent';
type FirstToolStats = Record<FirstToolCategory, number> & { total: number };
type ContextQuartile = 'q1' | 'q2' | 'q3' | 'q4';
type ContextQuartileDetail = {
  tool_calls: number;
  mutation_rate: number;
  bash_fail_rate: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Extract YYYY-MM-DD from an ISO-ish timestamp stored in the DB. */
const dateExpr = `substr(timestamp, 1, 10)`;

/**
 * Safe division: returns 0 when the denominator is zero.
 */
function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function isFirstToolCategory(category: string): category is FirstToolCategory {
  return ['read', 'edit', 'search', 'bash', 'write', 'agent'].includes(category);
}

/**
 * Build the `JOIN sessions` / provider filter clauses used by every metric
 * query. When `provider === '_all'` this returns empty strings so the query
 * behaves exactly as before provider segmentation existed.
 */
function providerClauses(
  provider: string,
  alias: string,
): { join: string; where: string; params: string[] } {
  if (provider === '_all') return { join: '', where: '', params: [] };
  return {
    join: ` JOIN sessions s_prov ON ${alias}.session_id = s_prov.id`,
    where: ' AND s_prov.provider = ?',
    params: [provider],
  };
}

// ---------------------------------------------------------------------------
// Main analyser class
// ---------------------------------------------------------------------------

export class MetricsAnalyzer {
  /**
   * Compute all quality metrics for every day that has data. Metrics are
   * emitted once with provider `_all` (aggregate) and once per distinct
   * provider detected in the sessions table.
   */
  computeAll(db: VitalsDB): void {
    const raw = db.db;
    const providers = ['_all', ...db.getProvidersInSessions()];

    for (const provider of providers) {
      this.computeThinkingDepthMedian(db, raw, provider);
      this.computeThinkingDepthRedactedPct(db, raw, provider);
      this.computeReadEditRatio(db, raw, provider);
      this.computeResearchMutationRatio(db, raw, provider);
      this.computeBlindEditRate(db, raw, provider);
      this.computeWriteVsEditPct(db, raw, provider);
      this.computeFirstToolReadPct(db, raw, provider);
      this.computeReasoningLoopsPer1k(db, raw, provider);
      this.computeLazinessTotal(db, raw, provider);
      this.computeSelfAdmittedFailuresPer1k(db, raw, provider);
      this.computeUserInterruptsPer1k(db, raw, provider);
      this.computeSentimentRatio(db, raw, provider);
      this.computeFrustrationRate(db, raw, provider);
      this.computeSessionAutonomyMedian(db, raw, provider);
      this.computeEditChurnRate(db, raw, provider);
      this.computeBashSuccessRate(db, raw, provider);
      this.computeSubagentPct(db, raw, provider);
      this.computeContextPressure(db, raw, provider);
      this.computeCostEstimate(db, raw, provider);
      this.computePromptsPerSession(db, raw, provider);

      // Extended metrics (v1.1)
      this.computeTimeOfDayQuality(db, raw, provider);
      this.computeToolDiversity(db, raw, provider);
      this.computeTokenEfficiency(db, raw, provider);
      this.computeSessionLength(db, raw, provider);
    }
  }

  // -----------------------------------------------------------------------
  // 1. thinking_depth_median
  // -----------------------------------------------------------------------
  private computeThinkingDepthMedian(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tb');
    const rows = raw
      .prepare(
        `
      SELECT substr(tb.timestamp, 1, 10) AS day, tb.estimated_depth
      FROM thinking_blocks tb${pc.join}
      WHERE tb.timestamp IS NOT NULL${pc.where}
      ORDER BY day
    `,
      )
      .all(...pc.params) as { day: string; estimated_depth: number }[];

    const byDay = this.groupBy(rows, 'day');
    for (const [day, items] of Object.entries(byDay)) {
      const depths = items.map((r) => r.estimated_depth);
      db.upsertDailyMetric({
        date: day,
        metric_name: 'thinking_depth_median',
        metric_value: median(depths),
        provider,
      });
    }

    // model-segmented
    const modelProviderWhere = provider === '_all' ? '' : ' AND s.provider = ?';
    const modelParams = provider === '_all' ? [] : [provider];
    const rowsM = raw
      .prepare(
        `
      SELECT ${dateExpr} AS day, tb.estimated_depth, s.model
      FROM thinking_blocks tb
      JOIN sessions s ON tb.session_id = s.id
      WHERE tb.timestamp IS NOT NULL AND s.model IS NOT NULL${modelProviderWhere}
      ORDER BY day
    `,
      )
      .all(...modelParams) as { day: string; estimated_depth: number; model: string }[];

    const byDayModel = this.groupBy2(rowsM, 'day', 'model');
    for (const [key, items] of Object.entries(byDayModel)) {
      const [day, model] = key.split('\0');
      const depths = items.map((r) => r.estimated_depth);
      db.upsertDailyMetric({
        date: day,
        metric_name: 'thinking_depth_median',
        metric_value: median(depths),
        provider,
        model,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 2. thinking_depth_redacted_pct
  // -----------------------------------------------------------------------
  private computeThinkingDepthRedactedPct(
    db: VitalsDB,
    raw: Database.Database,
    provider: string,
  ): void {
    const pc = providerClauses(provider, 'tb');
    const rows = raw
      .prepare(
        `
      SELECT substr(tb.timestamp, 1, 10) AS day,
             COUNT(*) AS total,
             SUM(CASE WHEN tb.is_redacted = 1 THEN 1 ELSE 0 END) AS redacted
      FROM thinking_blocks tb${pc.join}
      WHERE tb.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; total: number; redacted: number }[];

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'thinking_depth_redacted_pct',
        metric_value: safeDivide(r.redacted, r.total) * 100,
        provider,
      });
    }

    // model-segmented
    const modelProviderWhere = provider === '_all' ? '' : ' AND s.provider = ?';
    const modelParams = provider === '_all' ? [] : [provider];
    const rowsM = raw
      .prepare(
        `
      SELECT substr(tb.timestamp, 1, 10) AS day, s.model,
             COUNT(*) AS total,
             SUM(CASE WHEN tb.is_redacted = 1 THEN 1 ELSE 0 END) AS redacted
      FROM thinking_blocks tb
      JOIN sessions s ON tb.session_id = s.id
      WHERE tb.timestamp IS NOT NULL AND s.model IS NOT NULL${modelProviderWhere}
      GROUP BY day, s.model
    `,
      )
      .all(...modelParams) as { day: string; model: string; total: number; redacted: number }[];

    for (const r of rowsM) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'thinking_depth_redacted_pct',
        metric_value: safeDivide(r.redacted, r.total) * 100,
        provider,
        model: r.model,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 3. read_edit_ratio
  // -----------------------------------------------------------------------
  private computeReadEditRatio(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
             SUM(CASE WHEN tc.category = 'read' THEN 1 ELSE 0 END) AS reads,
             SUM(CASE WHEN tc.category = 'edit' THEN 1 ELSE 0 END) AS edits
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; reads: number; edits: number }[];

    for (const r of rows) {
      const value = r.edits === 0 ? r.reads : r.reads / r.edits;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'read_edit_ratio',
        metric_value: value,
        provider,
      });
    }

    // model-segmented
    const modelProviderWhere = provider === '_all' ? '' : ' AND s.provider = ?';
    const modelParams = provider === '_all' ? [] : [provider];
    const rowsM = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day, s.model,
             SUM(CASE WHEN tc.category = 'read' THEN 1 ELSE 0 END) AS reads,
             SUM(CASE WHEN tc.category = 'edit' THEN 1 ELSE 0 END) AS edits
      FROM tool_calls tc
      JOIN sessions s ON tc.session_id = s.id
      WHERE tc.timestamp IS NOT NULL AND s.model IS NOT NULL${modelProviderWhere}
      GROUP BY day, s.model
    `,
      )
      .all(...modelParams) as { day: string; model: string; reads: number; edits: number }[];

    for (const r of rowsM) {
      const value = r.edits === 0 ? r.reads : r.reads / r.edits;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'read_edit_ratio',
        metric_value: value,
        provider,
        model: r.model,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 4. research_mutation_ratio
  // -----------------------------------------------------------------------
  private computeResearchMutationRatio(
    db: VitalsDB,
    raw: Database.Database,
    provider: string,
  ): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
             SUM(CASE WHEN tc.is_research = 1 THEN 1 ELSE 0 END) AS research,
             SUM(CASE WHEN tc.is_mutation = 1 THEN 1 ELSE 0 END) AS mutations
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; research: number; mutations: number }[];

    for (const r of rows) {
      const value = r.mutations === 0 ? r.research : r.research / r.mutations;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'research_mutation_ratio',
        metric_value: value,
        provider,
      });
    }

    // model-segmented
    const modelProviderWhere = provider === '_all' ? '' : ' AND s.provider = ?';
    const modelParams = provider === '_all' ? [] : [provider];
    const rowsM = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day, s.model,
             SUM(CASE WHEN tc.is_research = 1 THEN 1 ELSE 0 END) AS research,
             SUM(CASE WHEN tc.is_mutation = 1 THEN 1 ELSE 0 END) AS mutations
      FROM tool_calls tc
      JOIN sessions s ON tc.session_id = s.id
      WHERE tc.timestamp IS NOT NULL AND s.model IS NOT NULL${modelProviderWhere}
      GROUP BY day, s.model
    `,
      )
      .all(...modelParams) as { day: string; model: string; research: number; mutations: number }[];

    for (const r of rowsM) {
      const value = r.mutations === 0 ? r.research : r.research / r.mutations;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'research_mutation_ratio',
        metric_value: value,
        provider,
        model: r.model,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 5. blind_edit_rate
  // -----------------------------------------------------------------------
  private computeBlindEditRate(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const edits = raw
      .prepare(
        `
      SELECT tc.id, tc.session_id, tc.sequence_num, tc.target_file,
             substr(tc.timestamp, 1, 10) AS day
      FROM tool_calls tc${pc.join}
      WHERE tc.category = 'edit' AND tc.timestamp IS NOT NULL AND tc.target_file IS NOT NULL${pc.where}
      ORDER BY tc.session_id, tc.sequence_num
    `,
      )
      .all(...pc.params) as {
      id: number;
      session_id: string;
      sequence_num: number;
      target_file: string;
      day: string;
    }[];

    const lookbackStmt = raw.prepare(`
      SELECT target_file FROM tool_calls
      WHERE session_id = ?
        AND sequence_num < ?
        AND sequence_num >= ?
        AND category IN ('read', 'search')
        AND target_file IS NOT NULL
    `);

    const dayStats: Record<string, { total: number; blind: number }> = {};

    for (const edit of edits) {
      if (!dayStats[edit.day]) dayStats[edit.day] = { total: 0, blind: 0 };
      dayStats[edit.day].total++;

      const minSeq = edit.sequence_num - 10;
      const preceding = lookbackStmt.all(edit.session_id, edit.sequence_num, minSeq) as {
        target_file: string;
      }[];
      const recentFiles = new Set(preceding.map((r) => r.target_file));

      if (!recentFiles.has(edit.target_file)) {
        dayStats[edit.day].blind++;
      }
    }

    for (const [day, stats] of Object.entries(dayStats)) {
      db.upsertDailyMetric({
        date: day,
        metric_name: 'blind_edit_rate',
        metric_value: safeDivide(stats.blind, stats.total) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 6. write_vs_edit_pct
  // -----------------------------------------------------------------------
  private computeWriteVsEditPct(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
             SUM(CASE WHEN tc.category = 'write' THEN 1 ELSE 0 END) AS writes,
             SUM(CASE WHEN tc.category = 'edit' THEN 1 ELSE 0 END) AS edits
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL AND tc.category IN ('write', 'edit')${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; writes: number; edits: number }[];

    for (const r of rows) {
      const total = r.writes + r.edits;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'write_vs_edit_pct',
        metric_value: safeDivide(r.writes, total) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 7. first_tool_read_pct
  // -----------------------------------------------------------------------
  private computeFirstToolReadPct(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'up');
    const prompts = raw
      .prepare(
        `
      SELECT up.session_id, up.timestamp, substr(up.timestamp, 1, 10) AS day
      FROM user_prompts up${pc.join}
      WHERE up.timestamp IS NOT NULL${pc.where}
      ORDER BY day
    `,
      )
      .all(...pc.params) as { session_id: string; timestamp: string; day: string }[];

    const firstToolStmt = raw.prepare(`
      SELECT category FROM tool_calls
      WHERE session_id = ? AND timestamp >= ?
      ORDER BY sequence_num ASC
      LIMIT 1
    `);

    const dayStats: Record<string, FirstToolStats> = {};

    for (const p of prompts) {
      if (!dayStats[p.day])
        dayStats[p.day] = { total: 0, read: 0, edit: 0, search: 0, bash: 0, write: 0, agent: 0 };

      const tool = firstToolStmt.get(p.session_id, p.timestamp) as { category: string } | undefined;
      if (!tool) continue;

      dayStats[p.day].total++;
      if (isFirstToolCategory(tool.category)) {
        dayStats[p.day][tool.category]++;
      }
    }

    for (const [day, s] of Object.entries(dayStats)) {
      const readPct = safeDivide(s.read, s.total) * 100;
      const detail = JSON.stringify({
        read_pct: safeDivide(s.read, s.total) * 100,
        edit_pct: safeDivide(s.edit, s.total) * 100,
        search_pct: safeDivide(s.search, s.total) * 100,
        bash_pct: safeDivide(s.bash, s.total) * 100,
        write_pct: safeDivide(s.write, s.total) * 100,
        agent_pct: safeDivide(s.agent, s.total) * 100,
      });
      db.upsertDailyMetric({
        date: day,
        metric_name: 'first_tool_read_pct',
        metric_value: readPct,
        metric_detail: detail,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 8. reasoning_loops_per_1k
  // -----------------------------------------------------------------------
  private computeReasoningLoopsPer1k(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pcRL = providerClauses(provider, 'rl');
    const pcTC = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT rl.day, rl.loops, tc.tool_count FROM (
        SELECT substr(rl.timestamp, 1, 10) AS day, COUNT(*) AS loops
        FROM reasoning_loops rl${pcRL.join}
        WHERE rl.timestamp IS NOT NULL${pcRL.where}
        GROUP BY day
      ) rl
      JOIN (
        SELECT substr(tc.timestamp, 1, 10) AS day2, COUNT(*) AS tool_count
        FROM tool_calls tc${pcTC.join}
        WHERE tc.timestamp IS NOT NULL${pcTC.where}
        GROUP BY day2
      ) tc ON rl.day = tc.day2
    `,
      )
      .all(...pcRL.params, ...pcTC.params) as {
      day: string;
      loops: number;
      tool_count: number;
    }[];

    for (const r of rows) {
      const per1k = safeDivide(r.loops, r.tool_count / 1000);
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'reasoning_loops_per_1k',
        metric_value: per1k,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 9. laziness_total
  // -----------------------------------------------------------------------
  private computeLazinessTotal(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'lv');
    const rows = raw
      .prepare(
        `
      SELECT substr(lv.timestamp, 1, 10) AS day, lv.category, COUNT(*) AS cnt
      FROM laziness_violations lv${pc.join}
      WHERE lv.timestamp IS NOT NULL${pc.where}
      GROUP BY day, lv.category
    `,
      )
      .all(...pc.params) as { day: string; category: string; cnt: number }[];

    const byDay: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (!byDay[r.day]) byDay[r.day] = {};
      byDay[r.day][r.category] = r.cnt;
    }

    for (const [day, categories] of Object.entries(byDay)) {
      const total = Object.values(categories).reduce((sum, v) => sum + v, 0);
      db.upsertDailyMetric({
        date: day,
        metric_name: 'laziness_total',
        metric_value: total,
        metric_detail: JSON.stringify(categories),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 10. self_admitted_failures_per_1k
  // -----------------------------------------------------------------------
  private computeSelfAdmittedFailuresPer1k(
    db: VitalsDB,
    raw: Database.Database,
    provider: string,
  ): void {
    const pcSF = providerClauses(provider, 'sf');
    const pcTC = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT sf.day, sf.failures, tc.tool_count FROM (
        SELECT substr(sf.timestamp, 1, 10) AS day, COUNT(*) AS failures
        FROM self_admitted_failures sf${pcSF.join}
        WHERE sf.timestamp IS NOT NULL${pcSF.where}
        GROUP BY day
      ) sf
      JOIN (
        SELECT substr(tc.timestamp, 1, 10) AS day2, COUNT(*) AS tool_count
        FROM tool_calls tc${pcTC.join}
        WHERE tc.timestamp IS NOT NULL${pcTC.where}
        GROUP BY day2
      ) tc ON sf.day = tc.day2
    `,
      )
      .all(...pcSF.params, ...pcTC.params) as {
      day: string;
      failures: number;
      tool_count: number;
    }[];

    for (const r of rows) {
      const per1k = safeDivide(r.failures, r.tool_count / 1000);
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'self_admitted_failures_per_1k',
        metric_value: per1k,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 11. user_interrupts_per_1k
  // -----------------------------------------------------------------------
  private computeUserInterruptsPer1k(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pcUP = providerClauses(provider, 'up');
    const pcTC = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT up.day, up.interrupts, tc.tool_count FROM (
        SELECT substr(up.timestamp, 1, 10) AS day, COUNT(*) AS interrupts
        FROM user_prompts up${pcUP.join}
        WHERE up.timestamp IS NOT NULL AND up.is_interrupt = 1${pcUP.where}
        GROUP BY day
      ) up
      JOIN (
        SELECT substr(tc.timestamp, 1, 10) AS day2, COUNT(*) AS tool_count
        FROM tool_calls tc${pcTC.join}
        WHERE tc.timestamp IS NOT NULL${pcTC.where}
        GROUP BY day2
      ) tc ON up.day = tc.day2
    `,
      )
      .all(...pcUP.params, ...pcTC.params) as {
      day: string;
      interrupts: number;
      tool_count: number;
    }[];

    for (const r of rows) {
      const per1k = safeDivide(r.interrupts, r.tool_count / 1000);
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'user_interrupts_per_1k',
        metric_value: per1k,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 12. sentiment_ratio
  // -----------------------------------------------------------------------
  private computeSentimentRatio(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'up');
    const rows = raw
      .prepare(
        `
      SELECT substr(up.timestamp, 1, 10) AS day,
             SUM(up.positive_word_count) AS positives,
             SUM(up.negative_word_count) AS negatives
      FROM user_prompts up${pc.join}
      WHERE up.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; positives: number; negatives: number }[];

    for (const r of rows) {
      const value = r.negatives === 0 ? r.positives : r.positives / r.negatives;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'sentiment_ratio',
        metric_value: value,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 13. frustration_rate
  // -----------------------------------------------------------------------
  private computeFrustrationRate(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'up');
    const rows = raw
      .prepare(
        `
      SELECT substr(up.timestamp, 1, 10) AS day,
             COUNT(*) AS total,
             SUM(CASE WHEN up.has_frustration = 1 THEN 1 ELSE 0 END) AS frustrated
      FROM user_prompts up${pc.join}
      WHERE up.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; total: number; frustrated: number }[];

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'frustration_rate',
        metric_value: safeDivide(r.frustrated, r.total) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 14. session_autonomy_median
  // -----------------------------------------------------------------------
  private computeSessionAutonomyMedian(
    db: VitalsDB,
    raw: Database.Database,
    provider: string,
  ): void {
    const pc = providerClauses(provider, 'up');
    const rows = raw
      .prepare(
        `
      SELECT up.session_id, up.timestamp
      FROM user_prompts up${pc.join}
      WHERE up.timestamp IS NOT NULL${pc.where}
      ORDER BY up.session_id, up.timestamp
    `,
      )
      .all(...pc.params) as { session_id: string; timestamp: string }[];

    const dayGaps: Record<string, number[]> = {};
    let prevSession: string | null = null;
    let prevTimestamp: string | null = null;

    for (const r of rows) {
      if (r.session_id === prevSession && prevTimestamp) {
        const gapMs = new Date(r.timestamp).getTime() - new Date(prevTimestamp).getTime();
        const gapMinutes = gapMs / 60000;
        if (gapMinutes >= 0) {
          const day = r.timestamp.substring(0, 10);
          if (!dayGaps[day]) dayGaps[day] = [];
          dayGaps[day].push(gapMinutes);
        }
      }
      prevSession = r.session_id;
      prevTimestamp = r.timestamp;
    }

    for (const [day, gaps] of Object.entries(dayGaps)) {
      db.upsertDailyMetric({
        date: day,
        metric_name: 'session_autonomy_median',
        metric_value: median(gaps),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 15. edit_churn_rate
  // -----------------------------------------------------------------------
  private computeEditChurnRate(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const calls = raw
      .prepare(
        `
      SELECT tc.session_id, tc.sequence_num, tc.category, tc.target_file,
             substr(tc.timestamp, 1, 10) AS day
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      ORDER BY tc.session_id, tc.sequence_num
    `,
      )
      .all(...pc.params) as {
      session_id: string;
      sequence_num: number;
      category: string;
      target_file: string | null;
      day: string;
    }[];

    const sessions: Record<string, typeof calls> = {};
    for (const c of calls) {
      if (!sessions[c.session_id]) sessions[c.session_id] = [];
      sessions[c.session_id].push(c);
    }

    const dayStats: Record<string, { totalEdits: number; churnEdits: number }> = {};

    for (const sessionCalls of Object.values(sessions)) {
      for (let windowStart = 0; windowStart <= sessionCalls.length - 10; windowStart++) {
        const window = sessionCalls.slice(windowStart, windowStart + 10);

        const fileEditIndices: Record<string, number[]> = {};
        const fileReadIndices: Record<string, number[]> = {};

        for (let i = 0; i < window.length; i++) {
          const c = window[i];
          if (!c.target_file) continue;
          if (c.category === 'edit') {
            if (!fileEditIndices[c.target_file]) fileEditIndices[c.target_file] = [];
            fileEditIndices[c.target_file].push(i);
          }
          if (c.category === 'read') {
            if (!fileReadIndices[c.target_file]) fileReadIndices[c.target_file] = [];
            fileReadIndices[c.target_file].push(i);
          }
        }

        for (const [file, editIdxs] of Object.entries(fileEditIndices)) {
          if (editIdxs.length < 3) continue;

          const readIdxs = fileReadIndices[file] || [];

          let hasReadBetweenEdits = false;
          for (let i = 0; i < editIdxs.length - 1; i++) {
            const between = readIdxs.some((ri) => ri > editIdxs[i] && ri < editIdxs[i + 1]);
            if (between) {
              hasReadBetweenEdits = true;
              break;
            }
          }

          if (!hasReadBetweenEdits) {
            for (const idx of editIdxs) {
              const call = window[idx];
              const day = call.day;
              if (!dayStats[day]) dayStats[day] = { totalEdits: 0, churnEdits: 0 };
              dayStats[day].churnEdits++;
            }
          }
        }
      }

      for (const c of sessionCalls) {
        if (c.category === 'edit') {
          if (!dayStats[c.day]) dayStats[c.day] = { totalEdits: 0, churnEdits: 0 };
          dayStats[c.day].totalEdits++;
        }
      }
    }

    for (const [day, stats] of Object.entries(dayStats)) {
      db.upsertDailyMetric({
        date: day,
        metric_name: 'edit_churn_rate',
        metric_value: safeDivide(stats.churnEdits, stats.totalEdits) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 16. bash_success_rate
  // -----------------------------------------------------------------------
  private computeBashSuccessRate(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
             SUM(CASE WHEN tc.bash_success = 1 THEN 1 ELSE 0 END) AS successes,
             COUNT(*) AS total
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL AND tc.bash_success IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; successes: number; total: number }[];

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'bash_success_rate',
        metric_value: safeDivide(r.successes, r.total) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 17. subagent_pct
  // -----------------------------------------------------------------------
  private computeSubagentPct(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
             SUM(CASE WHEN tc.category = 'agent' THEN 1 ELSE 0 END) AS agents,
             COUNT(*) AS total
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as { day: string; agents: number; total: number }[];

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'subagent_pct',
        metric_value: safeDivide(r.agents, r.total) * 100,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 18. context_pressure
  // -----------------------------------------------------------------------
  private computeContextPressure(db: VitalsDB, raw: Database.Database, provider: string): void {
    const sessionFilter = provider === '_all' ? '' : ' AND provider = ?';
    const sessionParams = provider === '_all' ? [] : [provider];
    const sessions = raw
      .prepare(
        `
      SELECT id, started_at FROM sessions
      WHERE started_at IS NOT NULL${sessionFilter}
    `,
      )
      .all(...sessionParams) as { id: string; started_at: string }[];

    const dayQuartileData: Record<
      string,
      {
        q1: { tools: number; mutations: number; blind_edits: number; bash_fails: number };
        q2: { tools: number; mutations: number; blind_edits: number; bash_fails: number };
        q3: { tools: number; mutations: number; blind_edits: number; bash_fails: number };
        q4: { tools: number; mutations: number; blind_edits: number; bash_fails: number };
      }
    > = {};

    const emptyQ = () => ({ tools: 0, mutations: 0, blind_edits: 0, bash_fails: 0 });

    const msgStmt = raw.prepare(`
      SELECT COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) AS tokens, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC, id ASC
    `);

    const tcStmt = raw.prepare(`
      SELECT sequence_num, timestamp, category, is_mutation, bash_success,
             ${dateExpr} AS day
      FROM tool_calls
      WHERE session_id = ? AND timestamp IS NOT NULL
      ORDER BY sequence_num ASC
    `);

    for (const session of sessions) {
      const messages = msgStmt.all(session.id) as { tokens: number; timestamp: string }[];
      if (messages.length === 0) continue;

      let cumulative = 0;
      const tokenTimeline: { timestamp: string; cumTokens: number }[] = [];
      for (const m of messages) {
        cumulative += m.tokens;
        tokenTimeline.push({ timestamp: m.timestamp, cumTokens: cumulative });
      }

      if (cumulative === 0) continue;

      const q1Max = cumulative * 0.25;
      const q2Max = cumulative * 0.5;
      const q3Max = cumulative * 0.75;

      const toolCalls = tcStmt.all(session.id) as {
        sequence_num: number;
        timestamp: string;
        category: string;
        is_mutation: number;
        bash_success: number | null;
        day: string;
      }[];

      for (const tc of toolCalls) {
        let tokensAtPoint = 0;
        for (const tl of tokenTimeline) {
          if (tl.timestamp <= tc.timestamp) tokensAtPoint = tl.cumTokens;
          else break;
        }

        const qKey =
          tokensAtPoint <= q1Max
            ? 'q1'
            : tokensAtPoint <= q2Max
              ? 'q2'
              : tokensAtPoint <= q3Max
                ? 'q3'
                : 'q4';

        if (!dayQuartileData[tc.day]) {
          dayQuartileData[tc.day] = { q1: emptyQ(), q2: emptyQ(), q3: emptyQ(), q4: emptyQ() };
        }
        const q = dayQuartileData[tc.day][qKey];
        q.tools++;
        if (tc.is_mutation) q.mutations++;
        if (tc.bash_success === 0) q.bash_fails++;
      }
    }

    for (const [day, data] of Object.entries(dayQuartileData)) {
      const detail = {} as Record<ContextQuartile, ContextQuartileDetail>;
      for (const qKey of ['q1', 'q2', 'q3', 'q4'] as const) {
        const q = data[qKey];
        detail[qKey] = {
          tool_calls: q.tools,
          mutation_rate: safeDivide(q.mutations, q.tools) * 100,
          bash_fail_rate: safeDivide(q.bash_fails, q.tools) * 100,
        };
      }

      const pressureValue = detail.q4.bash_fail_rate - detail.q1.bash_fail_rate;

      db.upsertDailyMetric({
        date: day,
        metric_name: 'context_pressure',
        metric_value: pressureValue,
        metric_detail: JSON.stringify(detail),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 19. cost_estimate
  // -----------------------------------------------------------------------
  private computeCostEstimate(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'm');
    const rows = raw
      .prepare(
        `
      SELECT substr(m.timestamp, 1, 10) AS day,
             SUM(COALESCE(m.input_tokens, 0)) AS input_tokens,
             SUM(COALESCE(m.output_tokens, 0)) AS output_tokens,
             SUM(COALESCE(m.cache_read_tokens, 0)) AS cache_read_tokens,
             SUM(COALESCE(m.cache_creation_tokens, 0)) AS cache_creation_tokens
      FROM messages m${pc.join}
      WHERE m.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as {
      day: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }[];

    for (const r of rows) {
      const cost =
        r.input_tokens * 0.000015 +
        r.output_tokens * 0.000075 +
        r.cache_read_tokens * 0.0000015 +
        r.cache_creation_tokens * 0.00001875;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'cost_estimate',
        metric_value: cost,
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 20. prompts_per_session
  // -----------------------------------------------------------------------
  private computePromptsPerSession(db: VitalsDB, raw: Database.Database, provider: string): void {
    const sessionFilter = provider === '_all' ? '' : ' AND s.provider = ?';
    const sessionParams = provider === '_all' ? [] : [provider];
    const rows = raw
      .prepare(
        `
      SELECT substr(s.started_at, 1, 10) AS day,
             COUNT(DISTINCT s.id) AS session_count,
             COUNT(up.id) AS prompt_count
      FROM sessions s
      LEFT JOIN user_prompts up ON up.session_id = s.id
      WHERE s.started_at IS NOT NULL${sessionFilter}
      GROUP BY day
    `,
      )
      .all(...sessionParams) as { day: string; session_count: number; prompt_count: number }[];

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'prompts_per_session',
        metric_value: safeDivide(r.prompt_count, r.session_count),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Grouping helpers
  // -----------------------------------------------------------------------

  private groupBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const row of rows) {
      const k = String(row[key]);
      if (!result[k]) result[k] = [];
      result[k].push(row);
    }
    return result;
  }

  private groupBy2<T extends Record<string, unknown>>(
    rows: T[],
    key1: keyof T,
    key2: keyof T,
  ): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const row of rows) {
      const k = `${row[key1]}\0${row[key2]}`;
      if (!result[k]) result[k] = [];
      result[k].push(row);
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // 21. time_of_day_quality — Read:Edit ratio by hour of day
  // -----------------------------------------------------------------------
  private computeTimeOfDayQuality(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT
        CAST(substr(tc.timestamp, 12, 2) AS INTEGER) AS hour,
        SUM(CASE WHEN tc.category = 'read' THEN 1 ELSE 0 END) AS reads,
        SUM(CASE WHEN tc.category = 'edit' THEN 1 ELSE 0 END) AS edits
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      GROUP BY hour
      ORDER BY hour
    `,
      )
      .all(...pc.params) as Array<{ hour: number; reads: number; edits: number }>;

    if (rows.length === 0) return;

    const hourData: Record<number, number> = {};
    for (const r of rows) {
      hourData[r.hour] = r.edits > 0 ? r.reads / r.edits : r.reads;
    }

    let bestHour = 0,
      worstHour = 0,
      bestRatio = 0,
      worstRatio = Infinity;
    for (const [h, ratio] of Object.entries(hourData)) {
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestHour = Number(h);
      }
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worstHour = Number(h);
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    db.upsertDailyMetric({
      date: today,
      metric_name: 'time_of_day_quality',
      metric_value: worstRatio,
      metric_detail: JSON.stringify({
        hourly: hourData,
        bestHour,
        bestRatio: Math.round(bestRatio * 10) / 10,
        worstHour,
        worstRatio: Math.round(worstRatio * 10) / 10,
      }),
      provider,
    });
  }

  // -----------------------------------------------------------------------
  // 22. tool_diversity — unique tools used per session (more = better research)
  // -----------------------------------------------------------------------
  private computeToolDiversity(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pc = providerClauses(provider, 'tc');
    const rows = raw
      .prepare(
        `
      SELECT substr(tc.timestamp, 1, 10) AS day,
        COUNT(DISTINCT tc.tool_name) AS unique_tools,
        COUNT(*) AS total_calls
      FROM tool_calls tc${pc.join}
      WHERE tc.timestamp IS NOT NULL${pc.where}
      GROUP BY day
    `,
      )
      .all(...pc.params) as Array<{ day: string; unique_tools: number; total_calls: number }>;

    for (const r of rows) {
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'tool_diversity',
        metric_value: r.unique_tools,
        metric_detail: JSON.stringify({ unique_tools: r.unique_tools, total_calls: r.total_calls }),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 23. token_efficiency — output tokens per successful edit
  // -----------------------------------------------------------------------
  private computeTokenEfficiency(db: VitalsDB, raw: Database.Database, provider: string): void {
    const pcM = providerClauses(provider, 'm');
    const editFilter =
      provider === '_all'
        ? ''
        : ' AND tc2.session_id IN (SELECT id FROM sessions WHERE provider = ?)';
    const params = provider === '_all' ? [...pcM.params] : [...pcM.params, provider];
    const rows = raw
      .prepare(
        `
      SELECT substr(m.timestamp, 1, 10) AS day,
        SUM(m.output_tokens) AS total_output,
        (SELECT COUNT(*) FROM tool_calls tc2
         WHERE tc2.category = 'edit'
           AND substr(tc2.timestamp, 1, 10) = substr(m.timestamp, 1, 10)${editFilter}) AS edits
      FROM messages m${pcM.join}
      WHERE m.timestamp IS NOT NULL AND m.output_tokens IS NOT NULL${pcM.where}
      GROUP BY day
    `,
      )
      .all(...params) as Array<{ day: string; total_output: number; edits: number }>;

    for (const r of rows) {
      const tokensPerEdit = r.edits > 0 ? r.total_output / r.edits : 0;
      db.upsertDailyMetric({
        date: r.day,
        metric_name: 'token_efficiency',
        metric_value: Math.round(tokensPerEdit),
        metric_detail: JSON.stringify({ total_output: r.total_output, edits: r.edits }),
        provider,
      });
    }
  }

  // -----------------------------------------------------------------------
  // 24. session_length_minutes — average session duration
  // -----------------------------------------------------------------------
  private computeSessionLength(db: VitalsDB, raw: Database.Database, provider: string): void {
    const sessionFilter = provider === '_all' ? '' : ' AND provider = ?';
    const sessionParams = provider === '_all' ? [] : [provider];
    const rows = raw
      .prepare(
        `
      SELECT substr(started_at, 1, 10) AS day,
        AVG(
          (julianday(ended_at) - julianday(started_at)) * 24 * 60
        ) AS avg_minutes
      FROM sessions
      WHERE started_at IS NOT NULL AND ended_at IS NOT NULL
        AND ended_at > started_at${sessionFilter}
      GROUP BY day
    `,
      )
      .all(...sessionParams) as Array<{ day: string; avg_minutes: number }>;

    for (const r of rows) {
      if (r.avg_minutes > 0) {
        db.upsertDailyMetric({
          date: r.day,
          metric_name: 'session_length_minutes',
          metric_value: Math.round(r.avg_minutes * 10) / 10,
          provider,
        });
      }
    }
  }
}
