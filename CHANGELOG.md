# Changelog

## 1.0.0 — 2026-04-10

Initial release.

### What's in it

- **20 quality metrics** computed from Claude Code session logs: thinking depth, read:edit ratio, research:mutation ratio, blind edit rate, write vs edit, first tool after prompt, reasoning loops, laziness signals, self-admitted failures, user interrupts, sentiment, frustration rate, session autonomy, edit churn, bash success rate, subagent behavior, context window pressure, model segmentation, cost efficiency, prompts per session
- **Session log parser** that reads JSONL files from `~/.claude/projects/`, classifies every tool call, detects behavioral patterns, and extracts thinking block depths
- **Regression detection** comparing rolling 7-day windows with configurable warning/critical thresholds
- **Change impact tracking** — automatic detection of CLAUDE.md, settings, and skill file changes, plus manual annotations with 7-day before/after analysis
- **CLI commands**: `scan`, `report`, `health`, `dashboard`, `compare`, `annotate`, `impact`, `changes`
- **Terminal report** with colored output, sparklines, and trend arrows
- **Markdown report** structured for posting as GitHub issues
- **Single-file HTML dashboard** with React + Recharts from CDN, dark theme, change timeline overlay
- **Skill integration** — `/vitals`, `/vitals-quick`, `/vitals-report`, `/vitals-dashboard` for self-verification inside Claude Code sessions

### Inspired by

[@stellaraccident's analysis](https://github.com/anthropics/claude-code/issues/42796) proving that reduced thinking depth caused measurable quality collapse across 234,760 tool calls.
