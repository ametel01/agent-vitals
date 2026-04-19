import type { VitalsDB } from '../db/database';

export interface RegressionAlert {
  metric: string;
  current: number;
  previous: number;
  changePct: number;
  threshold: number;
  severity: 'warning' | 'critical';
  message: string;
}

export interface HealthStatus {
  status: 'green' | 'yellow' | 'red';
  message: string;
  alerts: RegressionAlert[];
}

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------
// Each metric defines thresholds for warning and critical levels.
// direction: "drop" means the metric getting lower is bad (higher is better).
//            "rise" means the metric getting higher is bad (lower is better).
// mode: "pct" means the threshold is a percentage change.
//       "abs" means the threshold is an absolute difference in percentage points.

interface ThresholdConfig {
  direction: 'drop' | 'rise';
  mode: 'pct' | 'abs';
  warning: number;
  critical: number;
}

const THRESHOLDS: Record<string, ThresholdConfig> = {
  read_edit_ratio: {
    direction: 'drop',
    mode: 'pct',
    warning: 20,
    critical: 40,
  },
  thinking_depth_median: {
    direction: 'drop',
    mode: 'pct',
    warning: 15,
    critical: 30,
  },
  blind_edit_rate: {
    direction: 'rise',
    mode: 'abs',
    warning: 10,
    critical: 20,
  },
  laziness_total: {
    direction: 'rise',
    mode: 'pct',
    warning: 50,
    critical: 100,
  },
  sentiment_ratio: {
    direction: 'drop',
    mode: 'pct',
    warning: 15,
    critical: 30,
  },
  frustration_rate: {
    direction: 'rise',
    mode: 'pct',
    warning: 30,
    critical: 60,
  },
  session_autonomy_median: {
    direction: 'drop',
    mode: 'pct',
    warning: 25,
    critical: 50,
  },
  bash_success_rate: {
    direction: 'drop',
    mode: 'abs',
    warning: 10,
    critical: 20,
  },
};

// ---------------------------------------------------------------------------
// Human-readable metric labels
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  read_edit_ratio: 'Read/Edit ratio',
  thinking_depth_median: 'Thinking depth',
  blind_edit_rate: 'Blind edit rate',
  laziness_total: 'Laziness violations',
  sentiment_ratio: 'Sentiment ratio',
  frustration_rate: 'Frustration rate',
  session_autonomy_median: 'Session autonomy',
  bash_success_rate: 'Bash success rate',
};

// Metrics whose thresholds were calibrated on Claude session logs and are not
// portable to other providers (per Phase 4, Step 13 of the Codex plan).
// When the detector is scoped to a non-Claude provider, these are skipped.
const CLAUDE_ONLY_METRICS = new Set<string>([
  'thinking_depth_median',
  'thinking_depth_redacted_pct',
  'cost_estimate',
  'context_pressure',
]);

// ---------------------------------------------------------------------------
// RegressionDetector
// ---------------------------------------------------------------------------

export class RegressionDetector {
  private db: VitalsDB;
  private provider: string;

  constructor(db: VitalsDB, provider: string = '_all') {
    this.db = db;
    this.provider = provider;
  }

  // -------------------------------------------------------------------------
  // detect — compare rolling 7-day windows and flag regressions
  // -------------------------------------------------------------------------

