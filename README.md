Your AI coding assistant's quality is invisible. You feel it getting worse but can't prove it. Now you can.

# claude-vitals

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Docs](https://img.shields.io/badge/docs-claude--vitals-00d4ff.svg)](https://okohedeki.github.io/claude-vitals/)

Continuous quality monitoring for Claude Code. Detect regressions. Prescribe fixes. Self-correct.

## The Problem

AI coding quality degrades silently. By the time you notice, it's been broken for weeks. [@stellaraccident](https://github.com/stellaraccident) proved this across [234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796) — thinking depth had dropped 67% before anyone noticed, blind edits tripled, and costs spiraled from $12/day to $1,504/day. claude-vitals makes that analysis continuous and automatic.

Credit: Built on [@stellaraccident](https://github.com/stellaraccident)'s [analysis of 234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796).

## Quick Start

```bash
git clone https://github.com/Okohedeki/claude-vitals.git
cd claude-vitals && npm install && npm run build
node dist/index.js scan && node dist/index.js health
```

## What It Does

### Detect
`claude-vitals scan && claude-vitals health`
Ingests your session logs into SQLite. One-line green/yellow/red health check across all 20 metrics.

### Understand
`claude-vitals report` / `claude-vitals compare`
Terminal report with sparklines and trend arrows. Side-by-side period comparison to see what changed.

### Fix
`claude-vitals prescribe --apply`
When metrics degrade, prescribe outputs the exact env vars, `settings.json` changes, and `CLAUDE.md` rules to fix them. `--apply` writes them automatically.

### Self-Correct
`/vitals` skill in Claude Code
Claude checks its own quality mid-session and applies behavioral corrections. Install with `bash scripts/install.sh`.

## The 5 Numbers That Matter

| Metric | Good | Degraded | What it means |
|--------|------|----------|---------------|
| Read:Edit Ratio | 6.6 | 2.0 | Reads 6 files before editing 1 = understands context |
| Thinking Depth | 2,200 | 600 | Deeper thinking = fewer errors downstream |
| Blind Edit Rate | 6.2% | 33.7% | Editing files you haven't read |
| Laziness / day | 0 | 10 | "Should I continue?" — five categories of dodging |
| Sentiment Ratio | 4.4 | 3.0 | Your language shifts when quality drops |

[All 20 metrics in the docs](https://okohedeki.github.io/claude-vitals/#metrics)

## Prescriptions

When metrics degrade, `prescribe` tells you exactly what to change:

```
claude-vitals prescribe

  PRESCRIPTIONS
  4 metrics degraded: 2 critical, 2 warning

  1. Thinking Depth at 580 (threshold: 600)
     ENV: CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = 1
     ENV: MAX_THINKING_TOKENS = 31999
     settings.json: effortLevel = high

  2. Blind Edit Rate at 22% (threshold: 33.7%)
     CLAUDE.md: Zero tolerance policy for blind edits

  TO APPLY:
    claude-vitals prescribe --apply
```

## Commands

| Command | Description |
|---------|-------------|
| `scan` | Ingest session logs and compute metrics |
| `health` | One-line green/yellow/red status |
| `report` | Terminal report with sparklines |
| `report --format md` | GitHub-postable markdown report |
| `dashboard` | Web dashboard on localhost:7847 |
| `compare <p1> <p2>` | Side-by-side period comparison |
| `prescribe` | Output fix recommendations |
| `prescribe --apply` | Apply fixes automatically |
| `annotate "<desc>"` | Log a manual change event |
| `impact <id>` | Before/after analysis for a change |
| `changes` | List all tracked changes |

## Documentation

Full docs: [okohedeki.github.io/claude-vitals](https://okohedeki.github.io/claude-vitals/)

## Credits

Built on the research of [@stellaraccident](https://github.com/stellaraccident), whose [analysis of 234,760 tool calls](https://github.com/anthropics/claude-code/issues/42796) proved that reduced thinking depth causes measurable quality collapse — and gave us every metric and benchmark we use.

## License

MIT
