import { VitalsDB } from '../db/database';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface MetricDef {
  key: string;
  label: string;
  higherIsBetter: boolean;
  format: 'ratio' | 'count' | 'pct' | 'currency' | 'depth';
  benchmark?: [number, number];
}

const ALL_METRICS: MetricDef[] = [
  { key: 'thinking_depth_median', label: 'Thinking Depth (median)', higherIsBetter: true, format: 'depth', benchmark: [2200, 600] },
  { key: 'thinking_depth_redacted_pct', label: 'Redacted Thinking %', higherIsBetter: false, format: 'pct' },
  { key: 'read_edit_ratio', label: 'Read : Edit Ratio', higherIsBetter: true, format: 'ratio', benchmark: [6.6, 2.0] },
  { key: 'research_mutation_ratio', label: 'Research : Mutation Ratio', higherIsBetter: true, format: 'ratio', benchmark: [8.7, 2.8] },
  { key: 'blind_edit_rate', label: 'Blind Edit Rate', higherIsBetter: false, format: 'pct', benchmark: [6.2, 33.7] },
  { key: 'write_vs_edit_pct', label: 'Write vs Edit %', higherIsBetter: false, format: 'pct', benchmark: [4.9, 11.1] },
  { key: 'first_tool_read_pct', label: 'First Tool = Read %', higherIsBetter: true, format: 'pct' },
  { key: 'reasoning_loops_per_1k', label: 'Reasoning Loops / 1k calls', higherIsBetter: false, format: 'ratio', benchmark: [8.2, 26.6] },
  { key: 'laziness_total', label: 'Laziness Violations / day', higherIsBetter: false, format: 'count', benchmark: [0, 10] },
  { key: 'self_admitted_failures_per_1k', label: 'Self-Admitted Failures / 1k', higherIsBetter: false, format: 'ratio', benchmark: [0.1, 0.5] },
  { key: 'user_interrupts_per_1k', label: 'User Interrupts / 1k', higherIsBetter: false, format: 'ratio', benchmark: [0.9, 11.4] },
  { key: 'sentiment_ratio', label: 'Sentiment Ratio (+/-)', higherIsBetter: true, format: 'ratio', benchmark: [4.4, 3.0] },
  { key: 'frustration_rate', label: 'Frustration Rate', higherIsBetter: false, format: 'pct', benchmark: [5.8, 9.8] },
  { key: 'session_autonomy_median', label: 'Session Autonomy (min)', higherIsBetter: true, format: 'ratio' },
  { key: 'prompts_per_session', label: 'Prompts / Session', higherIsBetter: true, format: 'ratio', benchmark: [35.9, 27.9] },
  { key: 'edit_churn_rate', label: 'Edit Churn Rate', higherIsBetter: false, format: 'pct' },
  { key: 'bash_success_rate', label: 'Bash Success Rate', higherIsBetter: true, format: 'pct' },
  { key: 'subagent_pct', label: 'Sub-agent Usage %', higherIsBetter: false, format: 'pct' },
  { key: 'cost_estimate', label: 'Daily Cost Estimate', higherIsBetter: false, format: 'currency' },
  { key: 'context_pressure', label: 'Context Pressure', higherIsBetter: false, format: 'ratio' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      return value.toFixed(1) + '%';
    case 'currency':
      return '$' + value.toFixed(2);
    case 'depth':
      return Math.round(value).toString();
  }
}

function trendEmoji(current: number, previous: number, higherIsBetter: boolean): string {
  if (previous === 0 && current === 0) return '\u2192';
  const changePct = previous === 0 ? 100 : ((current - previous) / Math.abs(previous)) * 100;

  if (Math.abs(changePct) <= 5) return '\u2192';

  const increased = changePct > 0;
  if (higherIsBetter) {
    return increased ? '\u2B06\uFE0F' : '\u2B07\uFE0F';
  } else {
    return increased ? '\u2B07\uFE0F' : '\u2B06\uFE0F';
  }
}

