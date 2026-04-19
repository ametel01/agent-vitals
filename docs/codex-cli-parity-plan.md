# Codex CLI Parity — Implementation Plan

Derived from `docs/codex-cli-parity-research.md`. Every step names exact files, exact line ranges observed in the code as of this plan, the precise edit, and the validation command that proves the step worked before the next step starts.

## Ground rules

- Work in the recommended order. Step 1 unblocks schema dependencies for every other step.
- After each step, run its validation block. Do not proceed on red.
- Use `--db /tmp/parity.db` and a temp `HOME` (see bottom of doc) for validation runs so the user's real `~/.agent-vitals/vitals.db`, `~/.claude`, and `~/.codex` are untouched.
- Prefer `Edit` with minimal hunks. Only `Write` new files.
- Every edited file must be `Read` immediately before editing, per user CLAUDE.md rules.

## Baseline: commands to run once before starting

```
bun run check       # current state, typecheck + lint baseline
bun run build       # confirms dist/ is buildable
node dist/index.js prescribe --source codex --format json   # confirm Codex dry-run still works
```

Record exit codes. Every step must leave `bun run check` and `bun run build` green.

---

## Step 1 — Add provider columns for `changes` and `impact_results`

### Exact files

- `src/db/schema.ts` — lines 163–184 (the `changes` and `impact_results` table DDL).
- `src/db/database.ts`
  - `migrate()` at lines 50–64 — add column migrations.
  - `insertChange()` at lines 479–502 — accept `provider`.
  - `getAllChanges()` at lines 587–591 — accept `provider`.
  - `insertImpactResult()` at lines 505–525 — accept `provider`.
  - `getImpactResults()` at lines 593–599 — accept `provider`.

### Edits

1. In `src/db/schema.ts`, extend the `changes` DDL (line 163) with:

   ```sql
   provider TEXT NOT NULL DEFAULT 'claude'
   ```

   and the `impact_results` DDL (line 175) with:

   ```sql
   provider TEXT NOT NULL DEFAULT '_all'
   ```

   Do **not** add provider indexes to `SCHEMA_SQL`. `SCHEMA_SQL` runs before `migrate()` on existing databases, so an index on a newly added column will fail with `no such column: provider` before the migration has a chance to add it. Create the indexes in `migrate()` only, after `addColumnIfMissing()`.

2. In `src/db/database.ts` `migrate()` (line 50), append:

   ```ts
   this.addColumnIfMissing('changes', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
   this.addColumnIfMissing('impact_results', 'provider', "TEXT NOT NULL DEFAULT '_all'");
   this.db.exec('CREATE INDEX IF NOT EXISTS idx_changes_provider ON changes(provider);');
   this.db.exec(
     'CREATE INDEX IF NOT EXISTS idx_impact_results_provider ON impact_results(provider);',
   );
   ```

   `addColumnIfMissing()` is already idempotent (lines 98–102). No table rebuild needed because the new columns have NOT NULL defaults and neither table's existing UNIQUE constraint references `provider`.

3. In `insertChange()` (line 479), add an optional `provider?: string` param and bind it last with default `'claude'`. Update the `INSERT INTO changes (...)` column list and `VALUES` tuple to include it.

4. Add an overload `getAllChanges(provider: string = '_all')`. Provider-specific views should include explicitly matching rows plus global/manual rows stored as `'_all'`; they must exclude the other concrete provider:

   ```ts
   getAllChanges(provider: string = '_all'): ChangeRow[] {
     if (provider === '_all') {
       return this.db.prepare('SELECT id, timestamp, type, description, provider FROM changes ORDER BY timestamp DESC').all() as ChangeRow[];
     }
     return this.db.prepare("SELECT id, timestamp, type, description, provider FROM changes WHERE provider = ? OR provider = '_all' ORDER BY timestamp DESC").all(provider) as ChangeRow[];
   }
   ```

   Update `ChangeRow` (line 11) to include `provider: string`.

5. In `insertImpactResult()` (line 505), add `provider?: string` param and bind it in the INSERT (default `'_all'`).

