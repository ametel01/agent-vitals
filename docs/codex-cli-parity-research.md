# Codex CLI Parity Research

## Goal

Make `--source codex` functionally equivalent to `--source claude` across every CLI command, including dry-run output, apply behavior, change tracking, impact analysis, dashboard filtering, and baseline setup.

This research is based on code reads, not documentation promises. The current command surface accepts `--source` broadly, but several flows still have Claude-only storage, file targets, or writer logic.

## Authoritative Flows

- `src/index.ts` is the command surface. It validates `--source`, wires the database, and dispatches each command.
- `src/scanner/scanner.ts` is the provider-aware session ingest flow. It selects adapters by `source` and writes provider metadata into `sessions`.
- `src/metrics/analyzer.ts` computes aggregate and per-provider daily metrics.
- `src/db/schema.ts` and `src/db/database.ts` define whether a feature can be provider-scoped. `sessions` and `daily_metrics` are provider-aware; `changes` and `impact_results` are not.
- `src/prescriptions/prescriber.ts` chooses Claude versus Codex prescriptions and contains the only apply writer.
- `src/prescriptions/codex-known-fixes.ts` contains Codex dry-run prescriptions.
- `src/changes/tracker.ts` detects config changes, inserts manual annotations, and computes impact.
- `src/dashboard/server.ts` exposes provider-aware metrics, health, and sessions APIs, but not provider-aware changes.
- `src/dashboard/dashboard.html` fetches APIs without a source selector or query parameter.

## Current Parity Map

