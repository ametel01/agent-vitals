# Codex Support Implementation Plan

## Goal

Expand `claude-vitals` so it can ingest Codex CLI sessions and compute comparable agent-quality metrics without weakening the current Claude Code path.

The key design constraint is provider separation: Claude and Codex logs should normalize into the same internal metric tables, but discovery, parsing, thresholds, prescriptions, and config-change tracking must remain provider-aware.

## Non-Goals

- Do not rename the npm package or CLI in the first pass.
- Do not apply Claude prescriptions to Codex.
- Do not assume Claude thinking-depth benchmarks are valid for Codex.
- Do not make the scanner destructive unless the delete/reingest boundary is scoped to one session and wrapped in a transaction.

## Current Facts

- Claude discovery and parsing live in `src/scanner/log-parser.ts`.
- Ingestion orchestration lives in `src/scanner/scanner.ts`.
- The DB schema lives in `src/db/schema.ts`.
- Insert/query helpers live in `src/db/database.ts`.
- Metrics computation lives in `src/metrics/analyzer.ts`.
- Regression thresholds live in `src/regression/detector.ts`.
- Claude-only prescriptions live in `src/prescriptions/prescriber.ts` and `src/prescriptions/known-fixes.ts`.
- Claude-only config change tracking lives in `src/changes/tracker.ts`.
- Codex sessions are available under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
- Codex thread metadata is available in `~/.codex/state_5.sqlite`, table `threads`, especially `id`, `rollout_path`, `created_at`, `updated_at`, `cwd`, `model`, `reasoning_effort`, `git_branch`, and `tokens_used`.
- Codex rollout files contain entries with top-level `type` values including `session_meta`, `turn_context`, `event_msg`, and `response_item`.
- Codex tool calls appear as `response_item.payload.type === "function_call"` and `response_item.payload.type === "custom_tool_call"`.
- Codex shell command completions appear as `event_msg.payload.type === "exec_command_end"` with `call_id`, `exit_code`, `stdout`, `stderr`, `cwd`, and `duration`.
- Codex token counts appear as `event_msg.payload.type === "token_count"` with `payload.info.last_token_usage`, `payload.info.total_token_usage`, and `payload.info.model_context_window`.

## Phase 0: Tooling Baseline

### Step 0.1. Switch Package Management to Bun

Files:

- `package.json`
- `bun.lock`
- Remove `package-lock.json`
- `README.md`
- `CLAUDE.md`

Change:

- Use Bun as the package manager while preserving the TypeScript build output in `dist/`.
- Replace npm install/build instructions with Bun equivalents.
- Keep the existing Node runtime target unless the CLI is explicitly changed to run through Bun. The package can still expose `dist/index.js` with `#!/usr/bin/env node`.

