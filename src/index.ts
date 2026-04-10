#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { VitalsDB } from './db/database';
import { Scanner } from './scanner/scanner';
import { MetricsAnalyzer } from './metrics/analyzer';
import { ChangeTracker } from './changes/tracker';
import { RegressionDetector } from './regression/detector';
import { TerminalReport } from './reports/terminal';
import { MarkdownReport } from './reports/markdown';
import { serveDashboard } from './dashboard/server';

const program = new Command();

program
  .name('claude-vitals')
  .description('Continuously monitor Claude Code quality by analyzing session logs')
  .version('1.0.0');

// --- scan ---
program
  .command('scan')
  .description('Ingest Claude Code session logs into the database')
  .option('-f, --force', 'Re-scan all sessions, even previously scanned ones')
  .option('-v, --verbose', 'Show detailed progress')
  .option('--db <path>', 'Custom database path')
  .action((opts) => {
    const db = new VitalsDB(opts.db);
    try {
      console.log(chalk.bold('Scanning Claude Code session logs...\n'));

      const scanner = new Scanner(db);
      const result = scanner.scan({ force: opts.force, verbose: opts.verbose });

      console.log(chalk.green(`\n✓ Scanned: ${result.scanned} sessions`));
      if (result.skipped > 0) console.log(chalk.gray(`  Skipped: ${result.skipped} (already scanned)`));
      if (result.errors > 0) console.log(chalk.yellow(`  Errors: ${result.errors}`));

      // Detect config changes
      console.log(chalk.bold('\nChecking for config changes...'));
      const tracker = new ChangeTracker(db);
      const changes = tracker.detectChanges();
      if (changes > 0) {
        console.log(chalk.green(`  Detected ${changes} config change(s)`));
      } else {
        console.log(chalk.gray('  No config changes detected'));
      }

      // Compute metrics
      console.log(chalk.bold('\nComputing metrics...'));
      const analyzer = new MetricsAnalyzer();
      analyzer.computeAll(db);
      console.log(chalk.green('✓ Metrics computed'));

      const totalSessions = db.getSessionCount();
      const totalToolCalls = db.getToolCallCount();
      console.log(chalk.bold(`\nTotal: ${totalSessions} sessions, ${totalToolCalls.toLocaleString()} tool calls in database`));
    } finally {
      db.close();
    }
  });

// --- report ---
program
  .command('report')
  .description('Generate a quality report')
  .option('-d, --days <number>', 'Number of days to include', '30')
  .option('-f, --format <format>', 'Output format: terminal or md', 'terminal')
  .option('-m, --model <model>', 'Filter by model')
  .option('-p, --project <project>', 'Filter by project')
  .option('--db <path>', 'Custom database path')
  .action((opts) => {
    const db = new VitalsDB(opts.db);
    try {
      if (opts.format === 'md' || opts.format === 'markdown') {
        const report = new MarkdownReport(db);
        console.log(report.generate({ days: parseInt(opts.days) }));
      } else {
        const report = new TerminalReport(db);
        report.generate({ days: parseInt(opts.days), model: opts.model, project: opts.project });
      }
    } finally {
      db.close();
    }
  });

// --- health ---
program
  .command('health')
  .description('One-line health status')
  .option('--db <path>', 'Custom database path')
  .action((opts) => {
    const db = new VitalsDB(opts.db);
    try {
      const detector = new RegressionDetector(db);
      const health = detector.getHealthStatus();

      const icon = health.status === 'green' ? '🟢' : health.status === 'yellow' ? '🟡' : '🔴';
      const colorFn = health.status === 'green' ? chalk.green : health.status === 'yellow' ? chalk.yellow : chalk.red;
      console.log(`${icon} ${colorFn(health.message)}`);

      if (health.alerts.length > 0) {
        console.log('');
        for (const alert of health.alerts) {
          const colorFn = alert.severity === 'critical' ? chalk.red : chalk.yellow;
          console.log(`  ${colorFn(alert.message)}`);
        }
      }
    } finally {
      db.close();
    }
  });

// --- dashboard ---
program
  .command('dashboard')
  .description('Launch the web dashboard')
  .option('-p, --port <number>', 'Port number', '7847')
  .option('--db <path>', 'Custom database path')
  .action((opts) => {
    const db = new VitalsDB(opts.db);
    serveDashboard(db, parseInt(opts.port));
  });

