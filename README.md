Your AI coding assistant's quality is invisible. You feel it getting worse but can't prove it. Now you can.

# agent-vitals

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs-agent--vitals-00d4ff.svg)](https://ametel01.github.io/agent-vitals/)

Continuous quality monitoring for Claude Code and Codex CLI. Detect regressions. Prescribe fixes. Self-correct.

## The Problem

AI coding quality degrades silently. By the time you notice, it's been broken for weeks. [@stellaraccident](https://github.com/stellaraccident) proved this across [234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796) — thinking depth had dropped 67% before anyone noticed, blind edits tripled, and costs spiraled from $12/day to $1,504/day. agent-vitals makes that analysis continuous and automatic.

Credit: Built on [@stellaraccident](https://github.com/stellaraccident)'s [analysis of 234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796).

## Quick Start

```bash
git clone https://github.com/ametel01/agent-vitals.git
cd agent-vitals && bun install && bun run build
node dist/index.js scan && node dist/index.js health
```

Bun is the package manager used for development; the CLI itself still runs on Node (`dist/index.js` uses `#!/usr/bin/env node`), so end users who install the published binary are not required to have Bun installed.

To scan Codex CLI sessions instead of Claude Code sessions:

```bash
node dist/index.js scan --source codex
node dist/index.js report --source codex
node dist/index.js health --source codex
```

## What It Does

### Detect

`agent-vitals scan && agent-vitals health`
Ingests your session logs into SQLite. One-line green/yellow/red health check across all 24 metrics.

Use `--source claude`, `--source codex`, or `--source all` to choose which assistant logs to ingest or inspect. `scan`, `report`, `health`, and `prescribe` default to `all`.

### Understand

`agent-vitals report` / `agent-vitals compare`
Terminal report with sparklines and trend arrows. Side-by-side period comparison to see what changed.

### Fix

`agent-vitals prescribe --apply`
When metrics degrade, prescribe outputs the exact env vars, `settings.json` changes, and `CLAUDE.md` rules to fix them. `--apply` writes them automatically.

Prescriptions are provider-specific and both providers support `--apply`. Claude prescriptions write to `~/.claude/settings.json` and `CLAUDE.md`; Codex prescriptions write to `~/.codex/config.toml`, `~/.codex/rules/*.rules`, and `AGENTS.md`.

### Self-Correct

`/vitals` skill in Claude Code
The skill checks session quality mid-session and applies behavioral corrections. Install with `bash scripts/install.sh`.

---

## The 24 Metrics

All benchmarks from [@stellaraccident's analysis](https://github.com/anthropics/claude-code/issues/42796). "Good" and "Degraded" are the values observed in working vs regressed Claude Code sessions.

### Thinking

#### 1. Thinking Depth (median)

**Good:** ≥ 2,200 chars · **Degraded:** ≤ 600 chars

The single most upstream quality indicator. Measures how much internal reasoning Claude does before responding. Uses signature length as a proxy when thinking content is redacted (correlates 0.97 with actual depth). When thinking is shallow, everything downstream degrades: reads drop, blind edits rise, laziness appears. **How it's used:** Early warning system. Thinking depth drops weeks before users feel the quality change.

#### 2. Thinking Depth Redacted %

**Good:** low · **Degraded:** high

Percentage of thinking blocks with no content, only a signature. High redaction hides quality changes from users. **How it's used:** Alerts you when thinking is invisible, so you can't be gaslit by the output looking normal.

### Behavior

#### 3. Read:Edit Ratio

**Good:** ≥ 6.6 · **Degraded:** ≤ 2.0

The most powerful behavioral signal. Files read divided by files edited. A model that reads 6 files before editing 1 understands context. A model that reads 2 is guessing. **How it's used:** The single number that best captures "is the agent doing good work."

#### 4. Research:Mutation Ratio

**Good:** ≥ 8.7 · **Degraded:** ≤ 2.8

Broader version of Read:Edit. Counts all research actions (Read + Grep + Glob + Search) over all mutation actions (Edit + Write). Catches cases where Claude is reading but not grepping for usages. **How it's used:** Detects shallow reading — files opened but not cross-referenced.

#### 5. Blind Edit Rate

**Good:** ≤ 6.2% · **Degraded:** ≥ 33.7%

Percentage of edits where the target file wasn't read in the preceding 10 tool calls. Blind edits cause spliced comments, duplicated logic, and broken conventions. **How it's used:** When this goes above 20%, Claude is modifying code it hasn't looked at. Correlates directly with broken builds and user corrections.

#### 6. Write vs Edit %

**Good:** ≤ 4.9% · **Degraded:** ≥ 11.1%

Full-file Write/CreateFile operations as a percentage of all mutations. Full-file writes lose precision — they clobber surrounding code, drop comments, reset formatting. **How it's used:** Detects the shift from surgical edits to lazy rewrites.

#### 7. First Tool = Read %

**Good:** ≥ 40% · **Degraded:** ≤ 15%

Percentage of user prompts where Claude's first tool call is Read (vs Edit, Write, or Bash). Reveals whether Claude plans before acting. **How it's used:** A leading indicator — "first tool" shifts from Read to Edit before overall Read:Edit ratio drops.

### Quality Signals

#### 8. Reasoning Loops / 1K calls

**Good:** ≤ 8.2 · **Degraded:** ≥ 26.6

Visible self-corrections in Claude's output: "oh wait", "actually,", "let me reconsider", "hmm, actually", "no wait", "on second thought". When thinking is deep, contradictions get resolved internally. When it's shallow, they leak into output. **How it's used:** Sessions with 5+ reasoning loops are flagged as "thrashing."

#### 9. Laziness Violations / day

**Good:** 0 · **Degraded:** ≥ 10

Five categories of corner-cutting phrases:

- **Ownership dodging:** "not caused by my changes", "pre-existing", "outside the scope"
- **Permission seeking:** "should I continue?", "shall I proceed?", "would you like me to"
- **Premature stopping:** "good stopping point", "natural checkpoint", "let's pause here"
- **Known-limitation labeling:** "known limitation", "future work", "out of scope for now"
- **Session-length excuses:** "continue in a new session", "context is getting large"

**How it's used:** The existence of any violations is diagnostic. Zero is the target. Every phrase in the hook was added in response to a specific failure.

#### 10. Self-Admitted Failures / 1K

**Good:** ≤ 0.1 · **Degraded:** ≥ 0.5

Phrases like "that was lazy", "I was sloppy", "my mistake", "I rushed this". These are cases where Claude knows what good work looks like but didn't have the thinking budget to check itself. **How it's used:** Measures the gap between Claude's standards and its actual output.

#### 11. User Interrupts / 1K

**Good:** ≤ 0.9 · **Degraded:** ≥ 11.4

How often you hit Escape to stop Claude mid-action. Each interrupt = the user saw something wrong, stopped their own work, identified the error, and redirected. **How it's used:** Pure overhead measurement. 12x increase from good to degraded = 12x the supervision cost.

### User Experience

#### 12. Sentiment Ratio

**Good:** ≥ 4.4 · **Degraded:** ≤ 3.0

Positive words (great, good, love, nice, thanks, perfect, excellent) divided by negative words (wrong, broken, lazy, sloppy, stop, fuck, shit). Measures how your language shifts as quality changes. **How it's used:** The user going from "great, let's..." to "stop doing that" is measurable. Politeness collapses (please/thanks drop ~50%). "Simplest" rises 642%.

#### 13. Frustration Rate

**Good:** ≤ 5.8% · **Degraded:** ≥ 9.8%

Percentage of user prompts containing frustration indicators: profanity, "wrong", "no", "stop", "I said", "I already told you", "that's not what I asked". **How it's used:** More targeted than sentiment — specifically measures "the user is unhappy right now."

#### 14. Session Autonomy (median minutes)

**Good:** ≥ 10 min · **Degraded:** ≤ 3 min

Median time gap between consecutive user prompts within a session. Longer gaps = Claude works autonomously. Shorter gaps = user constantly correcting. **How it's used:** Declining autonomy means the user can't trust the model to work alone. Declining trust is a late-stage quality signal.

#### 15. Prompts Per Session

**Good:** ≥ 35.9 · **Degraded:** ≤ 27.9

Average prompts per session. When quality drops, users give up faster — 22% fewer prompts before abandoning the session. **How it's used:** Measures engagement loss. Short sessions = lost confidence.

### Efficiency

#### 16. Edit Churn Rate

**Good:** low · **Degraded:** high

Percentage of edits that are part of a "churn sequence" — same file edited 3+ times within 10 consecutive tool calls without reads between. Distinguishes legitimate iterative refactoring (reads between edits) from thrashing (back-to-back edits). **How it's used:** Detects trial-and-error coding instead of planned changes.

#### 17. Bash Success Rate

**Good:** ≥ 90% · **Degraded:** ≤ 80%

Percentage of bash tool calls that succeed (vs failed exit codes or error patterns). Classified by type: build commands, test commands, git commands, other. **How it's used:** Proxy for whether edits actually work. Declining test pass rate after a period of edits = Claude is writing broken code.

#### 18. Sub-agent Usage %

**Good:** low–moderate · **Degraded:** high

Percentage of tool calls that spawn sub-agents. Moderate delegation is healthy (parallel research + implementation). Excessive delegation often means the main agent is avoiding complex work. **How it's used:** Tracks whether Claude is distributing work appropriately or dodging.

#### 19. Daily Cost Estimate

**Good:** stable · **Degraded:** spiking 3x+

Estimated daily cost from token usage (input + output + cache read + cache write, priced at Opus tiers). **How it's used:** Detects cost spirals. The original analysis showed cost went from $12/day to $1,504/day while user effort stayed flat — the model was burning tokens on thrashing, not output.

### Context

#### 20. Context Pressure

**Good:** stable · **Degraded:** quality drops as context fills

Estimates cumulative context size through a session and segments quality metrics by context utilization quartile (Q1–Q4). **How it's used:** Answers "at what context percentage does quality start degrading?" Helps identify optimal compaction points.

### Extended (v1.1)

#### 21. Time of Day Quality

Hourly breakdown of Read:Edit ratio. Original analysis found 5pm PST was worst, late night was best, suggesting load-sensitive quality allocation. **How it's used:** Identifies your best and worst hours for complex coding work. Schedule high-stakes tasks during your best-performing window.

#### 22. Tool Diversity

Unique tools used per session. More diverse tool usage = broader research patterns. **How it's used:** Low diversity often means Claude is stuck in an edit-edit-edit loop without varying approach. Higher diversity correlates with thorough work.

#### 23. Token Efficiency

Output tokens per successful edit. **How it's used:** Detects wasted compute. When this spikes, Claude is generating lots of text per edit — usually from self-corrections, explanations of failures, or thrashing.

#### 24. Session Length (minutes)

Average session duration. **How it's used:** Combined with prompts/session, tells you whether sessions are getting shorter because users give up, or longer because tasks take more attempts.

---

## Prescriptions

When metrics degrade, `prescribe` tells you exactly what to change:

```
agent-vitals prescribe

  PRESCRIPTIONS
  4 metrics degraded: 2 critical, 2 warning

  1. Thinking Depth at 580 (threshold: 600)
     ENV: CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = 1
     ENV: MAX_THINKING_TOKENS = 31999
     settings.json: effortLevel = high

  2. Blind Edit Rate at 22% (threshold: 33.7%)
     CLAUDE.md: Zero tolerance policy for blind edits

  TO APPLY:
    agent-vitals prescribe --apply
```

Use `agent-vitals baseline` to see recommended baseline settings for Claude Code or Codex users, regardless of current metrics.

Codex support currently covers scanning, provider-aware metrics, health checks, terminal reports, Markdown reports, dashboard filtering with a source selector, comparisons, impact analysis, baseline recommendations, and `prescribe --apply` writers for `~/.codex/config.toml`, `~/.codex/rules/*.rules`, and project `AGENTS.md`. Claude-calibrated benchmarks for thinking depth, redaction rate, cost, and context pressure are shown as provider-local for Codex instead of being judged against Claude thresholds.

## Commands

| Command                              | Description                                             |
| ------------------------------------ | ------------------------------------------------------- |
| `scan`                               | Ingest Claude and Codex session logs                    |
| `scan --source claude`               | Ingest Claude Code session logs                         |
| `scan --source codex`                | Ingest Codex CLI session logs                           |
| `scan --source all`                  | Ingest Claude and Codex session logs                    |
| `health`                             | One-line green/yellow/red status across all sources     |
| `health --source claude`             | One-line health status for Claude metrics               |
| `health --source codex`              | One-line health status for Codex metrics                |
| `report`                             | Terminal report with sparklines across all sources      |
| `report --source claude`             | Terminal report filtered to Claude sessions             |
| `report --source codex`              | Terminal report filtered to Codex sessions              |
| `report --format md`                 | GitHub-postable markdown report                         |
| `report --source claude --format md` | Markdown report filtered to Claude sessions             |
| `report --source codex --format md`  | Markdown report filtered to Codex sessions              |
| `baseline`                           | Show recommended baseline settings for Claude users     |
| `baseline --source claude`           | Show recommended baseline settings for Claude users     |
| `baseline --source codex`            | Show recommended baseline settings for Codex users      |
| `baseline --apply`                   | Write Claude baseline settings to `~/.claude/`          |
| `baseline --source claude --apply`   | Write Claude baseline settings to `~/.claude/`          |
| `baseline --source codex --apply`    | Write Codex baselines to `~/.codex/` and `./AGENTS.md`  |
| `prescribe`                          | Output Claude fix recommendations from degraded metrics |
| `prescribe --source claude`          | Output Claude fix recommendations from degraded metrics |
| `prescribe --source codex`           | Output Codex fix recommendations from degraded metrics  |
| `prescribe --apply`                  | Apply Claude fixes automatically                        |
| `prescribe --source claude --apply`  | Apply Claude fixes automatically                        |
| `prescribe --source codex --apply`   | Apply Codex fixes to rules, `config.toml`, `AGENTS.md`  |
| `dashboard`                          | Web dashboard on localhost:7847 across all sources      |
| `dashboard --source claude`          | Open dashboard with Claude as the default source        |
| `dashboard --source codex`           | Open dashboard with Codex as the default source         |
| `compare <p1> <p2>`                  | Side-by-side period comparison across all sources       |
| `compare <p1> <p2> --source claude`  | Side-by-side period comparison for Claude metrics       |
| `compare <p1> <p2> --source codex`   | Side-by-side period comparison for Codex metrics        |
| `annotate "<desc>"`                  | Log a manual change event (tagged as global)            |
| `annotate "<desc>" --source claude`  | Log a manual change event tagged to the Claude timeline |
| `annotate "<desc>" --source codex`   | Log a manual change event tagged to the Codex timeline  |
| `impact <id>`                        | Before/after analysis for a change across all sources   |
| `impact <id> --source claude`        | Before/after analysis for Claude metrics                |
| `impact <id> --source codex`         | Before/after analysis for Codex metrics                 |
| `changes`                            | List all tracked changes                                |
| `changes --source claude`            | List changes tagged to Claude plus global annotations   |
| `changes --source codex`             | List changes tagged to Codex plus global annotations    |

Source filters:

- `claude`: Claude Code logs from `~/.claude/projects`.
- `codex`: Codex CLI rollouts from `~/.codex/state_5.sqlite` or `~/.codex/sessions`.
- `all`: Aggregate all supported providers in the same database.

## Documentation

Full docs: [ametel01.github.io/agent-vitals](https://ametel01.github.io/agent-vitals/)

## Credits

Built on the research of [@stellaraccident](https://github.com/stellaraccident), whose [analysis of 234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796) proved that reduced thinking depth causes measurable quality collapse — and gave us every metric and benchmark we use.

## License

MIT
