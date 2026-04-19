import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VitalsDB } from '../db/database';

// Metrics where a higher value is "good"
const HIGHER_IS_BETTER = new Set([
  'read_edit_ratio',
  'thinking_depth_median',
  'sentiment_ratio',
  'session_autonomy_median',
  'bash_success_rate',
]);

// Metrics where a lower value is "good"
const LOWER_IS_BETTER = new Set(['blind_edit_rate', 'laziness_total', 'frustration_rate']);

const IMPACT_METRICS = [
  'read_edit_ratio',
  'thinking_depth_median',
  'blind_edit_rate',
  'laziness_total',
  'sentiment_ratio',
  'frustration_rate',
  'session_autonomy_median',
  'bash_success_rate',
];

const MAX_SNAPSHOT_BYTES = 50 * 1024; // 50KB cap for content snapshots

export interface ImpactSummary {
  changeId: number;
  description: string;
  timestamp: string;
  results: Array<{
    metric: string;
    before: number;
    after: number;
    changePct: number;
    verdict: 'improved' | 'degraded' | 'stable';
  }>;
}

export class ChangeTracker {
  private db: VitalsDB;

  constructor(db: VitalsDB) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // detectChanges — scan config files and record any that have changed
  // ---------------------------------------------------------------------------

  detectChanges(provider: 'claude' | 'codex' | 'all' = 'claude'): number {
    let count = 0;
    if (provider === 'claude' || provider === 'all') count += this.detectClaudeChanges();
    if (provider === 'codex' || provider === 'all') count += this.detectCodexChanges();
    return count;
  }

  private detectClaudeChanges(): number {
    const homeDir = os.homedir();
    const claudeDir = path.join(homeDir, '.claude');
    const filesToCheck: string[] = [];

    // 1. ~/.claude/CLAUDE.md
    filesToCheck.push(path.join(claudeDir, 'CLAUDE.md'));

    // 2. Per-project CLAUDE.md files: ~/.claude/projects/*/CLAUDE.md
    const projectsDir = path.join(claudeDir, 'projects');
    if (this.isDirectory(projectsDir)) {
      try {
        const projectDirs = fs.readdirSync(projectsDir);
        for (const dir of projectDirs) {
          const fullDir = path.join(projectsDir, dir);
          if (this.isDirectory(fullDir)) {
            filesToCheck.push(path.join(fullDir, 'CLAUDE.md'));
          }
        }
      } catch {
        // projects dir not readable — skip
      }
    }

    // 3. ~/.claude/settings.json
    filesToCheck.push(path.join(claudeDir, 'settings.json'));

    // 4. Skill files: ~/.claude/commands/**/*.md
    const commandsDir = path.join(claudeDir, 'commands');
    if (this.isDirectory(commandsDir)) {
      this.collectMdFiles(commandsDir, filesToCheck);
    }

    return this.processFiles(filesToCheck, 'claude');
  }

  private detectCodexChanges(): number {
    const homeDir = os.homedir();
    const codexDir = path.join(homeDir, '.codex');
    const cwd = process.cwd();
    const filesToCheck: string[] = [];

    // 1. ~/.codex/config.toml
    filesToCheck.push(path.join(codexDir, 'config.toml'));

    // 2. ~/.codex/rules/**/*.rules
    const rulesDir = path.join(codexDir, 'rules');
    if (this.isDirectory(rulesDir)) {
      this.collectFilesWithExt(rulesDir, '.rules', filesToCheck);
    }

    // 3. ~/.codex/skills/**/SKILL.md
    const skillsDir = path.join(codexDir, 'skills');
    if (this.isDirectory(skillsDir)) {
      this.collectFilesByName(skillsDir, 'SKILL.md', filesToCheck);
    }

    // 4. Project AGENTS.md
    filesToCheck.push(path.join(cwd, 'AGENTS.md'));

    // 5. Project .codex — markdown, toml, rules files
    const projectCodexDir = path.join(cwd, '.codex');
    if (this.isDirectory(projectCodexDir)) {
      this.collectFilesByExts(projectCodexDir, ['.md', '.toml', '.rules'], filesToCheck);
    }

    // 6. Project .agents — markdown files
    const projectAgentsDir = path.join(cwd, '.agents');
    if (this.isDirectory(projectAgentsDir)) {
      this.collectMdFiles(projectAgentsDir, filesToCheck);
    }

    return this.processFiles(filesToCheck, 'codex');
  }