6. Add overload `getImpactResults(changeId: number, provider: string = '_all')`:
   ```ts
   getImpactResults(changeId: number, provider: string = '_all'): ImpactResultRow[] {
     if (provider === '_all') {
       return this.db.prepare('SELECT metric_name, before_value, after_value, change_pct, verdict FROM impact_results WHERE change_id = ?').all(changeId) as ImpactResultRow[];
     }
     return this.db.prepare('SELECT metric_name, before_value, after_value, change_pct, verdict FROM impact_results WHERE change_id = ? AND provider = ?').all(changeId, provider) as ImpactResultRow[];
   }
   ```

### Validation

```
bun run check
bun run build
# Migration on existing DB
if [ -f ~/.agent-vitals/vitals.db ]; then cp ~/.agent-vitals/vitals.db /tmp/parity-migrate.db; else rm -f /tmp/parity-migrate.db; fi
node - <<'NODE'
const { VitalsDB } = require('./dist/db/database');
const db = new VitalsDB('/tmp/parity-migrate.db');
db.close();
NODE
sqlite3 /tmp/parity-migrate.db "PRAGMA table_info(changes);" | grep provider
sqlite3 /tmp/parity-migrate.db "PRAGMA table_info(impact_results);" | grep provider
sqlite3 /tmp/parity-migrate.db "SELECT provider, COUNT(*) FROM changes GROUP BY provider;"   # existing rows must read as 'claude'
```

### Failure modes

- Adding provider indexes to `SCHEMA_SQL` will break migration for existing DBs because `CREATE TABLE IF NOT EXISTS changes (...)` does not alter old tables before the index statements run. Keep the new provider indexes in `migrate()` only.
- Forgetting to include `provider` in the SELECT list of `getAllChanges` — downstream consumers will fail typecheck against the new `ChangeRow` type. Good.
- Backfill default is `'claude'` for `changes` (historical data was Claude-only) and `'_all'` for `impact_results` (legacy impact rows were aggregate). Do not change these defaults silently later.
- If you rebuild the table instead of `ALTER ADD COLUMN`, you risk losing rows. Use `addColumnIfMissing` — there is no UNIQUE constraint on these tables that forces a rebuild.

---

## Step 2 — Thread provider through annotate, changes, impact, reports, dashboard

### Exact files

- `src/index.ts`
  - `annotate` command at lines 624–640 — must pass provider to `addAnnotation`.
  - `changes` command at lines 717–745 — must pass provider to `getAllChanges`.
  - `impact` command at lines 643–714 — must pass provider to `insertImpactResult` through the tracker.
- `src/changes/tracker.ts`
  - `addAnnotation()` at lines 134–140 — accept provider.
  - `computeImpact()` at lines 146–227 — pass provider into `insertImpactResult`.
- `src/reports/terminal.ts` at line 544 (timeline section) — `this.db.getAllChanges()`. Pass provider.
- `src/reports/terminal.ts` at line 563 (`getImpactResults`) — pass provider.
- `src/reports/markdown.ts` at lines 703 and 718 — same pattern.
- `src/dashboard/server.ts` at lines 66–75 (`/api/changes`) — accept `?source=` and filter.

### Edits

1. `ChangeTracker.addAnnotation(description, provider = '_all')` → call `db.insertChange({..., provider})`.
   - Manual annotations may be global (`'_all'`) or provider-specific (`'claude'` / `'codex'`). Do not leave it undefined.

2. `ChangeTracker.computeImpact(changeId, provider = '_all')` already accepts provider at line 146. Thread that same provider into `db.insertImpactResult({..., provider})` at lines 203–210. This is the critical fix that ties saved impact rows to the provider they were computed for.
   - Also update the change lookup at lines 148–150 to select `provider`.
   - If `provider` is concrete (`'claude'` or `'codex'`) and the change row's provider is the other concrete provider, return `null` rather than computing impact against an unrelated source. Changes with provider `'_all'` are valid for either concrete source.

3. `src/index.ts` `annotate` action (line 630):
   - Replace the discarded `resolveReportProvider(opts.source)` with:
     ```ts
     const provider = resolveReportProvider(opts.source);
     tracker.addAnnotation(description, provider);
     ```
   - This is the one write path where `'_all'` is valid: it represents a global/manual change that should appear in the all-provider view and in provider-specific timelines, while still excluding rows from the other concrete provider.

4. `src/index.ts` `changes` action (line 722):
   - Replace `resolveReportProvider(opts.source);` (discarded) with `const provider = resolveReportProvider(opts.source);`.
   - Change `db.getAllChanges()` (line 726) to `db.getAllChanges(provider)`.