// --- compare ---
program
  .command('compare')
  .description('Compare two time periods side by side')
  .argument('<period1>', 'First period (e.g., 2024-01-01:2024-01-07)')
  .argument('<period2>', 'Second period (e.g., 2024-01-08:2024-01-14)')
  .option('--db <path>', 'Custom database path')
  .action((period1, period2, opts) => {
    const db = new VitalsDB(opts.db);
    try {
      const [start1, end1] = period1.split(':');
      const [start2, end2] = period2.split(':');

      if (!start1 || !end1 || !start2 || !end2) {
        console.error(chalk.red('Periods must be in format YYYY-MM-DD:YYYY-MM-DD'));
        process.exit(1);
      }

      const metrics = [
        'read_edit_ratio', 'thinking_depth_median', 'blind_edit_rate', 'laziness_total',
        'sentiment_ratio', 'frustration_rate', 'session_autonomy_median', 'bash_success_rate',
        'research_mutation_ratio', 'write_vs_edit_pct', 'reasoning_loops_per_1k',
        'self_admitted_failures_per_1k', 'user_interrupts_per_1k', 'edit_churn_rate',
        'subagent_pct', 'cost_estimate', 'prompts_per_session', 'first_tool_read_pct',
        'thinking_depth_redacted_pct', 'context_pressure'
      ];

      console.log(chalk.bold('\n  PERIOD COMPARISON\n'));
      console.log(chalk.gray(`  Period 1: ${start1} → ${end1}`));
      console.log(chalk.gray(`  Period 2: ${start2} → ${end2}\n`));

      const header = `  ${'Metric'.padEnd(32)} ${'Period 1'.padStart(10)} ${'Period 2'.padStart(10)} ${'Change'.padStart(10)}`;
      console.log(chalk.bold(header));
      console.log(chalk.gray('  ' + '─'.repeat(66)));

      for (const metric of metrics) {
        const data1 = db.getMetricForDateRange(metric, start1, end1);
        const data2 = db.getMetricForDateRange(metric, start2, end2);

        const avg1 = data1.length > 0 ? data1.reduce((s, d) => s + d.value, 0) / data1.length : 0;
        const avg2 = data2.length > 0 ? data2.reduce((s, d) => s + d.value, 0) / data2.length : 0;

        const changePct = avg1 !== 0 ? ((avg2 - avg1) / avg1 * 100) : 0;
        const changeStr = changePct > 0 ? `+${changePct.toFixed(1)}%` : `${changePct.toFixed(1)}%`;

        const higherIsBetter = ['read_edit_ratio', 'thinking_depth_median', 'sentiment_ratio',
          'session_autonomy_median', 'bash_success_rate', 'prompts_per_session',
          'research_mutation_ratio', 'first_tool_read_pct'].includes(metric);

        const isGood = higherIsBetter ? changePct > 5 : changePct < -5;
        const isBad = higherIsBetter ? changePct < -5 : changePct > 5;
        const colorFn = isGood ? chalk.green : isBad ? chalk.red : chalk.gray;

        const name = metric.replace(/_/g, ' ').padEnd(32);
        console.log(`  ${name} ${avg1.toFixed(1).padStart(10)} ${avg2.toFixed(1).padStart(10)} ${colorFn(changeStr.padStart(10))}`);
      }
      console.log('');
    } finally {
      db.close();
    }
  });

// --- annotate ---
program
  .command('annotate')
  .description('Log a manual change event')
  .argument('<description>', 'Description of the change')
  .option('--db <path>', 'Custom database path')
  .action((description, opts) => {
    const db = new VitalsDB(opts.db);
    try {
      const tracker = new ChangeTracker(db);
      tracker.addAnnotation(description);
      console.log(chalk.green(`✓ Annotation logged: "${description}"`));
    } finally {
      db.close();
    }
  });

// --- impact ---
program
  .command('impact')
  .description('Show before/after metrics for a specific change')
  .argument('<change-id>', 'Change ID (from report or annotate)')
  .option('--db <path>', 'Custom database path')
  .action((changeId, opts) => {
    const db = new VitalsDB(opts.db);
    try {
      const tracker = new ChangeTracker(db);
      const impact = tracker.computeImpact(parseInt(changeId));

      if (!impact) {
        console.log(chalk.red('Change not found'));
        process.exit(1);
      }

      console.log(chalk.bold(`\n  IMPACT ANALYSIS — Change #${changeId}\n`));
      console.log(chalk.gray(`  "${impact.description}" (${impact.timestamp})\n`));

      const header = `  ${'Metric'.padEnd(28)} ${'Before'.padStart(10)} ${'After'.padStart(10)} ${'Change'.padStart(10)} ${'Verdict'.padStart(10)}`;
      console.log(chalk.bold(header));
      console.log(chalk.gray('  ' + '─'.repeat(72)));

      let improved = 0, degraded = 0, stable = 0;

      for (const r of impact.results) {
        const changeStr = r.changePct > 0 ? `+${r.changePct.toFixed(1)}%` : `${r.changePct.toFixed(1)}%`;
        const verdictColor = r.verdict === 'improved' ? chalk.green : r.verdict === 'degraded' ? chalk.red : chalk.gray;

        const name = r.metric.replace(/_/g, ' ').padEnd(28);
        console.log(`  ${name} ${r.before.toFixed(1).padStart(10)} ${r.after.toFixed(1).padStart(10)} ${changeStr.padStart(10)} ${verdictColor(r.verdict.padStart(10))}`);

        if (r.verdict === 'improved') improved++;
        else if (r.verdict === 'degraded') degraded++;
        else stable++;
      }

      console.log('');
      const total = improved + degraded + stable;
      if (degraded === 0 && improved > 0) {
        console.log(chalk.green(`  ✓ This change IMPROVED quality across ${improved}/${total} key metrics`));
      } else if (improved === 0 && degraded > 0) {
        console.log(chalk.red(`  ✗ This change DEGRADED quality across ${degraded}/${total} key metrics`));
      } else {
        console.log(chalk.yellow(`  ~ Mixed impact: ${improved} improved, ${degraded} degraded, ${stable} stable`));
      }
      console.log('');
    } finally {
      db.close();
    }
  });

// --- list changes ---
program
  .command('changes')
  .description('List all tracked changes')
  .option('--db <path>', 'Custom database path')
  .action((opts) => {
    const db = new VitalsDB(opts.db);
    try {
      const changes = db.getAllChanges();
      if (changes.length === 0) {
        console.log(chalk.gray('No changes tracked yet. Run "claude-vitals scan" or "claude-vitals annotate"'));
        return;
      }

      console.log(chalk.bold('\n  TRACKED CHANGES\n'));
      for (const c of changes) {
        const typeColor = c.type === 'auto' ? chalk.blue : chalk.magenta;
        console.log(`  ${chalk.gray(`#${c.id}`)} ${typeColor(`[${c.type}]`)} ${c.description} ${chalk.gray(c.timestamp)}`);
      }
      console.log('');
    } finally {
      db.close();
    }
  });

program.parse();