Package script snippet:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "bun --watch src/index.ts",
    "check": "bun run typecheck && bun run lint && bun run format:check",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format:check": "prettier --check .",
    "format": "prettier --write ."
  }
}
```

Commands:

```bash
rm package-lock.json
bun install
bun run build
```

Validation:

- `bun install` creates `bun.lock`.
- `bun run build` passes.
- `node dist/index.js --help` works.
- `bun run check` works after Biome and Prettier are added in the next steps.

Failure modes:

- Native dependencies such as `better-sqlite3` may need a rebuild under Bun-managed installs.
- If `bun install` changes transitive dependency versions, verify scanner behavior against fixtures before merging.
- Do not change the published CLI shebang from Node to Bun unless package consumers are expected to have Bun installed.

### Step 0.2. Add Biome for Fast Linting and Import Hygiene

Files:

- `package.json`
- `biome.json`
- `src/**/*`

Change:

- Add Biome as a dev dependency.
- Use Biome for lint checks and safe import/style diagnostics.
- Do not let Biome and Prettier fight over formatting. Configure Biome formatter as disabled if Prettier is the formatting source of truth.

Install:

```bash
bun add -d @biomejs/biome
```

`biome.json` snippet:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "files": {
    "includes": ["src/**/*.ts", "scripts/**/*.ts"]
  },
  "formatter": {
    "enabled": false
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

Validation:

- `bun run lint`
- `bunx biome check src`

Failure modes:

- Biome may flag many existing style issues. If the count is high, commit the config first, then apply lint fixes in a separate mechanical PR.
- Avoid enabling aggressive rules that force broad refactors before Codex support is implemented.

### Step 0.3. Add Prettier for Stable Formatting

Files:

- `package.json`
- `.prettierrc.json`
- `.prettierignore`
- `src/**/*`
- `docs/**/*.md`

Change:

- Add Prettier as the canonical formatter.
- Keep formatting rules conservative to minimize churn.

Install:

```bash
bun add -d prettier
```

`.prettierrc.json` snippet:

```json
{
  "singleQuote": true,
  "semi": true,
  "printWidth": 100,
  "trailingComma": "all"
}
```

`.prettierignore` snippet:

```text
dist
node_modules
*.db
*.sqlite
*.sqlite-shm
*.sqlite-wal
bun.lock
docs/index.html
```

Validation:

- `bun run format:check`
- `bun run format` should produce only expected mechanical formatting changes.
- `bun run build` still passes after formatting.

Failure modes:

- Formatting the single-file dashboard HTML may create noisy diffs. Ignore `docs/index.html` and consider whether to ignore `src/dashboard/dashboard.html` as well.
- Prettier may reflow Markdown tables. Review docs diffs before merging.

### Step 0.4. Update Contributor Workflow

Files:

- `README.md`
- `CLAUDE.md`
- `CONTRIBUTORS.md`

Document:

```bash
bun install
bun run check
bun run build
node dist/index.js scan --source claude --db /tmp/claude-vitals.db
```

Validation:

- Fresh clone workflow works with Bun only.
- Global install instructions still work:

```bash
bun install
bun run build
npm install -g .
```

Failure modes:

- Bun is a package manager here, not necessarily the runtime for published CLI users. Keep docs clear on that distinction.

## Phase 1: Make Existing Ingestion Correct

### Step 1. Persist Tool Call IDs

Files:

- `src/db/schema.ts`
- `src/db/database.ts`
- `src/scanner/scanner.ts`

Change:

- Add a stable tool-call id column to `tool_calls`.

Schema snippet:

```sql
ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tool_calls_call_id ON tool_calls(tool_call_id);
```

For fresh schema creation, include `tool_call_id TEXT` near `message_uuid`.

Update `VitalsDB.insertToolCall` to accept `tool_call_id?: string`.

Update `Scanner.ingestParsedSession`:

```ts
this.db.insertToolCall({
  session_id: sessionId,
  message_id: msgId,
  message_uuid: am.uuid || undefined,
  tool_call_id: tc.toolUseId || undefined,
  tool_name: tc.toolName,
  ...
});
```

Validation:

- `bun run build`
- Run `node dist/index.js scan --force --db /tmp/claude-vitals-test.db -v`
- Verify:

```sql
SELECT COUNT(*) FROM tool_calls WHERE tool_call_id IS NOT NULL;
```

Failure modes:

- Existing user databases need schema migration support, not only a changed `CREATE TABLE IF NOT EXISTS`.
- If migration is skipped, `insertToolCall` will fail with `no column named tool_call_id`.

### Step 2. Fix Bash Success Attribution

Files:

- `src/scanner/scanner.ts`
- `src/db/database.ts`

Change:

- Replace the current heuristic that marks every bash call successful.
- Join `tool_calls.tool_call_id` to `tool_results.tool_use_id`.

Implementation pattern:

```sql
UPDATE tool_calls
SET bash_success = CASE
  WHEN EXISTS (
    SELECT 1
    FROM tool_results tr
    WHERE tr.session_id = tool_calls.session_id
      AND tr.tool_use_id = tool_calls.tool_call_id
      AND tr.is_error = 1
  ) THEN 0
  ELSE 1
END
WHERE session_id = ?
  AND category = 'bash'
  AND tool_call_id IS NOT NULL;