5. `src/index.ts` `impact` action (line 654): already threads provider correctly. No change beyond confirming `tracker.computeImpact(..., provider)` now also writes `provider` through Step 2-item-2.

6. `src/reports/terminal.ts`:
   - Change `this.db.getAllChanges()` to `this.db.getAllChanges(provider)` at line 544. `provider` is already a local variable in `generate()` at line 392, so this is an in-method edit, not new class state.
   - Change `this.db.getImpactResults(change.id)` to `this.db.getImpactResults(change.id, provider)` at line 563.
7. `src/reports/markdown.ts`:
   - Change the call at line 406 from `this.appendChangesSection(lines)` to `this.appendChangesSection(lines, provider)`.
   - Change the helper signature at line 702 to `private appendChangesSection(lines: string[], provider: string): void`.
   - Inside the helper, change `this.db.getAllChanges()` at line 703 to `this.db.getAllChanges(provider)`.
   - Change `this.db.getImpactResults(change.id)` at line 718 to `this.db.getImpactResults(change.id, provider)`.

8. `src/dashboard/server.ts` `/api/changes` (lines 66–75):
   ```ts
   if (pathname === '/api/changes') {
     const changes = db.getAllChanges(provider);
     const changesWithImpact = changes.map((change) => ({
       ...change,
       impacts: db.getImpactResults(change.id, provider),
     }));
     ...
   }
   ```
   `provider` is already resolved at line 48 via `resolveSourceParam`. No plumbing needed.

### Validation

```
rm -f /tmp/parity.db
node dist/index.js annotate "codex test" --source codex --db /tmp/parity.db
node dist/index.js annotate "claude test" --source claude --db /tmp/parity.db
node dist/index.js annotate "global test" --source all --db /tmp/parity.db
sqlite3 /tmp/parity.db "SELECT description, provider FROM changes;"
# expect: claude test|claude, codex test|codex, global test|_all

node dist/index.js changes --source codex --db /tmp/parity.db    # expect codex + global, not claude
node dist/index.js changes --source claude --db /tmp/parity.db   # expect claude + global, not codex
node dist/index.js changes --source all --db /tmp/parity.db      # expect all three
```

### Failure modes

- If `getAllChanges('codex')` filters only on `provider = 'codex'`, global annotations disappear from provider timelines. Include `provider = '_all'` in concrete-provider reads while still excluding the other concrete provider.
- Forgetting `insertImpactResult` provider wiring means `impact --source codex` computes correct Codex windows but writes rows indistinguishable from Claude runs. Caller will read back mixed data on the next invocation.
- `TerminalReport` and `MarkdownReport` must already know their `provider` from `generate({provider})`. If they don't, you have to plumb it through — do not silently default to `_all` in the timeline section, that would contradict the filter the caller asked for.

---

## Step 3 — Split config change detection by provider

### Exact file

- `src/changes/tracker.ts` — `detectChanges()` at lines 56–128 is Claude-only: it scans `~/.claude/CLAUDE.md` (line 65), `~/.claude/projects/*/CLAUDE.md` (lines 68–81), `~/.claude/settings.json` (line 84), and `~/.claude/commands/**/*.md` (lines 87–90).
- `src/index.ts` `scan` action at lines 70–76 calls `tracker.detectChanges()` unconditionally.

### Edits

1. Refactor `detectChanges()` into two methods:

   ```ts
   detectChanges(provider: 'claude' | 'codex' | 'all' = 'claude'): number {
     let count = 0;
     if (provider === 'claude' || provider === 'all') count += this.detectClaudeChanges();
     if (provider === 'codex'  || provider === 'all') count += this.detectCodexChanges();
     return count;
   }

   private detectClaudeChanges(): number { /* existing body, pass provider:'claude' to insertChange */ }
   private detectCodexChanges():  number { /* new body,   pass provider:'codex'  to insertChange */ }
   ```

