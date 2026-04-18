import chalk from 'chalk';
import type { VitalsDB } from '../db/database';
import { RegressionDetector } from '../regression/detector';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface MetricDef {
  key: string;
  label: string;
  higherIsBetter: boolean;
  format: 'ratio' | 'count' | 'pct' | 'currency' | 'depth';
  /** Reference benchmarks [good, degraded].  undefined = no benchmark. */
  benchmark?: [number, number];
}

const METRIC_SECTIONS: Array<{ title: string; metrics: MetricDef[] }> = [
  {
    title: 'THINKING',
    metrics: [
      {
        key: 'thinking_depth_median',
        label: 'Thinking Depth (median)',
        higherIsBetter: true,
        format: 'depth',
        benchmark: [2200, 600],
      },
      {
        key: 'thinking_depth_redacted_pct',
        label: 'Redacted Thinking %',
        higherIsBetter: false,
        format: 'pct',
      },
    ],
  },
  {
    title: 'BEHAVIOR',
    metrics: [
      {
        key: 'read_edit_ratio',
        label: 'Read : Edit Ratio',
        higherIsBetter: true,
        format: 'ratio',
        benchmark: [6.6, 2.0],
      },
      {
        key: 'research_mutation_ratio',
        label: 'Research : Mutation Ratio',
        higherIsBetter: true,
        format: 'ratio',
        benchmark: [8.7, 2.8],
      },
      {
        key: 'blind_edit_rate',
        label: 'Blind Edit Rate',
        higherIsBetter: false,
        format: 'pct',
        benchmark: [6.2, 33.7],
      },
      {
        key: 'write_vs_edit_pct',
        label: 'Write vs Edit %',
        higherIsBetter: false,
        format: 'pct',
        benchmark: [4.9, 11.1],
      },
      {
        key: 'first_tool_read_pct',
        label: 'First Tool = Read %',
        higherIsBetter: true,
        format: 'pct',
      },
    ],
  },
  {
    title: 'QUALITY SIGNALS',
    metrics: [
      {
        key: 'reasoning_loops_per_1k',
        label: 'Reasoning Loops / 1k calls',
        higherIsBetter: false,
        format: 'ratio',
        benchmark: [8.2, 26.6],
      },
      {
        key: 'laziness_total',
        label: 'Laziness Violations',
        higherIsBetter: false,
        format: 'count',
        benchmark: [0, 10],
      },
      {
        key: 'self_admitted_failures_per_1k',
        label: 'Self-Admitted Failures / 1k',
        higherIsBetter: false,
        format: 'ratio',
        benchmark: [0.1, 0.5],
      },
      {
        key: 'user_interrupts_per_1k',
        label: 'User Interrupts / 1k',
        higherIsBetter: false,
        format: 'ratio',
        benchmark: [0.9, 11.4],
      },
    ],
  },
  {
    title: 'USER EXPERIENCE',
    metrics: [
      {
        key: 'sentiment_ratio',
        label: 'Sentiment Ratio (+/-)',
        higherIsBetter: true,
        format: 'ratio',
        benchmark: [4.4, 3.0],
      },
      {
        key: 'frustration_rate',
        label: 'Frustration Rate',
        higherIsBetter: false,
        format: 'pct',
        benchmark: [5.8, 9.8],
      },
      {
        key: 'session_autonomy_median',
        label: 'Session Autonomy (min)',
        higherIsBetter: true,
        format: 'ratio',
      },
      {
        key: 'prompts_per_session',
        label: 'Prompts / Session',
        higherIsBetter: true,
        format: 'ratio',
        benchmark: [35.9, 27.9],
      },
    ],
  },
  {
    title: 'EFFICIENCY',
    metrics: [
      { key: 'edit_churn_rate', label: 'Edit Churn Rate', higherIsBetter: false, format: 'pct' },
      { key: 'bash_success_rate', label: 'Bash Success Rate', higherIsBetter: true, format: 'pct' },
      { key: 'subagent_pct', label: 'Sub-agent Usage %', higherIsBetter: false, format: 'pct' },
      {
        key: 'cost_estimate',
        label: 'Daily Cost Estimate',
        higherIsBetter: false,
        format: 'currency',
      },
    ],
  },
  {
    title: 'CONTEXT',
    metrics: [
      {
        key: 'context_pressure',
        label: 'Context Pressure',
        higherIsBetter: false,
        format: 'ratio',
      },
    ],
  },
];