```

Validation:

- `bun run build`
- Scan a fixture containing one successful and one failing bash result.
- Verify:

```sql
SELECT bash_success, COUNT(*)
FROM tool_calls
WHERE category = 'bash'
GROUP BY bash_success;
```

Failure modes:

- Claude result content may omit clear error text even when a command failed.
- A missing result should leave `bash_success` as `NULL`, not become success.

### Step 3. Make Scan Idempotent

Files:

- `src/db/schema.ts`
- `src/db/database.ts`
- `src/scanner/scanner.ts`

Change:

- Add source metadata to `sessions`:

```sql
source_path TEXT,
source_mtime_ms INTEGER,
source_size_bytes INTEGER,
provider TEXT NOT NULL DEFAULT 'claude'
```

- Change `isSessionScanned(sessionId)` to compare current file metadata.
- If a session exists but file metadata changed, delete and reingest that session in one transaction.

Delete order:

```sql
DELETE FROM tool_results WHERE session_id = ?;
DELETE FROM tool_calls WHERE session_id = ?;
DELETE FROM thinking_blocks WHERE session_id = ?;
DELETE FROM user_prompts WHERE session_id = ?;
DELETE FROM laziness_violations WHERE session_id = ?;
DELETE FROM reasoning_loops WHERE session_id = ?;
DELETE FROM self_admitted_failures WHERE session_id = ?;
DELETE FROM messages WHERE session_id = ?;
DELETE FROM sessions WHERE id = ?;
```

Validation:

- Scan the same DB twice without changing logs. Child row counts must not change.
- Append one valid log line to a copied fixture and rescan. Only that session's row counts should change.
- `bun run build`

Failure modes:

- `INSERT OR REPLACE` on `sessions` alone creates duplicate child rows.
- Active sessions grow while scanning; metadata should be captured immediately before parsing.

## Phase 2: Introduce Provider Adapters

### Step 4. Extract Shared Normalized Types

Files:

- Add `src/scanner/types.ts`
- Update `src/scanner/log-parser.ts`
- Update `src/scanner/scanner.ts`

Move these types from `log-parser.ts` into `types.ts`:

- `ToolCategory`
- `LazinessCategory`
- `ParsedToolCall`
- `ParsedThinkingBlock`
- `ParsedToolResult`
- `TextPatternMatch`
- `ParsedAssistantMessage`
- `ParsedUserMessage`
- `ParsedSystemMessage`
- `SessionMetadata`
- `ParsedSessionLog`

Add:

```ts
export type SessionProvider = 'claude' | 'codex';

export interface DiscoveredSessionLog {
  provider: SessionProvider;
  filePath: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionLogAdapter {
  provider: SessionProvider;
  discover(): DiscoveredSessionLog[];
  parse(filePath: string): ParsedSessionLog;
}
```

Validation:

- `bun run build`
- Run `node dist/index.js scan --db /tmp/adapter-refactor.db -v` and compare scanned session/tool counts against the previous build on the same sample logs.

Failure modes:

- Moving types can create circular imports if helpers remain mixed with parser code.
- Keep pattern-detection helpers separate from adapter-specific parsing.

### Step 5. Rename Claude Parser Module

Files:

- Move `src/scanner/log-parser.ts` to `src/scanner/claude-adapter.ts`
- Update imports in `src/scanner/scanner.ts`

Change:

- Export a `ClaudeAdapter implements SessionLogAdapter`.
- Preserve current behavior behind the adapter.

Implementation shape:

```ts
export class ClaudeAdapter implements SessionLogAdapter {
  provider = 'claude' as const;

  discover(): DiscoveredSessionLog[] {
    return discoverClaudeSessionLogs();
  }

