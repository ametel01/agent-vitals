Your AI coding assistant's quality is invisible. You feel it getting worse but can't prove it. Now you can.

# claude-vitals

Continuous quality monitoring for Claude Code. 20 metrics. Automatic regression detection. Change-impact analysis. Self-correcting skills.

## Why this exists

In March 2025, [@stellaraccident](https://github.com/stellaraccident) published [an analysis](https://github.com/anthropics/claude-code/issues/42796) that changed how people think about AI coding tool quality. Across 234,760 tool calls, they proved that reduced thinking depth caused measurable quality collapse — and that it was invisible until you went looking for it.

The Read:Edit ratio dropped 70%. One in three edits became blind. Laziness signals went from zero to ten per day. Cost went from $12/day to $1,504/day while user effort stayed flat. The model wasted everything.

The kicker: thinking depth had dropped 67% before anyone noticed, because redaction hid it. By the time users felt the quality change, it had already been degrading for weeks.

That analysis was a snapshot. claude-vitals makes it continuous.

Every metric, benchmark, and threshold in this tool traces back to stellaraccident's work. The Read:Edit ratio framework, blind edit detection, laziness signal taxonomy, sentiment vocabulary analysis, the discovery that signature length correlates 0.97 with actual thinking depth — all of it.

We just automated it and added the piece nobody else is building: change-impact tracking. Tweak your setup, measure what happened, keep or revert. A feedback loop for AI coding tools.

## Install

```bash
git clone https://github.com/YOUR_USERNAME/claude-vitals.git
cd claude-vitals
npm install
npm run build
```

Install the Claude Code skills:

```bash
bash scripts/install.sh
```

This gives you `/vitals`, `/vitals-quick`, `/vitals-report`, and `/vitals-dashboard` in any Claude Code session.

Requires Node.js >= 18.

## Quick Start

```bash
# Scan your session logs and compute metrics
claude-vitals scan

# One-line health check
claude-vitals health
# 🟢 All metrics are stable -- no regressions detected.
# or
# 🔴 3 critical regressions detected -- immediate attention needed.

# Full terminal report with sparklines and trend arrows
claude-vitals report

# GitHub-postable markdown report
claude-vitals report --format md

# Launch the web dashboard
claude-vitals dashboard
```

## Skills — Claude Self-Verification

The real point. Claude can check its own quality and correct itself.

| Skill | What it does |
|-------|-------------|
| `/vitals` | Full diagnostic. Scans logs, checks all 20 metrics, identifies degraded areas, applies mandatory behavioral corrections for the session. |
| `/vitals-quick` | Fast check. Silent if green. If yellow/red, reports the issue and applies corrections. |
| `/vitals-report` | Generates a GitHub-postable markdown report. |
| `/vitals-dashboard` | Launches the interactive web dashboard. |

When `/vitals` detects degraded metrics, it doesn't just report them — it forces behavioral corrections:

- **Low Read:Edit?** Every edit must be preceded by reading the target file and 2 related files.
- **High Blind Edit Rate?** Zero tolerance. Must verify every file was read before editing.
- **Laziness Detected?** Banned phrases enforced. No "should I continue?", no "good stopping point."
- **High Frustration?** More thorough research. No partial work. No unnecessary questions.

This is the feedback loop: measure quality, detect degradation, correct behavior, measure again.

## What It Tracks

### The Numbers That Matter

| # | Metric | Good | Degraded | What it means |
|---|--------|------|----------|---------------|
| 1 | Thinking Depth | ~2,200 chars | ~600 chars | When thinking is shallow, everything downstream degrades |
| 2 | Read:Edit Ratio | 6.6 | 2.0 | Reads 6 files before editing 1 = understands context. Reads 2 = guessing. |
| 3 | Research:Mutation | 8.7 | 2.8 | All information-gathering vs all code changes |
| 4 | Blind Edit Rate | 6.2% | 33.7% | Editing files you haven't read. One in three is catastrophic. |
| 5 | Write vs Edit | 4.9% | 11.1% | Full-file rewrites vs surgical edits |
| 6 | First Tool After Prompt | — | — | Read first = researching. Edit first = guessing. |
| 7 | Reasoning Loops / 1K | 8.2 | 26.6 | "Oh wait", "actually" — contradictions leaking from shallow thinking |
| 8 | Laziness / day | 0 | 10 | "Shall I proceed?", "good stopping point" — five categories of dodging |
| 9 | Self-Admitted Failures / 1K | 0.1 | 0.5 | "I was sloppy" — knows what good looks like but didn't check |
| 10 | User Interrupts / 1K | 0.9 | 11.4 | How often you hit Escape. 12x increase = 12x the overhead. |
| 11 | Sentiment Ratio | 4.4 | 3.0 | Your language shifts. "please"/"thanks" drop 50%. "stop" rises 87%. |
| 12 | Frustration Rate | 5.8% | 9.8% | Percentage of your prompts containing frustration |
| 13 | Session Autonomy | — | — | Time between your prompts. Declining = can't trust it alone. |
| 14 | Edit Churn | — | — | Same file edited 3+ times without reads between. Trial-and-error. |
| 15 | Bash Success Rate | — | — | Whether edits actually work |
| 16 | Sub-agent % | — | — | Delegation patterns |
| 17 | Context Pressure | — | — | Does quality drop as context fills? |
| 18 | Model Segmentation | — | — | All metrics broken down by model |
| 19 | Cost Efficiency | — | — | Cost per successful edit. Detects $12/day → $1,504/day spirals. |
| 20 | Prompts / Session | 35.9 | 27.9 | Users give up faster when quality is bad. |

All benchmarks from [stellaraccident's analysis](https://github.com/anthropics/claude-code/issues/42796).

## Commands

| Command | Description |
|---------|-------------|
| `claude-vitals scan` | Ingest session logs into SQLite and compute metrics |
| `claude-vitals report` | Terminal report with sparklines and trend arrows |
| `claude-vitals report --format md` | GitHub-postable markdown report |
| `claude-vitals health` | One-line green/yellow/red health status |
| `claude-vitals dashboard` | Launch web dashboard (dark theme, all charts) |
| `claude-vitals compare <period1> <period2>` | Side-by-side period comparison |
| `claude-vitals annotate "<description>"` | Log a manual change event |
| `claude-vitals impact <change-id>` | Before/after analysis for a change |
| `claude-vitals changes` | List all tracked changes |

## Change Impact Tracking

Everything above tells you HOW quality is trending. Change tracking tells you WHY.

**Automatic detection:**
- `~/.claude/CLAUDE.md` and per-project CLAUDE.md files
- `~/.claude/settings.json`
- Skill files in `~/.claude/commands/`

**Manual annotations:**
```bash
claude-vitals annotate "Switched to Opus"
claude-vitals annotate "Set /effort max"
claude-vitals annotate "Rewrote CLAUDE.md testing section"
claude-vitals annotate "Started 5 concurrent sessions"
```

For every change, 7 days before vs 7 days after across 8 key metrics:

```
  IMPACT ANALYSIS — Change #3

  "Switched to Opus" (2024-01-15)

  Metric                         Before      After     Change    Verdict
  ──────────────────────────────────────────────────────────────────────────
  read edit ratio                   2.1        5.8     +176.2%   improved
  thinking depth median           620.0     2100.0     +238.7%   improved
  blind edit rate                  28.3%       7.1%     -74.9%   improved
  laziness total                     12          1      -91.7%   improved

  ✓ This change IMPROVED quality across 8/8 key metrics
```

This is the core loop: tweak your setup, measure impact, keep or revert. Nobody else is building this feedback mechanism for AI coding tools.

## Regression Detection

Compares rolling 7-day windows. Auto-flags when:
- Read:Edit drops >20% (warning) / >40% (critical)
- Thinking depth drops >15% / >30%
- Blind edit rate rises >10pp / >20pp
- Laziness signals rise >50% / >100%
- Sentiment ratio drops >15% / >30%
- Session autonomy drops >25% / >50%
- Bash success rate drops >10pp / >20pp

Surfaces in CLI (`claude-vitals health`), in reports, and as alert banners on the dashboard.

## Dashboard

Single-file HTML, no build step. React + Recharts from CDN, dark theme, Grafana-inspired. Change timeline across the top — click any change to see its impact overlay on all charts.

```bash
claude-vitals dashboard
# Opens http://localhost:7847
```

## How It Works

Session logs live at `~/.claude/projects/` (Unix) or `%USERPROFILE%\.claude\projects\` (Windows). Each session is a JSONL file containing every message, tool call, thinking block, and model response.

`claude-vitals scan` reads these files, classifies every tool call, detects behavioral patterns in assistant output, analyzes user sentiment, and stores everything in a SQLite database at `~/.claude-vitals/vitals.db`.

Metrics are computed daily and compared against baselines from the original analysis.

## Project Structure

```
claude-vitals/
├── src/
│   ├── index.ts              CLI entry point (Commander.js)
│   ├── scanner/
│   │   ├── log-parser.ts     JSONL session log parser
│   │   └── scanner.ts        Scan orchestration + ingestion
│   ├── metrics/
│   │   └── analyzer.ts       All 20 metric computations
│   ├── regression/
│   │   └── detector.ts       Rolling 7-day regression detection
│   ├── changes/
│   │   └── tracker.ts        Config change detection + annotations
│   ├── reports/
│   │   ├── terminal.ts       Colored CLI output with sparklines
│   │   └── markdown.ts       GitHub-postable markdown report
│   ├── dashboard/
│   │   ├── server.ts         HTTP server + JSON API
│   │   └── dashboard.html    Single-file React + Recharts dashboard
│   └── db/
│       ├── schema.ts         SQLite schema (11 tables)
│       └── database.ts       Connection + query layer
├── scripts/
│   ├── install.sh            Install skills to ~/.claude/commands/
│   └── uninstall.sh          Remove skills
├── SKILL.md                  Skill definition (the self-verification logic)
├── SPEC.md                   Full specification (the 20 metrics, why, how)
├── CHANGELOG.md              Version history
├── CONTRIBUTORS.md           Credits
└── CLAUDE.md                 Project docs for Claude
```

## Credits

Built on the research of **[@stellaraccident](https://github.com/stellaraccident)**, whose [analysis of 234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796) proved that reduced thinking depth causes measurable, cascading quality collapse in AI coding assistants — and gave us every metric and benchmark we use.

Project structure inspired by [@mvanhorn](https://github.com/mvanhorn)'s [last30days-skill](https://github.com/mvanhorn/last30days-skill).

## License

MIT