function benchmarkStatus(value: number, metric: MetricDef): string {
  if (!metric.benchmark) return '-';
  const [good, degraded] = metric.benchmark;

  if (metric.higherIsBetter) {
    if (value >= good) return '\u2705 Good';
    if (value <= degraded) return '\u274C Degraded';
    return '\u26A0\uFE0F Warning';
  } else {
    if (value <= good) return '\u2705 Good';
    if (value >= degraded) return '\u274C Degraded';
    return '\u26A0\uFE0F Warning';
  }
}

function benchmarkLabel(metric: MetricDef): string {
  if (!metric.benchmark) return '-';
  const [good, degraded] = metric.benchmark;
  return `${formatValue(good, metric.format)} / ${formatValue(degraded, metric.format)}`;
}

function detectRegressions(db: VitalsDB): { status: string; alerts: Array<{ metric: string; severity: string; message: string }> } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RegressionDetector } = require('../regression/detector');
    const detector = new RegressionDetector(db);
    const health = detector.getHealthStatus();
    const status = health.status === 'green' ? 'healthy' : health.status === 'yellow' ? 'warning' : 'critical';
    return {
      status,
      alerts: (health.alerts || []).map((a: any) => ({
        metric: a.metric,
        severity: a.severity,
        message: a.message,
      })),
    };
  } catch {
    // Inline fallback
  }

  const alerts: Array<{ metric: string; severity: string; message: string }> = [];

  const benchmarks: Array<{ key: string; good: number; degraded: number; higherIsBetter: boolean }> = [
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
    const avg = average(rows.map(r => r.value));

    const pastDegraded = b.higherIsBetter ? avg < b.degraded : avg > b.degraded;
    const pastGood = b.higherIsBetter ? avg >= b.good : avg <= b.good;

    if (pastDegraded) {
      alerts.push({
        metric: b.key,
        severity: 'critical',
        message: `${b.key} at ${avg.toFixed(1)} (degraded threshold: ${b.degraded})`,
      });
    } else if (!pastGood) {
      alerts.push({
        metric: b.key,
        severity: 'warning',
        message: `${b.key} at ${avg.toFixed(1)} (between good ${b.good} and degraded ${b.degraded})`,
      });
    }
  }

  const hasCritical = alerts.some(a => a.severity === 'critical');
  const hasWarning = alerts.some(a => a.severity === 'warning');
  const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';
  return { status, alerts };
}

// ---------------------------------------------------------------------------
// MarkdownReport
// ---------------------------------------------------------------------------

export class MarkdownReport {
  private db: VitalsDB;

  constructor(db: VitalsDB) {
    this.db = db;
  }