| Command                            | Current Codex behavior                                                                                                                 | Parity status   | Work required                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scan --source codex`              | Scans Codex sessions through `CodexAdapter`. Then always calls `ChangeTracker.detectChanges()`, which only checks Claude config files. | Partial         | Make config change detection provider-aware and run the matching tracker for `claude`, `codex`, or both for `all`. |
| `report --source codex`            | Uses provider-filtered report generation.                                                                                              | Mostly complete | Audit change timeline sections because reports call `db.getAllChanges()` without provider filtering.               |
| `health --source codex`            | Uses provider-filtered regression detection. Stale message still says Codex prescriptions are not implemented.                         | Partial         | Update user guidance now that Codex dry-run exists and apply is planned.                                           |
| `baseline --source codex`          | Prints `No Codex baseline settings available yet`.                                                                                     | Missing         | Add Codex baseline recommendations and apply support.                                                              |
| `prescribe --source codex`         | Produces Codex dry-run fixes from `CODEX_KNOWN_FIXES`.                                                                                 | Partial         | Implement `--apply` for Codex targets and update status messages.                                                  |
| `prescribe --source codex --apply` | Exits with `Codex prescription --apply is not implemented yet`.                                                                        | Missing         | Add a Codex writer for config TOML, rules files, and project instructions.                                         |
| `dashboard --source codex`         | Server defaults metrics, health, and sessions to Codex. Changes API remains unfiltered. UI has no source selector.                     | Partial         | Add provider-aware changes API and frontend source control.                                                        |
| `compare --source codex`           | Calls `getMetricForDateRange(..., provider)`.                                                                                          | Mostly complete | Validate output after provider-specific metrics exist in the database.                                             |
| `annotate --source codex`          | Accepts and validates `--source`, then discards it.                                                                                    | Missing         | Store provider on manual annotations.                                                                              |
| `impact --source codex`            | Computes provider-filtered metric windows, but stored impact rows are not provider-tagged.                                             | Partial         | Store provider on impact rows and return impact results for the requested provider.                                |
| `changes --source codex`           | Accepts and validates `--source`, then lists all changes.                                                                              | Missing         | Filter changes by provider.                                                                                        |

## Concrete Findings

### Provider-aware parts are real

- `src/index.ts` validates `claude`, `codex`, and `all` through `resolveReportProvider()`.
- `src/scanner/scanner.ts` selects adapters by source and stores `discovered.provider` on each session.
- `src/metrics/analyzer.ts` computes daily metrics for `_all` and every provider returned by `db.getProvidersInSessions()`.
- `src/db/database.ts` filters `getDailyMetrics()`, `getMetricForDateRange()`, `getLatestMetric()`, dashboard metrics, session counts, tool-call counts, and date ranges by provider.
- `src/regression/detector.ts` skips Claude-calibrated metrics when scoped to non-Claude providers.

### Prescription apply is Claude-only

`src/prescriptions/prescriber.ts` has one `apply()` implementation. It chooses either `~/.claude` or project `.claude`, writes JSON settings, and inserts generated blocks into `CLAUDE.md`.

The Codex catalog uses these fix types:

- `codex_config_toml`
- `codex_rules`
- `project_instructions`

Those types are recognized for display in `src/index.ts`, but they have no writer. The CLI therefore blocks Codex apply before calling `prescriber.apply()`.

### Baseline is Claude-only

`baseline` calls `prescriber.getBaselineRecommendations()`, which returns `BASELINE_SETTINGS` from `src/prescriptions/known-fixes.ts`. That catalog contains Claude settings, environment variables, and permissions.

`baseline --source codex` returns early in `src/index.ts`, so there is no Codex baseline dry run or apply path.

### Change tracking is Claude-only

`ChangeTracker.detectChanges()` checks:

- `~/.claude/CLAUDE.md`
- `~/.claude/projects/*/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude/commands/**/*.md`

`scan` invokes that tracker unconditionally after any session scan. A Codex-only scan can therefore report Claude config changes and cannot detect Codex config/rules changes.

### Change and impact schema blocks parity

`changes` has no provider column. `impact_results` has no provider column. Because of that:

- `annotate --source codex` cannot persist the selected source.
- `changes --source codex` cannot filter accurately.
- `dashboard /api/changes?source=codex` cannot be implemented correctly without schema changes.
- `impact --source codex` can compute Codex-specific metrics, but saved rows are indistinguishable from Claude or aggregate impact rows.

## Required Work

### 1. Add provider storage for changes and impact

Files:

- `src/db/schema.ts`
- `src/db/database.ts`
- `src/changes/tracker.ts`
- `src/index.ts`
- `src/reports/terminal.ts`
- `src/reports/markdown.ts`
- `src/dashboard/server.ts`

Implementation:

- Add `provider TEXT NOT NULL DEFAULT 'claude'` to `changes`.
- Add `provider TEXT NOT NULL DEFAULT '_all'` to `impact_results`.
- Add migrations in `VitalsDB.migrate()` using `addColumnIfMissing()`.
- Update `insertChange()` to accept `provider`.
- Update `getAllChanges(provider = '_all')` to filter unless provider is `_all`.
- Update `insertImpactResult()` to accept `provider`.
- Update `getImpactResults(changeId, provider = '_all')` to filter by provider.
- Update manual annotations so `annotate --source codex` writes `provider = 'codex'`.

Validation:

- Run `node dist/index.js annotate "codex test" --source codex --db /tmp/parity.db`.
- Confirm SQL shows the annotation provider as `codex`.
- Run `node dist/index.js changes --source codex --db /tmp/parity.db` and verify Claude annotations are excluded.

Failure modes:

- Existing Claude config changes may be backfilled incorrectly. Existing auto-detected changes should be treated as `claude`; existing manual annotations can be `claude` or `_all`, but the migration choice must be explicit.
- Recomputing impact for different providers must not mix rows from prior runs.

### 2. Split config change detection by provider

Files:

- `src/changes/tracker.ts`
- `src/index.ts`

Implementation:

- Keep the Claude file list as the Claude tracker.
- Add a Codex file list for:
  - `~/.codex/config.toml`
  - `~/.codex/rules/**/*.rules`
  - `~/.codex/skills/**/SKILL.md`
  - project `AGENTS.md`
  - project `.codex/**` when present
  - project `.agents/**` when present
- Pass provider into each inserted change.
- In `scan`, run Claude tracker for `--source claude`, Codex tracker for `--source codex`, and both for `--source all`.

Validation:

- Use a temporary `HOME` with fake `.codex/config.toml` and `.codex/rules/test.rules`.
- Run `node dist/index.js scan --source codex --db /tmp/parity.db`.
- Verify only Codex config changes are inserted.

Failure modes:

- Project instruction targets are ambiguous if the command is run outside a repository. The implementation should only track project files under `process.cwd()` when they exist.
- Recursive `.codex` and `.agents` tracking must ignore large generated or cache directories if any appear.

### 3. Implement Codex prescription apply

Files:

- `src/prescriptions/prescriber.ts`
- `src/prescriptions/codex-known-fixes.ts`
- `src/index.ts`
- tests for prescriptions if present or newly added

Implementation:

- Add a Codex-specific apply path instead of sending Codex fix types through the Claude writer.
- For `codex_rules`, create or update the exact `~/.codex/rules/*.rules` file from `fix.key`.
- For `project_instructions`, insert an idempotent generated block into project `AGENTS.md`.
- For `codex_config_toml`, update `~/.codex/config.toml` without corrupting existing TOML.
- Return an apply result that reports rules written, config updates written, and project instructions written.
- Keep generated content bounded by markers so repeated applies replace the prior generated block instead of duplicating it.

Validation:

- Run with a temporary `HOME` and temporary repo directory.
- Run `node dist/index.js prescribe --source codex --apply --db /tmp/parity.db`.
- Verify no files under `~/.claude` or `.claude` are created.
- Verify expected files under `~/.codex` and `AGENTS.md` are created.
- Run the same command twice and verify generated blocks do not duplicate.

Failure modes:

- TOML corruption is the highest-risk write. Either use a TOML parser/writer or constrain the implementation to clearly supported top-level assignments and preserve unknown content.
- Codex global rules and project instructions must not overwrite user-authored content.
- `--target project` semantics need to be explicit for Codex. A reasonable mapping is global rules/config for `global` and `AGENTS.md` for `project`, but mixed prescriptions may require writing both global and project files.

### 4. Add Codex baseline recommendations

Files:

- `src/prescriptions/known-fixes.ts` or a new `src/prescriptions/codex-baseline.ts`
- `src/prescriptions/prescriber.ts`
- `src/index.ts`

Implementation:

- Add a Codex baseline catalog separate from Claude `BASELINE_SETTINGS`.
- Make `baseline --source codex` print the Codex baseline catalog.
- Make `baseline --source codex --apply` reuse the Codex apply writer.
- Update the baseline command description and `--apply` help text so it no longer says only `~/.claude/settings.json`.

Validation:

- Run `node dist/index.js baseline --source codex`.
- Run `node dist/index.js baseline --source codex --apply` in a temporary `HOME`.
- Verify only Codex targets are written.

Failure modes:

- Baseline settings should not be invented. Every Codex config recommendation needs a known valid Codex target and value.

### 5. Finish dashboard source parity

Files:

- `src/dashboard/server.ts`
- `src/dashboard/dashboard.html`
- `src/db/database.ts`

Implementation:

- Make `/api/changes` read the same `source` query parameter as the other endpoints.
- Return only changes and impacts for the requested provider once schema support exists.
- Add a dashboard source selector for `all`, `claude`, and `codex`.
- Include `?source=<value>` in metrics, changes, health, and sessions fetches.

Validation:

- Start `node dist/index.js dashboard --source codex --db /tmp/parity.db`.
- Fetch `/api/metrics?source=codex`, `/api/changes?source=codex`, `/api/health?source=codex`, and `/api/sessions?source=codex`.
- Verify `/api/changes?source=codex` excludes Claude changes.

Failure modes:

- If the UI changes source but only metrics refresh, the timeline can show mismatched provider data.

### 6. Update user-facing messages and docs

Files:

- `src/index.ts`
- `README.md`

Implementation:

- Remove stale messages that say Codex prescriptions are not implemented once apply exists.
- Update `TO APPLY` output for Codex prescriptions and baselines.
- Update README command examples so Claude and Codex parity is visible.

Validation:

- Run every command help output and confirm `--source` language is accurate.
- Run Claude and Codex dry runs and apply runs with temporary paths.

## Manual Validation Already Performed

These checks establish the current state:

- `bun run check` passed after the Codex dry-run prescription additions.
- `bun run build` passed.
- `node dist/index.js prescribe --source codex` produced Codex dry-run prescriptions.
- `node dist/index.js prescribe --source codex --format json` returned JSON with Codex fix types: `codex_config_toml`, `codex_rules`, and `project_instructions`.
- `node dist/index.js prescribe --source codex --apply` failed with the explicit not-implemented message.
- All CLI subcommands currently expose `--source` in help output.

## Recommended Implementation Order

1. Add provider columns and database helpers for `changes` and `impact_results`.
2. Thread provider through `annotate`, `changes`, `impact`, reports, and dashboard changes.
3. Split change detection into Claude and Codex file tracking.
4. Implement Codex prescription apply with temp-home idempotency tests.
5. Add Codex baseline dry run and apply.
6. Update stale CLI messages and README.

This order removes the schema blocker first, then fixes behavior that only pretends to be source-aware, then adds the missing Codex writers.