/** All metric keys in a flat list, preserving section order. */
const ALL_METRIC_KEYS = METRIC_SECTIONS.flatMap((s) => s.metrics.map((m) => m.key));

// Sparkline characters, ordered lowest to highest.
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return values
    .map((v) => {
      if (range === 0) return SPARK_CHARS[3]; // midpoint when all values equal
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[Math.min(idx, SPARK_CHARS.length - 1)];
    })
    .join('');
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function formatValue(value: number, format: MetricDef['format']): string {
  switch (format) {
    case 'ratio':
      return value.toFixed(1);
    case 'count':
      return Math.round(value).toString();
    case 'pct':
      return `${value.toFixed(1)}%`;
    case 'currency':
      return `$${value.toFixed(2)}`;
    case 'depth':
      return Math.round(value).toString();
  }
}

function trendArrow(current: number, previous: number, higherIsBetter: boolean): string {
  if (previous === 0 && current === 0) return chalk.gray('\u2192');
  const changePct = previous === 0 ? 100 : ((current - previous) / Math.abs(previous)) * 100;

  if (Math.abs(changePct) <= 5) {
    return chalk.gray('\u2192'); // stable
  }

  const increased = changePct > 0;
  if (higherIsBetter) {
    return increased ? chalk.green('\u2191') : chalk.red('\u2193');
  } else {
    return increased ? chalk.red('\u2191') : chalk.green('\u2193');
  }
}