2. The Codex file list (inside `detectCodexChanges`), rooted at `os.homedir()` and `process.cwd()`:
   - `~/.codex/config.toml`
   - `~/.codex/rules/**/*.rules` (recursive via `collectFilesWithExt(dir, '.rules', out)`)
   - `~/.codex/skills/**/SKILL.md` (recursive via a new `collectFilesByName(dir, 'SKILL.md', out)`)
   - `path.join(process.cwd(), 'AGENTS.md')`
   - `path.join(process.cwd(), '.codex')` recursive markdown/toml/rules files, if directory exists
   - `path.join(process.cwd(), '.agents')` recursive markdown files, if directory exists

   Reuse the existing `collectMdFiles` pattern at lines 257–271. Add generic siblings. Skip `node_modules`, `.git`, and `dist` by name inside the recursive walkers; Codex rules trees do not contain these but defensive filtering is cheap.

3. `insertChange` calls inside both detectors must pass `provider` explicitly (`'claude'` or `'codex'`) so Step 1's schema column is populated correctly.

4. In `src/index.ts` `scan` action, convert line 71:
   ```ts
   const trackerSource = source as 'claude' | 'codex' | 'all';
   const changes = tracker.detectChanges(trackerSource);
   ```
   `source` is already validated at lines 37–50 to be one of `claude | codex | all`.

### Validation

```
# Fake Codex config
TMPHOME=$(mktemp -d)
mkdir -p $TMPHOME/.codex/rules
echo 'approval_policy = "on-failure"' > $TMPHOME/.codex/config.toml
echo 'Always read before patching.' > $TMPHOME/.codex/rules/test.rules

HOME=$TMPHOME node dist/index.js scan --source codex --db /tmp/parity.db -v
sqlite3 /tmp/parity.db "SELECT provider, file_path FROM changes WHERE provider='codex';"
# expect: codex|<tmphome>/.codex/config.toml   and   codex|<tmphome>/.codex/rules/test.rules

# Confirm a Codex-only scan did not insert Claude-file changes
sqlite3 /tmp/parity.db "SELECT COUNT(*) FROM changes WHERE provider='claude' AND file_path LIKE '%/.claude/%';"
# expect: 0
```

### Failure modes

- Unbounded recursion into `.codex` or `.agents` trees will hash large generated directories if the user happens to have them. Hard-filter known-noise names (`node_modules`, `.git`, `dist`, `build`).
- Running the Codex tracker outside a repo will silently check nonexistent `AGENTS.md` — this is fine because the existing `fileExists` guard at line 94 short-circuits.
- Storing the Codex file hash under the same `file_path` column means a future scan from a different HOME will look like a change. This is the same weakness the Claude tracker has today; do not try to fix it here.

---

## Step 4 — Implement Codex prescription apply

### Exact files

- `src/prescriptions/prescriber.ts` — single `apply()` at lines 162–219 is Claude-only; it writes `~/.claude/settings.json` and `CLAUDE.md`.
- `src/prescriptions/codex-known-fixes.ts` — source of truth for Codex fix types (already uses `codex_config_toml`, `codex_rules`, `project_instructions`).
- `src/index.ts`
  - Prescription apply gate at lines 338–345 (the "not implemented yet" error).
  - Apply result rendering at lines 479–494.
  - Footer messages at lines 495–515.

### Edits

1. Add a second apply path in `Prescriber`:

   ```ts
   applyCodex(
     prescriptions: Prescription[],
     options: { target?: 'global' | 'project' } = {},
   ): CodexApplyResult
   ```

   New result shape:

   ```ts
   export interface CodexApplyResult {
     rulesWritten: string[]; // absolute file paths
     configTomlWritten: boolean;
     configTomlPath: string;
     agentsMdWritten: boolean;
     agentsMdPath: string;
     agentsMdRulesCount: number;
   }
   ```

2. Writer: `codex_rules`.
   - `fix.key` is like `~/.codex/rules/read-before-edit.rules`. Expand `~` via `fix.key.replace(/^~/, os.homedir())`.
   - `mkdir -p` the parent dir.
   - If the file exists, overwrite atomically: write to `path + '.tmp'`, then rename.
   - Content is `fix.value` + trailing newline.
   - Append the absolute path to `result.rulesWritten` for dedup.

3. Writer: `project_instructions`.
   - Target is `path.join(process.cwd(), 'AGENTS.md')`. The `fix.key` value `AGENTS.md` is the logical target; do not expand it as a filesystem path.
   - Same bounded-block pattern already in `mergeClaudeMd` (lines 264–288). Introduce distinct markers:
     ```ts
     const AGENTS_MD_START = '<!-- agent-vitals codex prescriptions -->';
     const AGENTS_MD_END = '<!-- end agent-vitals codex prescriptions -->';
     ```
     Do not reuse `PRESCRIPTION_START/END` (lines 27–28) — that marker belongs to Claude CLAUDE.md and the two files must stay independent.
   - Dedup by `fix.value` (not `fix.key`) — multiple `project_instructions` rules all share `fix.key = 'AGENTS.md'` and would otherwise collapse to one line.