  generate(options: { days?: number } = {}): string {
    const days = options.days ?? 30;
    const lines: string[] = [];

    const dateRange = this.db.getDateRange();
    const sessionCount = this.db.getSessionCount();
    const toolCallCount = this.db.getToolCallCount();

    // Collect per-metric data
    const metricData: Record<string, { current7: number; previous7: number }> = {};
    for (const metric of ALL_METRICS) {
      const rows = this.db.getDailyMetrics(metric.key, 14);
      const values = rows.map(r => r.value);
      const midpoint = Math.max(0, values.length - 7);
      const current7 = values.slice(midpoint);
      const previous7 = values.slice(Math.max(0, midpoint - 7), midpoint);
      metricData[metric.key] = {
        current7: average(current7),
        previous7: average(previous7),
      };
    }

    const regressions = detectRegressions(this.db);

    // --- Title ---
    lines.push('# Claude Code Quality Report');
    lines.push('');
    if (dateRange && dateRange.min) {
      lines.push(`**Date range:** ${dateRange.min} to ${dateRange.max}`);
    }
    lines.push(`**Sessions scanned:** ${sessionCount} | **Tool calls:** ${toolCallCount}`);
    lines.push('');

    // --- Executive Summary ---
    lines.push('## Executive Summary');
    lines.push('');
    const statusEmoji = regressions.status === 'healthy' ? '\u2705' : regressions.status === 'warning' ? '\u26A0\uFE0F' : '\u274C';
    lines.push(`**Overall health:** ${statusEmoji} ${regressions.status.toUpperCase()}`);
    lines.push('');

    if (regressions.alerts.length > 0) {
      lines.push('**Key findings:**');
      const criticals = regressions.alerts.filter(a => a.severity === 'critical');
      const warnings = regressions.alerts.filter(a => a.severity === 'warning');
      if (criticals.length > 0) {
        lines.push(`- ${criticals.length} critical regression${criticals.length !== 1 ? 's' : ''} detected`);
      }
      if (warnings.length > 0) {
        lines.push(`- ${warnings.length} warning${warnings.length !== 1 ? 's' : ''} requiring attention`);
      }
      lines.push('');
    } else {
      lines.push('All metrics within healthy ranges. No regressions detected.');
      lines.push('');
    }

    // --- Key Metrics Table ---
    lines.push('## Key Metrics');
    lines.push('');
    lines.push('| Metric | Current (7d avg) | Previous (7d avg) | Trend | Benchmark (Good / Degraded) | Status |');
    lines.push('|--------|------------------:|-------------------:|:-----:|:---------------------------:|:------:|');

    for (const metric of ALL_METRICS) {
      const data = metricData[metric.key];
      if (!data) continue;

      const currentStr = formatValue(data.current7, metric.format);
      const prevStr = formatValue(data.previous7, metric.format);
      const trend = trendEmoji(data.current7, data.previous7, metric.higherIsBetter);
      const bench = benchmarkLabel(metric);
      const status = benchmarkStatus(data.current7, metric);

      lines.push(`| ${metric.label} | ${currentStr} | ${prevStr} | ${trend} | ${bench} | ${status} |`);
    }
    lines.push('');

    // --- Behavioral Analysis ---
    lines.push('## Behavioral Analysis');
    lines.push('');
    this.appendBehaviorSection(lines, metricData);

    // --- Thinking Depth Analysis ---
    lines.push('## Thinking Depth Analysis');
    lines.push('');
    this.appendThinkingSection(lines, metricData);

    // --- Quality Signals ---
    lines.push('## Quality Signals');
    lines.push('');
    this.appendQualitySection(lines, metricData);

    // --- User Experience ---
    lines.push('## User Experience');
    lines.push('');
    this.appendUserExperienceSection(lines, metricData);

    // --- Efficiency ---
    lines.push('## Efficiency');
    lines.push('');
    this.appendEfficiencySection(lines, metricData);

    // --- Change Impact Log ---
    lines.push('## Change Impact Log');
    lines.push('');
    this.appendChangesSection(lines);

    // --- Regression Alerts ---
    lines.push('## Regression Alerts');
    lines.push('');
    if (regressions.alerts.length === 0) {
      lines.push('No active regressions detected.');
    } else {
      lines.push('| Severity | Metric | Details |');
      lines.push('|:--------:|--------|---------|');
      for (const alert of regressions.alerts) {
        const sevIcon = alert.severity === 'critical' ? '\u274C' : alert.severity === 'warning' ? '\u26A0\uFE0F' : '\u2139\uFE0F';
        lines.push(`| ${sevIcon} ${alert.severity} | ${alert.metric} | ${alert.message} |`);
      }
    }
    lines.push('');

    // --- Footer ---
    lines.push('---');
    lines.push(`*Generated by Claude Vitals on ${new Date().toISOString().substring(0, 10)}*`);

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Section renderers
  // -------------------------------------------------------------------------

  private appendBehaviorSection(lines: string[], data: Record<string, { current7: number; previous7: number }>): void {
    const readEdit = data['read_edit_ratio'];
    const researchMut = data['research_mutation_ratio'];
    const blindEdit = data['blind_edit_rate'];
    const writeVsEdit = data['write_vs_edit_pct'];
    const firstTool = data['first_tool_read_pct'];

    lines.push('### Read:Edit Ratio');
    lines.push('');
    if (readEdit) {
      lines.push(`Current 7-day average: **${readEdit.current7.toFixed(1)}** (benchmark: 6.6 good, 2.0 degraded)`);
      lines.push('');
      lines.push('A high read:edit ratio indicates thorough research before making changes. ' +
        'Values above 6.0 suggest strong "read-first" discipline; values below 2.0 ' +
        'indicate the model is editing without sufficient context.');
    }
    lines.push('');

    lines.push('### Blind Edit Rate');
    lines.push('');
    if (blindEdit) {
      lines.push(`Current 7-day average: **${blindEdit.current7.toFixed(1)}%** (benchmark: 6.2% good, 33.7% degraded)`);
      lines.push('');
      lines.push('Measures the percentage of edits where the target file was not read ' +
        'in the preceding 10 tool calls. High blind edit rates correlate with ' +
        'increased churn and user frustration.');
    }
    lines.push('');

    lines.push('### First-Tool Patterns');
    lines.push('');
    if (firstTool) {
      lines.push(`Percentage of prompts where the first tool used is Read: **${firstTool.current7.toFixed(1)}%**`);
      lines.push('');
      lines.push('Starting with a read operation after receiving a user prompt is a strong ' +
        'quality signal -- it indicates the model seeks context before acting.');
    }
    lines.push('');

    if (researchMut) {
      lines.push(`Research:Mutation ratio: **${researchMut.current7.toFixed(1)}** (benchmark: 8.7 good, 2.8 degraded)`);
      lines.push('');
    }
    if (writeVsEdit) {
      lines.push(`Write vs Edit %: **${writeVsEdit.current7.toFixed(1)}%** (benchmark: 4.9% good, 11.1% degraded)`);
      lines.push('');
      lines.push('A lower write-vs-edit percentage means the model prefers surgical edits ' +
        'over full-file rewrites, which is generally safer and produces less churn.');
    }
    lines.push('');
  }

  private appendThinkingSection(lines: string[], data: Record<string, { current7: number; previous7: number }>): void {
    const depth = data['thinking_depth_median'];
    const redacted = data['thinking_depth_redacted_pct'];

    if (depth) {
      lines.push(`Median thinking depth: **${Math.round(depth.current7)}** characters (benchmark: 2200 good, 600 degraded)`);
      lines.push('');
      lines.push('Thinking depth measures the amount of internal reasoning the model performs ' +
        'before responding. Deeper thinking generally correlates with higher-quality ' +
        'outputs and fewer errors.');
    }
    lines.push('');

    if (redacted) {
      lines.push(`Redacted thinking blocks: **${redacted.current7.toFixed(1)}%** of all thinking blocks`);
      lines.push('');
      lines.push('Redacted thinking blocks have their content stripped but retain a signature. ' +
        'A high redaction rate may indicate the model is engaging in internal reasoning ' +
        'that cannot be inspected.');
    }
    lines.push('');
  }

  private appendQualitySection(lines: string[], data: Record<string, { current7: number; previous7: number }>): void {
    const loops = data['reasoning_loops_per_1k'];
    const laziness = data['laziness_total'];
    const failures = data['self_admitted_failures_per_1k'];
    const interrupts = data['user_interrupts_per_1k'];

    lines.push('| Signal | Value | Benchmark | Assessment |');
    lines.push('|--------|------:|:---------:|:----------:|');

    if (laziness) {
      lines.push(`| Laziness Violations / day | ${Math.round(laziness.current7)} | 0 good / 10 degraded | ${benchmarkStatus(laziness.current7, ALL_METRICS.find(m => m.key === 'laziness_total')!)} |`);
    }
    if (loops) {
      lines.push(`| Reasoning Loops / 1k | ${loops.current7.toFixed(1)} | 8.2 good / 26.6 degraded | ${benchmarkStatus(loops.current7, ALL_METRICS.find(m => m.key === 'reasoning_loops_per_1k')!)} |`);
    }
    if (failures) {
      lines.push(`| Self-Admitted Failures / 1k | ${failures.current7.toFixed(1)} | 0.1 good / 0.5 degraded | ${benchmarkStatus(failures.current7, ALL_METRICS.find(m => m.key === 'self_admitted_failures_per_1k')!)} |`);
    }
    if (interrupts) {
      lines.push(`| User Interrupts / 1k | ${interrupts.current7.toFixed(1)} | 0.9 good / 11.4 degraded | ${benchmarkStatus(interrupts.current7, ALL_METRICS.find(m => m.key === 'user_interrupts_per_1k')!)} |`);
    }
    lines.push('');

    lines.push('**Laziness violations** include ownership dodging, permission seeking, premature stopping, ' +
      'known-limitation excuses, and session-length complaints. Zero is the target.');
    lines.push('');

    lines.push('**Reasoning loops** ("oh wait", "actually", "let me reconsider") indicate the model ' +
      'is self-correcting mid-stream. Some amount is healthy, but high rates suggest ' +
      'the model is struggling with the task.');
    lines.push('');
  }

  private appendUserExperienceSection(lines: string[], data: Record<string, { current7: number; previous7: number }>): void {
    const sentiment = data['sentiment_ratio'];
    const frustration = data['frustration_rate'];
    const autonomy = data['session_autonomy_median'];
    const prompts = data['prompts_per_session'];

    if (sentiment) {
      lines.push(`**Sentiment ratio:** ${sentiment.current7.toFixed(1)} (positive/negative words; benchmark: 4.4 good, 3.0 degraded)`);
      lines.push('');
    }
    if (frustration) {
      lines.push(`**Frustration rate:** ${frustration.current7.toFixed(1)}% of prompts contain frustration signals (benchmark: 5.8% good, 9.8% degraded)`);
      lines.push('');
    }
    if (autonomy) {
      lines.push(`**Session autonomy (median):** ${autonomy.current7.toFixed(1)} minutes between user prompts`);
      lines.push('');
      lines.push('Higher autonomy means the model works longer stretches independently, ' +
        'requiring less hand-holding from the user.');
    }
    lines.push('');
    if (prompts) {
      lines.push(`**Prompts per session:** ${prompts.current7.toFixed(1)} (benchmark: 35.9 good, 27.9 degraded)`);
      lines.push('');
      lines.push('More prompts per session indicates longer, more productive sessions ' +
        'rather than short sessions where the user gives up.');
    }
    lines.push('');
  }

  private appendEfficiencySection(lines: string[], data: Record<string, { current7: number; previous7: number }>): void {
    const churn = data['edit_churn_rate'];
    const bash = data['bash_success_rate'];
    const subagent = data['subagent_pct'];
    const cost = data['cost_estimate'];
    const pressure = data['context_pressure'];

    lines.push('| Metric | Value |');
    lines.push('|--------|------:|');

    if (churn) {
      lines.push(`| Edit Churn Rate | ${churn.current7.toFixed(1)}% |`);
    }
    if (bash) {
      lines.push(`| Bash Success Rate | ${bash.current7.toFixed(1)}% |`);
    }
    if (subagent) {
      lines.push(`| Sub-agent Usage | ${subagent.current7.toFixed(1)}% |`);
    }
    if (cost) {
      lines.push(`| Daily Cost Estimate | $${cost.current7.toFixed(2)} |`);
    }
    if (pressure) {
      lines.push(`| Context Pressure | ${pressure.current7.toFixed(1)} |`);
    }
    lines.push('');

    lines.push('**Edit churn rate** measures repeated edits to the same file without intervening reads -- ' +
      'a sign the model is thrashing rather than making targeted corrections.');
    lines.push('');
    lines.push('**Context pressure** compares quality in the first quartile of context usage vs the last. ' +
      'Positive values indicate degradation as the context window fills up.');
    lines.push('');
  }

  private appendChangesSection(lines: string[]): void {
    const changes = this.db.getAllChanges();

    if (changes.length === 0) {
      lines.push('No changes recorded yet.');
      lines.push('');
      return;
    }

    for (const change of changes) {
      const dateStr = change.timestamp.substring(0, 16).replace('T', ' ');
      lines.push(`### ${dateStr} - ${change.description}`);
      lines.push('');
      lines.push(`**Type:** ${change.type}`);
      lines.push('');

      const impacts = this.db.getImpactResults(change.id);
      if (impacts.length > 0) {
        lines.push('| Metric | Before | After | Change | Verdict |');
        lines.push('|--------|-------:|------:|-------:|:-------:|');
        for (const impact of impacts) {
          const verdictIcon = impact.verdict === 'improved' ? '\u2705'
            : impact.verdict === 'degraded' ? '\u274C'
              : '\u2796';
          lines.push(
            `| ${impact.metric_name} | ${impact.before_value.toFixed(1)} | ${impact.after_value.toFixed(1)} | ${impact.change_pct >= 0 ? '+' : ''}${impact.change_pct.toFixed(1)}% | ${verdictIcon} ${impact.verdict} |`
          );
        }
        lines.push('');
      } else {
        lines.push('_No impact data available._');
        lines.push('');
      }
    }
  }
}