// ANSI escape codes begin with the 0x1B control character; stripping them is intentional here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping
const ANSI_ESCAPE = /\x1B\[[0-9;]*m/g;

function padRight(str: string, len: number): string {
  const visible = str.replace(ANSI_ESCAPE, '');
  const pad = Math.max(0, len - visible.length);
  return str + ' '.repeat(pad);
}

function padLeft(str: string, len: number): string {
  const visible = str.replace(ANSI_ESCAPE, '');
  const pad = Math.max(0, len - visible.length);
  return ' '.repeat(pad) + str;
}

// ---------------------------------------------------------------------------
// RegressionDetector stub
// ---------------------------------------------------------------------------

/**
 * Lightweight inline regression detector.
 *
 * The canonical implementation will live at ../regression/detector once that
 * module is created.  We import it dynamically if available, and fall back to
 * this minimal implementation so the report can always be generated.
 */
interface RegressionAlert {
  metric: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  currentValue: number;
  threshold: number;
}

function detectRegressions(db: VitalsDB): {
  status: 'healthy' | 'warning' | 'critical';
  alerts: RegressionAlert[];
} {
  try {
    const detector = new RegressionDetector(db);
    const health = detector.getHealthStatus();
    const status: 'healthy' | 'warning' | 'critical' =
      health.status === 'green' ? 'healthy' : health.status === 'yellow' ? 'warning' : 'critical';
    return {
      status,
      alerts: (health.alerts || []).map((a) => ({
        metric: a.metric,
        severity: a.severity,
        message: a.message,
        currentValue: a.current,
        threshold: a.threshold,
      })),
    };
  } catch {
    // Fall back to inline detection
  }

  const alerts: RegressionAlert[] = [];

  const benchmarks: Array<{
    key: string;
    good: number;
    degraded: number;
    higherIsBetter: boolean;
  }> = [
    { key: 'read_edit_ratio', good: 6.6, degraded: 2.0, higherIsBetter: true },
    { key: 'research_mutation_ratio', good: 8.7, degraded: 2.8, higherIsBetter: true },
    { key: 'blind_edit_rate', good: 6.2, degraded: 33.7, higherIsBetter: false },
    { key: 'write_vs_edit_pct', good: 4.9, degraded: 11.1, higherIsBetter: false },
    { key: 'reasoning_loops_per_1k', good: 8.2, degraded: 26.6, higherIsBetter: false },
    { key: 'laziness_total', good: 0, degraded: 10, higherIsBetter: false },
    { key: 'self_admitted_failures_per_1k', good: 0.1, degraded: 0.5, higherIsBetter: false },
    { key: 'user_interrupts_per_1k', good: 0.9, degraded: 11.4, higherIsBetter: false },
    { key: 'sentiment_ratio', good: 4.4, degraded: 3.0, higherIsBetter: true },
    { key: 'frustration_rate', good: 5.8, degraded: 9.8, higherIsBetter: false },
    { key: 'thinking_depth_median', good: 2200, degraded: 600, higherIsBetter: true },
    { key: 'prompts_per_session', good: 35.9, degraded: 27.9, higherIsBetter: true },
  ];

  for (const b of benchmarks) {
    const rows = db.getDailyMetrics(b.key, 7);
    if (rows.length === 0) continue;
    const avg = average(rows.map((r) => r.value));

    const pastDegraded = b.higherIsBetter ? avg < b.degraded : avg > b.degraded;
    const pastGood = b.higherIsBetter ? avg >= b.good : avg <= b.good;

    if (pastDegraded) {
      alerts.push({
        metric: b.key,
        severity: 'critical',
        message: `${b.key} at ${formatValue(avg, 'ratio')} (degraded threshold: ${b.degraded})`,
        currentValue: avg,
        threshold: b.degraded,
      });
    } else if (!pastGood) {
      alerts.push({
        metric: b.key,
        severity: 'warning',
        message: `${b.key} at ${formatValue(avg, 'ratio')} (between good ${b.good} and degraded ${b.degraded})`,
        currentValue: avg,
        threshold: b.good,
      });
    }
  }

  const hasCritical = alerts.some((a) => a.severity === 'critical');
  const hasWarning = alerts.some((a) => a.severity === 'warning');
  const status: 'healthy' | 'warning' | 'critical' = hasCritical
    ? 'critical'
    : hasWarning
      ? 'warning'
      : 'healthy';
  return { status, alerts };
}

// ---------------------------------------------------------------------------
// TerminalReport
// ---------------------------------------------------------------------------

export class TerminalReport {
  private db: VitalsDB;

  constructor(db: VitalsDB) {
    this.db = db;
  }

  generate(options: { days?: number; model?: string; project?: string } = {}): void {
    const _days = options.days ?? 30;

    // Gather aggregate data for the header
    const dateRange = this.db.getDateRange();
    const sessionCount = this.db.getSessionCount();
    const toolCallCount = this.db.getToolCallCount();

    // Collect per-metric data: last 14 days for sparklines, split 7+7 for trend
    const metricData: Record<string, { values14: number[]; current7: number; previous7: number }> =
      {};

    for (const key of ALL_METRIC_KEYS) {
      const rows = this.db.getDailyMetrics(key, 14, options.model, options.project);
      const values = rows.map((r) => r.value);

      // Split into previous 7 and current 7
      const midpoint = Math.max(0, values.length - 7);
      const current7 = values.slice(midpoint);
      const previous7 = values.slice(Math.max(0, midpoint - 7), midpoint);

      metricData[key] = {
        values14: values,
        current7: average(current7),
        previous7: average(previous7),
      };
    }

    // Regression detection
    const regressions = detectRegressions(this.db);

    // --- Render ---

    // Header
    console.log('');
    console.log(
      chalk.bold.cyan('  ╔══════════════════════════════════════════════════════════════════╗'),
    );
    console.log(
      chalk.bold.cyan('  ║') +
        chalk.bold.white('           CLAUDE VITALS REPORT                                ') +
        chalk.bold.cyan('║'),
    );
    console.log(
      chalk.bold.cyan('  ╚══════════════════════════════════════════════════════════════════╝'),
    );
    console.log('');

    if (dateRange?.min) {
      console.log(chalk.gray(`  Date range: ${dateRange.min} to ${dateRange.max}`));
    }
    console.log(chalk.gray(`  Sessions scanned: ${sessionCount}    Tool calls: ${toolCallCount}`));
    console.log('');

    // Health status
    const statusLabel =
      regressions.status === 'healthy'
        ? chalk.bgGreen.black(' HEALTHY ')
        : regressions.status === 'warning'
          ? chalk.bgYellow.black(' WARNING ')
          : chalk.bgRed.white(' CRITICAL ');
    console.log(
      `  Health: ${statusLabel}${chalk.gray(` (${regressions.alerts.length} alert${regressions.alerts.length !== 1 ? 's' : ''})`)}`,
    );
    console.log('');

    // Key Metrics Table
    const COL_NAME = 32;
    const COL_CURRENT = 12;
    const COL_PREV = 12;
    const COL_TREND = 4;
    const COL_SPARK = 16;

    const headerLine = chalk.gray(
      '  ' +
        padRight('Metric', COL_NAME) +
        padLeft('Current', COL_CURRENT) +
        padLeft('Previous', COL_PREV) +
        padLeft('', COL_TREND) +
        '  Trend',
    );
    console.log(headerLine);
    console.log(
      chalk.gray(
        `  ${'\u2500'.repeat(COL_NAME + COL_CURRENT + COL_PREV + COL_TREND + COL_SPARK + 2)}`,
      ),
    );

    for (const section of METRIC_SECTIONS) {
      console.log('');
      console.log(chalk.bold.white(`  ${section.title}`));

      for (const metric of section.metrics) {
        const data = metricData[metric.key];
        if (!data) continue;

        const nameStr = padRight(`  ${metric.label}`, COL_NAME + 2);
        const currentStr = padLeft(formatValue(data.current7, metric.format), COL_CURRENT);
        const prevStr = padLeft(formatValue(data.previous7, metric.format), COL_PREV);
        const arrow = trendArrow(data.current7, data.previous7, metric.higherIsBetter);
        const spark = sparkline(data.values14);

        console.log(
          chalk.white(nameStr) +
            chalk.bold.white(currentStr) +
            chalk.gray(prevStr) +
            '  ' +
            arrow +
            '  ' +
            chalk.cyan(spark),
        );
      }
    }

    console.log('');
    console.log(
      chalk.gray(
        `  ${'\u2500'.repeat(COL_NAME + COL_CURRENT + COL_PREV + COL_TREND + COL_SPARK + 2)}`,
      ),
    );

    // Regression Alerts
    if (regressions.alerts.length > 0) {
      console.log('');
      console.log(chalk.bold.white('  REGRESSION ALERTS'));
      console.log('');

      for (const alert of regressions.alerts) {
        const icon =
          alert.severity === 'critical'
            ? chalk.red('\u2718')
            : alert.severity === 'warning'
              ? chalk.yellow('\u26A0')
              : chalk.blue('\u2139');
        const sevColor =
          alert.severity === 'critical'
            ? chalk.red
            : alert.severity === 'warning'
              ? chalk.yellow
              : chalk.blue;
        console.log(`  ${icon} ${sevColor(alert.message)}`);
      }
    }

    // Recent Changes
    const changes = this.db.getAllChanges().slice(0, 5);
    if (changes.length > 0) {
      console.log('');
      console.log(chalk.bold.white('  RECENT CHANGES'));
      console.log('');

      for (const change of changes) {
        const dateStr = change.timestamp.substring(0, 16).replace('T', ' ');
        const typeColor = change.type === 'auto' ? chalk.cyan : chalk.magenta;
        console.log(
          '  ' +
            chalk.gray(dateStr) +
            '  ' +
            typeColor(`[${change.type}]`) +
            '  ' +
            chalk.white(change.description),
        );

        // Show impact if available
        const impacts = this.db.getImpactResults(change.id);
        if (impacts.length > 0) {
          const improved = impacts.filter((i) => i.verdict === 'improved').length;
          const degraded = impacts.filter((i) => i.verdict === 'degraded').length;
          const stable = impacts.filter((i) => i.verdict === 'stable').length;
          console.log(
            chalk.gray('    Impact: ') +
              chalk.green(`${improved} improved`) +
              chalk.gray(', ') +
              chalk.red(`${degraded} degraded`) +
              chalk.gray(', ') +
              chalk.gray(`${stable} stable`),
          );
        }
      }
    }

    console.log('');
  }
}
