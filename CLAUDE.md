# claude-vitals

CLI tool that monitors Claude Code quality by analyzing session logs. Based on [@stellaraccident's analysis](https://github.com/anthropics/claude-code/issues/42796) of 234,760 tool calls.

## Structure

- `src/scanner/` — JSONL log parser + ingestion into SQLite
- `src/metrics/` — 20 metric computations
- `src/regression/` — Rolling 7-day window regression detection
- `src/changes/` — Config change detection + annotations + impact analysis
- `src/reports/` — Terminal (chalk + sparklines) and Markdown reports
- `src/dashboard/` — Single HTML file + HTTP server
- `src/db/` — SQLite schema (11 tables) + query layer
- `scripts/` — Install/uninstall skills to ~/.claude/commands/
- `SKILL.md` — Skill definition (behavioral corrections)
- `SPEC.md` — Full specification (all 20 metrics, rationale, thresholds)

## Commands

```bash
bun install                # Install dependencies (Bun is the package manager)
bun run build              # tsc -> dist/
bun run check              # typecheck + biome lint + prettier format:check
bun run format             # prettier --write .
node dist/index.js scan    # Ingest session logs
node dist/index.js health  # One-line status
node dist/index.js report  # Terminal report
node dist/index.js report --format md  # Markdown report
node dist/index.js dashboard           # Web dashboard
```

Bun manages dependencies; Node executes the built CLI (`dist/index.js`).

## Skills

`/vitals`, `/vitals-quick`, `/vitals-report`, `/vitals-dashboard` installed via `bash scripts/install.sh`.

## Rules

- `lib/__init__.py` convention does not apply here — this is TypeScript
- After modifications, rebuild with `bun run build`
- Dashboard HTML is a single file with no build step — edit src/dashboard/dashboard.html directly
- The SPEC.md is the source of truth for what metrics exist and why
- Use Bun for installs (`bun install`, `bun add`, `bun add -d`); do not create or commit `package-lock.json`