  parse(filePath: string): ParsedSessionLog {
    return parseClaudeSessionLog(filePath);
  }
}
```

Validation:

- `bun run build`
- `node dist/index.js scan --db /tmp/claude-adapter.db -v`
- `node dist/index.js report --db /tmp/claude-adapter.db`

Failure modes:

- The CLI may still say "Claude Code session logs"; wording can wait, but function should not regress.

### Step 6. Make Scanner Adapter-Driven

Files:

- `src/scanner/scanner.ts`
- `src/index.ts`

Change:

- `Scanner` should accept one or more adapters.

Implementation shape:

```ts
const scanner = new Scanner(db, [new ClaudeAdapter()]);
scanner.scan({ force: opts.force, verbose: opts.verbose, provider: opts.provider });
```

CLI option:

```ts
.option('--source <source>', 'Session source: claude, codex, or all', 'claude')
```

Validation:

- `node dist/index.js scan --source claude --db /tmp/source-claude.db`
- Invalid source should print a clear error and exit non-zero.

Failure modes:

- If source filtering happens after discovery, users with both providers may see confusing "found N" counts.

## Phase 3: Codex Adapter

### Step 7. Discover Codex Sessions

Files:

- Add `src/scanner/codex-adapter.ts`

Discovery:

- Prefer `~/.codex/state_5.sqlite` when present.
- Query:

```sql
SELECT id, rollout_path, created_at, updated_at, cwd, title, model, reasoning_effort, git_branch, cli_version
FROM threads
WHERE rollout_path IS NOT NULL AND rollout_path != ''
ORDER BY updated_at ASC;
```

- Fall back to recursive discovery under `~/.codex/sessions/**/*.jsonl`.

Validation:

- Add a debug-only or test helper that returns discovered count.
- Run `node dist/index.js scan --source codex --db /tmp/codex-vitals.db -v`.
- Expected local shape: files like `~/.codex/sessions/2026/04/19/rollout-...jsonl`.

Failure modes:

- `state_5.sqlite` may be locked or missing.
- `rollout_path` may point at a deleted file.
- Fallback file discovery must still derive a stable session id from the rollout filename.

### Step 8. Parse Codex Metadata and User/Assistant Text

Files:

- `src/scanner/codex-adapter.ts`

Mapping:

- `session_meta.payload.id` -> `metadata.sessionId`
- `session_meta.payload.cwd` -> `metadata.cwd` and `metadata.projectPath`
- `session_meta.payload.git.branch` or DB thread row -> `metadata.gitBranch`
- `turn_context.payload.model` -> `metadata.model`
- `turn_context.payload.effort` -> store as `version` initially, or add `reasoning_effort` to `sessions`
- `event_msg.payload.type === "user_message"` -> `ParsedUserMessage`
- `event_msg.payload.type === "agent_message"` and `response_item.payload.type === "message"` -> assistant text

Text extraction:

```ts
const text = payload.message ?? extractTextFromContent(payload.content) ?? '';
```

Validation:

- Parse one Codex rollout fixture.
- Verify non-zero user prompt count and assistant message count.
- Verify session `cwd`, `model`, and `git_branch` are populated when available.

Failure modes:

- Codex stores both UI events and response items; double-counting assistant text will inflate reasoning-loop/laziness metrics.
- Prefer one text source for assistant messages. Use `event_msg.agent_message` for visible user-facing text, or deduplicate by timestamp/text.

### Step 9. Parse Codex Tool Calls

Files:

- `src/scanner/codex-adapter.ts`
- Possibly add `src/scanner/tool-classifier.ts`

Mappings:

- `response_item.payload.type === "function_call"` -> tool call.
- `payload.name === "exec_command"` -> category derived from command.
- `payload.name === "write_stdin"` -> category `bash` if tied to a running shell session, otherwise `other`.
- `response_item.payload.type === "custom_tool_call"` and `payload.name === "apply_patch"` -> category `edit`.
- `response_item.payload.type === "web_search_call"` -> category `search`.

Command classification:

- Read/research commands: `sed`, `cat`, `nl`, `head`, `tail`, `less`, `rg`, `grep`, `find`, `ls`, `jq`, `sqlite3 ... SELECT`, `git show`, `git diff`, `git status`, `git log`.
- Mutation commands: shell redirection to a file, `cp`, `mv`, `rm`, `mkdir`, `perl -pi`, `python` scripts that write files, package install commands.
- Test/build commands: keep existing build/test regexes and apply them to `exec_command.cmd`.

Target file extraction:

- For `apply_patch`, parse lines:

```text
*** Update File: path
*** Add File: path
*** Delete File: path
```

- For read commands, infer target paths from simple commands only:

```bash
sed -n '1,120p' src/index.ts
nl -ba src/index.ts
cat package.json
rg "pattern" src
```

If target inference is ambiguous, leave `target_file` null.

Validation:

- Build a fixture with:
  - one `sed` read
  - one `rg` search
  - one `apply_patch` edit
  - one successful `npm test`
  - one failing `cargo test`
- Verify `tool_calls.category`, `target_file`, `bash_is_test`, and `bash_success`.

Failure modes:

- Over-inference creates false "not blind" edits.
- Under-inference makes blind edit rate too pessimistic. Prefer under-inference for v1.

### Step 10. Parse Codex Tool Results

Files:

- `src/scanner/codex-adapter.ts`
- `src/scanner/scanner.ts`

Mapping:

- `response_item.payload.type === "function_call_output"` -> `ParsedToolResult` with `toolUseId = payload.call_id`.
- `response_item.payload.type === "custom_tool_call_output"` -> `ParsedToolResult` with `toolUseId = payload.call_id`.
- `event_msg.payload.type === "exec_command_end"` should also update bash success by `call_id` and `exit_code`.

Preferred normalized behavior:

- Store function outputs in `tool_results`.
- For `exec_command_end`, set `bash_success = exit_code === 0` for the matching `tool_call_id`.

Validation:

- Verify:

```sql
SELECT tc.tool_name, tc.tool_call_id, tc.bash_success, tr.is_error
FROM tool_calls tc
LEFT JOIN tool_results tr
  ON tr.session_id = tc.session_id
 AND tr.tool_use_id = tc.tool_call_id
WHERE tc.category = 'bash';
```

Failure modes:

- `function_call_output` can arrive before/after `exec_command_end`; matching must be by `call_id`, not order.

### Step 11. Parse Codex Reasoning and Token Usage

Files:

- `src/scanner/codex-adapter.ts`
- `src/db/schema.ts`
- `src/db/database.ts`

Reasoning:

- Codex `response_item.payload.type === "reasoning"` has `encrypted_content`, `summary`, and sometimes null `content`.
- Store:
  - `is_redacted = content is null && encrypted_content exists`
  - `content_length = visible content length`
  - `signature_length = encrypted_content.length`
  - `estimated_depth = last_token_usage.reasoning_output_tokens` when available, otherwise encrypted length as a provider-local proxy.

Token usage:

- For `event_msg.payload.type === "token_count"`, map `last_token_usage` onto the closest assistant message or create a provider usage event table.
- Minimum viable path: add token totals to the next assistant message encountered after the token event only if attribution is clear.

Validation:

- Verify Codex `thinking_depth_median` is non-zero on sessions with reasoning events.
- Label this metric as provider-local in reports until calibrated.

Failure modes:

- Claude signature length and Codex encrypted reasoning length are not the same unit.
- Do not compare Claude and Codex thinking-depth values directly.

## Phase 4: Provider-Aware Metrics and Reports

### Step 12. Segment Daily Metrics by Provider

Files:

- `src/db/schema.ts`
- `src/db/database.ts`
- `src/metrics/analyzer.ts`
- `src/reports/terminal.ts`
- `src/reports/markdown.ts`
- `src/dashboard/server.ts`
- `src/dashboard/dashboard.html`

Change:

- Add `provider TEXT NOT NULL DEFAULT '_all'` to `daily_metrics`.
- Update unique key to include provider:

```sql
UNIQUE(date, metric_name, provider, model, project_path)
```

- Update `upsertDailyMetric` and query helpers with optional provider.
- Add report option:

```ts
.option('--source <source>', 'Filter by source: claude, codex, or all')
```

Validation:

- Scan Claude and Codex into the same DB.
- Run:

```bash
node dist/index.js report --source claude --db /tmp/mixed.db
node dist/index.js report --source codex --db /tmp/mixed.db
```

Failure modes:

- Existing `_all` metric rows may collide with provider-specific rows after migration.
- Dashboard charts may silently aggregate provider rows unless API filtering is updated.

### Step 13. Disable Non-Portable Benchmarks for Codex

Files:

- `src/reports/terminal.ts`
- `src/reports/markdown.ts`
- `src/regression/detector.ts`
- `src/prescriptions/known-fixes.ts`

Change:

- Keep behavior metrics available for Codex:
  - read/edit ratio
  - research/mutation ratio
  - blind edit rate
  - write/edit percent
  - first tool read percent
  - reasoning loops
  - laziness violations
  - self-admitted failures
  - user interrupts
  - sentiment ratio
  - frustration rate
  - autonomy
  - bash success rate
  - edit churn
  - tool diversity
  - token efficiency
  - session length
- Mark these as provider-local for Codex until calibrated:
  - thinking depth
  - redacted thinking percent
  - cost estimate
  - context pressure

Validation:

- `report --source codex` should not call a Codex thinking value "good" or "degraded" using Claude thresholds.
- `health --source codex` should use only calibrated or explicitly provider-local thresholds.

Failure modes:

- Applying Claude benchmarks to Codex will produce confident but invalid alerts.

## Phase 5: Codex Config Change Tracking and Prescriptions

### Step 14. Provider-Specific Change Trackers

Files:

- `src/changes/tracker.ts`
- Add `src/changes/claude-tracker.ts`
- Add `src/changes/codex-tracker.ts`

Codex files to track:

- `~/.codex/config.toml`
- `~/.codex/rules/**/*.rules`
- `~/.codex/skills/**/SKILL.md`
- Project-level instructions if present in repo, such as `AGENTS.md`, `CLAUDE.md`, `.codex/`, or `.agents/`.

Validation:

- Modify a temp copy of `config.toml` under a test home directory.
- Verify one `changes` row with provider `codex`.

Failure modes:

- Tracking all skills/plugins can snapshot large or unrelated files. Keep the 50 KB cap and store only hashes for very large files.

### Step 15. Provider-Specific Prescriptions

Files:

- `src/prescriptions/prescriber.ts`
- `src/prescriptions/known-fixes.ts`
- Add `src/prescriptions/codex-known-fixes.ts`

Codex prescription types:

- `codex_config_toml`
- `codex_rules`
- `project_instructions`

Do not implement `--apply` for Codex until dry-run output is validated.

Initial Codex dry-run examples:

- Low read/edit ratio -> add project instruction to read target files and callers before editing.
- High blind edit rate -> add rule requiring a read before patching.
- Low bash success -> add rule requiring cwd/command verification and reading full errors.
- High edit churn -> add rule requiring smaller patches and test after each change.

Validation:

- `node dist/index.js prescribe --source codex --format md --db /tmp/codex-vitals.db`
- Output should contain Codex-specific file targets and no `~/.claude` paths.

Failure modes:

- Writing TOML safely requires a TOML parser. Do not mutate `config.toml` with string concatenation.

## Phase 6: Test Fixtures

### Step 16. Add Minimal Test Harness

Files:

- `package.json`
- Add `test/fixtures/claude/basic.jsonl`
- Add `test/fixtures/codex/basic.jsonl`
- Add `test/fixtures/codex/commands.jsonl`
- Add `test/scanner.test.ts`

Package scripts:

```json
{
  "test": "node --test dist-test/**/*.test.js",
  "test:build": "tsc -p tsconfig.test.json"
}
```

If a test build is too much for the first PR, add a script under `scripts/verify-fixtures.ts` and run it with `ts-node` or compiled JS.

Validation cases:

- Claude fixture still produces the same categories as before.
- Codex fixture parses user prompts, assistant messages, reasoning blocks, `exec_command`, `apply_patch`, and command success/failure.
- Double scan does not duplicate child rows.
- Modified source file causes one session to be reingested.

Failure modes:

- Without fixtures, adapter refactors will regress silently.
- Real local Codex logs contain private data; fixtures must be small and synthetic.

## Phase 7: Documentation and CLI Wording

### Step 17. Update User-Facing Docs

Files:

- `README.md`
- `SPEC.md`
- `CLAUDE.md`

Document:

```bash
claude-vitals scan --source claude
claude-vitals scan --source codex
claude-vitals scan --source all
claude-vitals report --source codex
```

Explain:

- Claude and Codex metrics share behavior definitions where possible.
- Thinking-depth values are provider-local.
- Prescriptions are provider-specific.

Validation:

- Commands in README should run or fail with a deliberate "no data" message.

Failure modes:

- Documentation that implies metric equivalence will mislead users.

## Suggested PR Order

1. Tooling baseline: Bun, Biome, Prettier, and contributor workflow docs.
2. Ingestion correctness: `tool_call_id`, bash success, idempotent rescan.
3. Adapter extraction with `ClaudeAdapter`, no behavior change.
4. Codex discovery and parser for sessions, text, tools, tool results.
5. Provider-aware schema and report filtering.
6. Codex calibration, prescriptions, and config tracking.
7. Fixture tests and docs polish.

## Definition of Done

- Bun is the package manager, `bun.lock` is committed, and `package-lock.json` is removed.
- `bun run check` passes.
- `bun run build` passes.
- Fixture verification passes.
- Scanning the same unchanged source twice does not change child row counts.
- `scan --source claude` preserves current Claude behavior.
- `scan --source codex` ingests Codex sessions from `~/.codex/sessions` or `state_5.sqlite`.
- `report --source codex` produces behavior metrics without Claude-only benchmark claims.
- `prescribe --source codex` does not write to `~/.claude`.
- Failure to read a Codex SQLite DB or rollout file is reported per file and does not abort the whole scan.