4. Writer: `codex_config_toml`.
   - `fix.value` in the Codex catalog is a TOML assignment string like `'approval_policy = "on-failure"'` (see `codex-known-fixes.ts` line 229).
   - Parse the existing file into a `Map<string, string>` keyed by the left-hand identifier. The safe implementation:
     - Split existing `~/.codex/config.toml` on newlines.
     - Track whether the current line is inside a TOML table by matching `^\s*\[[^\]]+\]\s*$`.
     - Only match and replace `^\s*([A-Za-z0-9_.-]+)\s*=` while still in the top-level/root section before the first table header. Leave table-scoped keys untouched.
     - Build the new content by replacing matching root-level lines and inserting unmatched prescribed keys in a bounded `# agent-vitals managed` block in the root section, before the first table header if the file contains tables.
     - On repeated runs, replace the existing bounded managed block instead of appending a second one.
   - Do **not** introduce a TOML parser dependency unless this repo already has one; check `package.json` before importing. Plain string handling is safer than half-correct TOML rewriting.
   - Idempotency: running twice with identical prescriptions must produce byte-identical output.

5. `src/index.ts`:
   - Delete lines 338–345 (the Codex `--apply` block).
   - Add a branch for Codex apply in the `if (opts.apply)` block (line 479). Dispatch to `prescriber.applyCodex` when `hasCodexPrescriptions`, to `prescriber.apply` otherwise.
   - Current `Prescriber.diagnose('_all')` does **not** return mixed Claude/Codex prescriptions; it chooses Claude if Claude sessions exist, otherwise Codex. Keep the apply branch defensive by partitioning prescriptions by fix type if a future change makes mixed results possible, but do not write code that assumes mixed results occur today.
   - Update the footer at lines 495–514 to unconditionally show a TO APPLY hint (Codex no longer needs its "intentionally not implemented" line at 503).
   - Update the stale Codex health message at lines 210–215 to: `Run "agent-vitals prescribe --source codex" for Codex-specific fixes.`

### Validation