  private processFiles(filesToCheck: string[], provider: 'claude' | 'codex'): number {
    let changesDetected = 0;
    for (const filePath of filesToCheck) {
      if (!this.fileExists(filePath)) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const hash = crypto.createHash('sha256').update(content).digest('hex');

        // Check if we already have this exact hash stored for this file
        const lastHash = this.getLastStoredHash(filePath, provider);
        if (lastHash === hash) continue;

        // Content changed (or first time seeing this file) — record it
        const snapshot =
          content.length > MAX_SNAPSHOT_BYTES ? content.slice(0, MAX_SNAPSHOT_BYTES) : content;

        const wordCount = content.split(/\s+/).filter(Boolean).length;
        const filename = path.basename(filePath);

        this.db.insertChange({
          timestamp: new Date().toISOString(),
          type: 'auto',
          description: `${filename} changed`,
          file_path: filePath,
          file_hash: hash,
          content_snapshot: snapshot,
          word_count: wordCount,
          provider,
        });

        changesDetected++;
      } catch {
        // File unreadable — skip gracefully
      }
    }
    return changesDetected;
  }

  // ---------------------------------------------------------------------------
  // addAnnotation — insert a manual change entry
  // ---------------------------------------------------------------------------

  addAnnotation(description: string, provider: string = '_all'): number {
    return this.db.insertChange({
      timestamp: new Date().toISOString(),
      type: 'manual',
      description,
      provider,
    });
  }

  // ---------------------------------------------------------------------------
  // computeImpact — measure before/after effect of a change on key metrics
  // ---------------------------------------------------------------------------

  computeImpact(changeId: number, provider: string = '_all'): ImpactSummary | null {
    // Retrieve the change record
    const change = this.db.db
      .prepare('SELECT id, timestamp, description, provider FROM changes WHERE id = ?')
      .get(changeId) as
      | { id: number; timestamp: string; description: string; provider: string }
      | undefined;

    if (!change) return null;

    // If the caller asked for a concrete provider but this change was recorded
    // against the other concrete provider, refuse to compute impact — the
    // windows would mix unrelated sources. Changes stored as '_all' (global)
    // are valid for any concrete provider.
    if (
      (provider === 'claude' || provider === 'codex') &&
      change.provider !== '_all' &&
      change.provider !== provider
    ) {
      return null;
    }

    const changeDate = new Date(change.timestamp);

    // Compute 7-day before and after windows
    const beforeEnd = new Date(changeDate);
    beforeEnd.setDate(beforeEnd.getDate() - 1); // day before the change
    const beforeStart = new Date(beforeEnd);
    beforeStart.setDate(beforeStart.getDate() - 6); // 7 days total

    const afterStart = new Date(changeDate);
    afterStart.setDate(afterStart.getDate() + 1); // day after the change
    const afterEnd = new Date(afterStart);
    afterEnd.setDate(afterEnd.getDate() + 6); // 7 days total

    const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);

    const beforeStartStr = fmtDate(beforeStart);
    const beforeEndStr = fmtDate(beforeEnd);
    const afterStartStr = fmtDate(afterStart);
    const afterEndStr = fmtDate(afterEnd);

    const results: ImpactSummary['results'] = [];

    for (const metric of IMPACT_METRICS) {
      const beforeRows = this.db.getMetricForDateRange(
        metric,
        beforeStartStr,
        beforeEndStr,
        provider,
      );
      const afterRows = this.db.getMetricForDateRange(metric, afterStartStr, afterEndStr, provider);

      const beforeAvg = this.average(beforeRows.map((r) => r.value));
      const afterAvg = this.average(afterRows.map((r) => r.value));

      const changePct =
        beforeAvg === 0 ? (afterAvg === 0 ? 0 : 100) : ((afterAvg - beforeAvg) / beforeAvg) * 100;

      let verdict: 'improved' | 'degraded' | 'stable';

      if (Math.abs(changePct) < 5) {
        verdict = 'stable';
      } else if (HIGHER_IS_BETTER.has(metric)) {
        verdict = changePct > 0 ? 'improved' : 'degraded';
      } else if (LOWER_IS_BETTER.has(metric)) {
        verdict = changePct < 0 ? 'improved' : 'degraded';
      } else {
        verdict = 'stable';
      }

      this.db.insertImpactResult({
        change_id: changeId,
        metric_name: metric,
        before_value: beforeAvg,
        after_value: afterAvg,
        change_pct: Math.round(changePct * 100) / 100,
        verdict,
        provider,
      });

      results.push({
        metric,
        before: beforeAvg,
        after: afterAvg,
        changePct: Math.round(changePct * 100) / 100,
        verdict,
      });
    }

    return {
      changeId,
      description: change.description,
      timestamp: change.timestamp,
      results,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getLastStoredHash(filePath: string, provider: 'claude' | 'codex'): string | null {
    const row = this.db.db
      .prepare(
        'SELECT file_hash FROM changes WHERE file_path = ? AND provider = ? ORDER BY timestamp DESC LIMIT 1',
      )
      .get(filePath, provider) as { file_hash: string } | undefined;
    return row?.file_hash ?? null;
  }

  private fileExists(p: string): boolean {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }

  private isDirectory(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** Directory names to skip during recursive walks. */
  private static readonly SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

  /** Recursively collect all .md files under a directory. */
  private collectMdFiles(dir: string, out: string[]): void {
    this.collectFilesWithExt(dir, '.md', out);
  }

  /** Recursively collect files with a specific extension. */
  private collectFilesWithExt(dir: string, ext: string, out: string[]): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ChangeTracker.SKIP_DIRS.has(entry.name)) continue;
          this.collectFilesWithExt(path.join(dir, entry.name), ext, out);
        } else if (entry.isFile() && entry.name.endsWith(ext)) {
          out.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Not readable — skip
    }
  }

  /** Recursively collect files matching any of the given extensions. */
  private collectFilesByExts(dir: string, exts: string[], out: string[]): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ChangeTracker.SKIP_DIRS.has(entry.name)) continue;
          this.collectFilesByExts(path.join(dir, entry.name), exts, out);
        } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
          out.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Not readable — skip
    }
  }

  /** Recursively collect files matching an exact basename. */
  private collectFilesByName(dir: string, name: string, out: string[]): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (ChangeTracker.SKIP_DIRS.has(entry.name)) continue;
          this.collectFilesByName(path.join(dir, entry.name), name, out);
        } else if (entry.isFile() && entry.name === name) {
          out.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Not readable — skip
    }
  }

  private average(values: number[]): number {
    if (values.length === 0) return 0;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return sum / values.length;
  }
}