  detect(): RegressionAlert[] {
    const alerts: RegressionAlert[] = [];

    // Determine date boundaries for the two 7-day windows.
    // "Current" = most recent 7 days, "Previous" = the 7 days before that.
    const latestRow = this.db.getDateRange(this.provider);
    if (!latestRow?.max) return alerts;

    const latestDate = new Date(latestRow.max);

    // Current window: latestDate - 6 days .. latestDate
    const currentEnd = this.fmtDate(latestDate);
    const currentStartDate = new Date(latestDate);
    currentStartDate.setDate(currentStartDate.getDate() - 6);
    const currentStart = this.fmtDate(currentStartDate);

    // Previous window: currentStartDate - 7 days .. currentStartDate - 1 day
    const previousEndDate = new Date(currentStartDate);
    previousEndDate.setDate(previousEndDate.getDate() - 1);
    const previousEnd = this.fmtDate(previousEndDate);
    const previousStartDate = new Date(previousEndDate);
    previousStartDate.setDate(previousStartDate.getDate() - 6);
    const previousStart = this.fmtDate(previousStartDate);

    const isNonClaudeProvider = this.provider !== '_all' && this.provider !== 'claude';

    for (const [metric, config] of Object.entries(THRESHOLDS)) {
      // Skip Claude-calibrated metrics for other providers (e.g. Codex) — their
      // thresholds have not been calibrated and would produce confident but
      // invalid alerts.
      if (isNonClaudeProvider && CLAUDE_ONLY_METRICS.has(metric)) continue;

      const currentRows = this.db.getMetricForDateRange(
        metric,
        currentStart,
        currentEnd,
        this.provider,
      );
      const previousRows = this.db.getMetricForDateRange(
        metric,
        previousStart,
        previousEnd,
        this.provider,
      );

      // Need data in both windows to compare
      if (currentRows.length === 0 || previousRows.length === 0) continue;

      const currentAvg = this.average(currentRows.map((r) => r.value));
      const previousAvg = this.average(previousRows.map((r) => r.value));

      // Compute the change value depending on mode
      let changeValue: number;
      if (config.mode === 'pct') {
        // Percentage change relative to previous value
        if (previousAvg === 0) {
          changeValue = currentAvg === 0 ? 0 : 100;
        } else {
          changeValue = ((currentAvg - previousAvg) / previousAvg) * 100;
        }
      } else {
        // Absolute difference in percentage points
        changeValue = currentAvg - previousAvg;
      }

      // Determine if the change is in the bad direction
      let badMagnitude: number;
      if (config.direction === 'drop') {
        // Bad when value drops (changeValue is negative)
        badMagnitude = -changeValue; // positive when dropping
      } else {
        // Bad when value rises (changeValue is positive)
        badMagnitude = changeValue; // positive when rising
      }

      // Skip if the change is not in the bad direction
      if (badMagnitude <= 0) continue;

      const label = METRIC_LABELS[metric] || metric;

      // Check critical first, then warning
      if (badMagnitude >= config.critical) {
        alerts.push({
          metric,
          current: round2(currentAvg),
          previous: round2(previousAvg),
          changePct: round2(changeValue),
          threshold: config.critical,
          severity: 'critical',
          message: `CRITICAL: ${label} ${config.direction === 'drop' ? 'dropped' : 'rose'} by ${round2(badMagnitude)}${config.mode === 'pct' ? '%' : 'pp'} (threshold: ${config.critical}${config.mode === 'pct' ? '%' : 'pp'})`,
        });
      } else if (badMagnitude >= config.warning) {
        alerts.push({
          metric,
          current: round2(currentAvg),
          previous: round2(previousAvg),
          changePct: round2(changeValue),
          threshold: config.warning,
          severity: 'warning',
          message: `WARNING: ${label} ${config.direction === 'drop' ? 'dropped' : 'rose'} by ${round2(badMagnitude)}${config.mode === 'pct' ? '%' : 'pp'} (threshold: ${config.warning}${config.mode === 'pct' ? '%' : 'pp'})`,
        });
      }
    }

    return alerts;
  }

  // -------------------------------------------------------------------------
  // getHealthStatus — overall health based on regression alerts
  // -------------------------------------------------------------------------

  getHealthStatus(): HealthStatus {
    const alerts = this.detect();

    if (alerts.length === 0) {
      return {
        status: 'green',
        message: 'All metrics are stable -- no regressions detected.',
        alerts,
      };
    }

    const hasCritical = alerts.some((a) => a.severity === 'critical');

    if (hasCritical) {
      const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
      return {
        status: 'red',
        message: `${criticalCount} critical regression${criticalCount > 1 ? 's' : ''} detected -- immediate attention needed.`,
        alerts,
      };
    }

    const warningCount = alerts.length;
    return {
      status: 'yellow',
      message: `${warningCount} warning${warningCount > 1 ? 's' : ''} detected -- quality metrics are trending down.`,
      alerts,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return sum / values.length;
  }

  private fmtDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