```
TMPHOME=$(mktemp -d)
TMPREPO=$(mktemp -d)
REPO=$(pwd)
rm -f /tmp/parity.db

# Direct writer validation. Do not use `prescribe --source codex --apply` against an empty DB:
# `Prescriber.diagnose()` only returns prescriptions when Codex sessions and degraded Codex metrics exist.
(cd "$TMPREPO" && HOME="$TMPHOME" node - <<NODE
const { VitalsDB } = require("$REPO/dist/db/database");
const { Prescriber } = require("$REPO/dist/prescriptions/prescriber");
const { CODEX_KNOWN_FIXES } = require("$REPO/dist/prescriptions/codex-known-fixes");
const db = new VitalsDB("/tmp/parity.db");
const templates = [];
const seenTypes = new Set();
for (const known of CODEX_KNOWN_FIXES) {
  for (const fix of known.prescriptions) {
    if (seenTypes.has(fix.type)) continue;
    seenTypes.add(fix.type);
    templates.push(fix);
  }
}
const prescriptions = templates.map((fix) => ({
  metric: "test",
  metricLabel: "Test",
  currentValue: 0,
  threshold: 0,
  severity: "warning",
  fix,
}));
new Prescriber(db).applyCodex(prescriptions, { target: "global" });
db.close();
NODE
)
ls $TMPHOME/.codex/rules          # expect .rules files from the catalog
test -f $TMPHOME/.codex/config.toml
test -f $TMPREPO/AGENTS.md
# No Claude pollution:
test ! -e $TMPHOME/.claude
test ! -e $TMPREPO/.claude

# Second apply — idempotent
sha_before=$(shasum $TMPHOME/.codex/config.toml $TMPREPO/AGENTS.md | shasum)
(cd "$TMPREPO" && HOME="$TMPHOME" node - <<NODE
const { VitalsDB } = require("$REPO/dist/db/database");
const { Prescriber } = require("$REPO/dist/prescriptions/prescriber");
const { CODEX_KNOWN_FIXES } = require("$REPO/dist/prescriptions/codex-known-fixes");
const db = new VitalsDB("/tmp/parity.db");
const templates = [];
const seenTypes = new Set();
for (const known of CODEX_KNOWN_FIXES) {
  for (const fix of known.prescriptions) {
    if (seenTypes.has(fix.type)) continue;
    seenTypes.add(fix.type);
    templates.push(fix);
  }
}
const prescriptions = templates.map((fix) => ({
  metric: "test",
  metricLabel: "Test",
  currentValue: 0,
  threshold: 0,
  severity: "warning",
  fix,
}));
new Prescriber(db).applyCodex(prescriptions, { target: "global" });
db.close();
NODE
)
sha_after=$(shasum $TMPHOME/.codex/config.toml $TMPREPO/AGENTS.md | shasum)
[ "$sha_before" = "$sha_after" ] && echo IDEMPOTENT || echo FAIL

# CLI dispatch smoke: seed Codex metrics so diagnose() returns one fix from each Codex target family.
rm -f /tmp/parity-prescribe.db
node - <<NODE
const { VitalsDB } = require("$REPO/dist/db/database");
const db = new VitalsDB("/tmp/parity-prescribe.db");
db.insertSession({
  id: "codex-smoke",
  project_path: "$TMPREPO",
  scanned_at: new Date().toISOString(),
  provider: "codex",
});
for (let i = 0; i < 7; i++) {
  const d = new Date();
  d.setDate(d.getDate() - i);
  const date = d.toISOString().slice(0, 10);
  db.upsertDailyMetric({ date, metric_name: "session_autonomy_median", metric_value: 0, provider: "codex" });
  db.upsertDailyMetric({ date, metric_name: "first_tool_read_pct", metric_value: 0, provider: "codex" });
  db.upsertDailyMetric({ date, metric_name: "prompts_per_session", metric_value: 0, provider: "codex" });
}
db.close();
NODE
TMPHOME2=$(mktemp -d)
TMPREPO2=$(mktemp -d)
(cd "$TMPREPO2" && HOME="$TMPHOME2" node "$REPO/dist/index.js" prescribe --source codex --apply --db /tmp/parity-prescribe.db)
test -f $TMPHOME2/.codex/config.toml
test -d $TMPHOME2/.codex/rules
test -f $TMPREPO2/AGENTS.md
test ! -e $TMPHOME2/.claude
test ! -e $TMPREPO2/.claude
```

### Failure modes

- **TOML corruption** is the single highest-risk write in the whole plan. If the user has a hand-maintained `config.toml` with tables (`[profile.xyz]`), arrays, or multi-line strings, naive line-replace can still produce valid-but-semantically-wrong output. Mitigation: keep the writer restricted to root-level `key = value` assignments, place the managed block before any table header, and refuse to touch anything under a `[table]` header. Document this restriction in the apply-result summary so the user can see what was skipped.
- Global vs project target: Codex `codex_config_toml` and `codex_rules` are always `~/.codex/*` (global). `project_instructions` is always `process.cwd()/AGENTS.md`. `--target project` for Codex should write project instructions only and skip the global writers. `--target global` should write all three. Make this explicit in code — do not treat `--target` as a no-op.
- Reusing `PRESCRIPTION_START/END` markers across `CLAUDE.md` and `AGENTS.md` would make a subsequent Claude apply overwrite Codex content and vice versa. Separate markers are mandatory.
- Atomic writes: use temp-file + rename so a crash mid-write never leaves `config.toml` half-rewritten.

---

## Step 5 — Add Codex baseline recommendations

### Exact files

- `src/prescriptions/codex-known-fixes.ts` — already exports `CODEX_KNOWN_FIXES`; add a `CODEX_BASELINE` export next to it.
- `src/prescriptions/prescriber.ts` — `getBaselineRecommendations()` at line 83 returns Claude only; add a Codex variant.
- `src/index.ts` `baseline` command at lines 224–295; specifically the early return for Codex at lines 231–239 and the apply flow at 271–286.

### Edits

1. In `codex-known-fixes.ts`, add a vetted Codex baseline list. Constraint from the research doc §4: every entry must map to a real Codex target. Start small and honest. Minimum viable set:

   ```ts
   export const CODEX_BASELINE: PrescriptionTemplate[] = [
     {
       type: 'codex_rules',
       key: '~/.codex/rules/read-before-edit.rules',
       value:
         'For every code edit, read the target file and at least one related caller, test, or type definition before using apply_patch.',
       description: 'Baseline read-before-edit rule',
     },
     {
       type: 'codex_rules',
       key: '~/.codex/rules/verify-shell.rules',
       value:
         'Before shell commands, verify cwd and command syntax. After a failure, read the full error and change approach instead of retrying.',
       description: 'Baseline shell verification rule',
     },
     {
       type: 'project_instructions',
       key: 'AGENTS.md',
       value:
         'Finish all requested parts before stopping. Validate results before reporting completion.',
       description: 'Baseline task-completion instruction',
     },
   ];
   ```

   Do not invent `codex_config_toml` baseline entries unless you can cite the Codex docs for an exact key. The research doc calls this out explicitly.

2. In `prescriber.ts`, add:

   ```ts
   getCodexBaselineRecommendations(): PrescriptionTemplate[] {
     return CODEX_BASELINE;
   }
   ```

3. In `src/index.ts` `baseline` action:
   - Replace the early return at lines 232–239 with a branch that prints Codex baselines from `prescriber.getCodexBaselineRecommendations()` and, on `--apply`, wraps them into fake prescriptions and calls `prescriber.applyCodex(...)` from Step 4.
   - Update the `--apply` option description at line 227 (`'Write baseline settings to ~/.claude/settings.json'`) to a provider-neutral string, e.g. `'Write baseline settings to the appropriate config location'`.
   - Update the TO APPLY hint at line 289 to show both Claude and Codex invocations.

### Validation

```
# Dry run, Codex
node dist/index.js baseline --source codex --db /tmp/parity.db
# expect the Codex baseline list printed

# Apply, Codex
TMPHOME=$(mktemp -d)
TMPREPO=$(mktemp -d)
REPO=$(pwd)
(cd "$TMPREPO" && HOME="$TMPHOME" node "$REPO/dist/index.js" baseline --source codex --apply --db /tmp/parity.db)
ls $TMPHOME/.codex/rules
test -f $TMPREPO/AGENTS.md
test ! -e $TMPHOME/.claude
test ! -e $TMPREPO/.claude

# Claude baseline is unaffected
node dist/index.js baseline --source claude --db /tmp/parity.db   # expect Claude list
```

### Failure modes

- Inventing Codex config keys is the top failure mode. Prefer zero entries to guessed entries.
- Reusing the Claude apply writer for Codex baselines would recreate the bug Step 4 fixes.

---

## Step 6 — Finish dashboard source parity

### Exact files

- `src/dashboard/server.ts` — `/api/changes` already wired up in Step 2; serve `/` with the CLI default source injected into the HTML.
- `src/dashboard/dashboard.html` — fetches at lines 689–692 drop the source entirely.

### Edits

1. In `src/dashboard/server.ts`, change the HTML response at lines 51–55 to inject the command's default source into the page:

   ```ts
   const defaultSource = defaultProvider === '_all' ? 'all' : defaultProvider;
   const html = fs
     .readFileSync(htmlPath, 'utf-8')
     .replace('__AGENT_VITALS_DEFAULT_SOURCE__', defaultSource);
   ```

   This preserves `agent-vitals dashboard --source codex` as the initial UI state without requiring a separate config endpoint.

2. In `dashboard.html`:
   - Add a script-level constant inside the Babel script:
     ```js
     const DEFAULT_SOURCE = '__AGENT_VITALS_DEFAULT_SOURCE__';
     ```
   - Add a `<select>` control in the topbar (near line 47–50) with options `all`, `claude`, `codex`. Wire it to React state.
   - Initialize `const [source, setSource] = React.useState(DEFAULT_SOURCE || 'all');`.
   - Change the four fetches (lines 689–692) to use a `source` query param:
     ```js
     const qs = `?source=${encodeURIComponent(source || 'all')}`;
     const [metrics, changes, health, sessions] = await Promise.all([
       fetch(`/api/metrics${qs}`).then((r) => r.json()),
       fetch(`/api/changes${qs}`).then((r) => r.json()),
       fetch(`/api/health${qs}`).then((r) => r.json()),
       fetch(`/api/sessions${qs}`).then((r) => r.json()),
     ]);
     ```
   - Put the fetch block in a `loadDashboard()` helper called by `React.useEffect(..., [source])`. On source change, clear `activeChange`, set `loading` back to `true`, and refetch all four together. Do not refetch only metrics — the timeline and health cards must stay in sync.

3. In `server.ts`, verify each endpoint reads `parsedUrl.searchParams.get('source')` via `resolveSourceParam` (line 48). It already does, except `/api/changes` which Step 2 fixed. No further server-side endpoint change unless audit finds a regression.

### Validation

```
node dist/index.js dashboard --source codex --db /tmp/parity.db --port 7847 &
DASH=$!
sleep 1
curl -s 'http://localhost:7847/api/metrics?source=codex'  | head -c 200
curl -s 'http://localhost:7847/api/changes?source=codex'  | head -c 200
curl -s 'http://localhost:7847/api/health?source=codex'   | head -c 200
curl -s 'http://localhost:7847/api/sessions?source=codex' | head -c 200
# Compare: changes?source=codex should NOT include any change with provider='claude'
curl -s 'http://localhost:7847/api/changes?source=codex'  | grep -o '"provider":"claude"' || echo OK
kill $DASH
```

### Failure modes

- A UI selector that updates only the metrics chart produces the "mismatched provider data" warning from the research doc. All four fetches must re-run atomically on selector change.
- Hard-coding the default to `all` in the UI disagrees with the server's `--source codex` flag default. The string substitution above is the chosen mechanism; do not add a second competing default source path later.

---

## Step 7 — Update user-facing messages, help, and README

### Exact files

- `src/index.ts`
  - Stale Codex health message at lines 210–215.
  - `baseline --apply` help text at line 227.
  - `prescribe` footer at lines 495–514.
- `README.md` — Codex status text around lines 43–55 and the command matrix around lines 258–282.

### Edits

1. Remove "not implemented yet" phrasing anywhere it still exists:
   ```
   rg -n "not implemented yet" src/
   rg -n "Codex-specific prescriptions are not implemented" src/
   rg -n "No Codex baseline settings" src/
   ```
   All three must return zero matches.
2. Update README command examples to show `--source codex` alongside `--source claude` for every subcommand that accepts it. Mirror the CLI help output — do not invent flags.

### Validation

```
rg -n "not implemented yet|No Codex baseline" src/ README.md && echo FAIL || echo OK
node dist/index.js --help
node dist/index.js prescribe --help
node dist/index.js baseline --help
node dist/index.js scan --help
# Each help page should describe --source symmetrically for claude/codex/all.
```

### Failure modes

- Docs that promise behavior Step 4 or 5 did not ship. Write docs last, after Steps 1–6 are green.

---

## Cross-cutting: temp HOME helper for validation

Every validation block that writes files uses a disposable home and a disposable cwd so no real user config is touched. Reuse:

```sh
TMPHOME=$(mktemp -d)
TMPREPO=$(mktemp -d)
trap "rm -rf $TMPHOME $TMPREPO" EXIT
export HOME=$TMPHOME
cd $TMPREPO
```

Never run apply steps with the real `$HOME`. The apply writers are idempotent but still mutate user files.

---

## Recommended commit boundaries

Each step is a commit. Keep commits small so an apply writer bug in Step 4 does not force a revert of the schema change in Step 1. Suggested messages:

1. `db: add provider column to changes and impact_results`
2. `cli: thread provider through annotate, changes, impact, reports, dashboard changes api`
3. `changes: split config detection into claude and codex trackers`
4. `prescriptions: implement codex apply writer for rules, config.toml, AGENTS.md`
5. `prescriptions: add codex baseline catalog and wire up baseline --source codex`
6. `dashboard: add source selector and thread source through all fetches`
7. `docs: remove stale codex not-implemented messages and update readme`

## Exit criteria for the whole plan

- `bun run check` and `bun run build` green after every commit.
- `node dist/index.js <cmd> --help` shows consistent `--source` language across all commands.
- Running every subcommand with `--source codex` touches only `~/.codex` and/or `AGENTS.md` under `process.cwd()` — never `~/.claude` or `.claude/`.
- `sqlite3 /tmp/parity.db "SELECT DISTINCT provider FROM changes;"` returns a non-trivial set (`claude`, `codex`).
- Dashboard source selector flips metrics, timeline, health, and sessions cards together, with no stale data.
