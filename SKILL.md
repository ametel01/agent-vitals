---
name: claude-vitals
version: "1.0.0"
description: >
  Self-quality verification for Claude Code. Scans session logs, computes 20
  behavioral and quality metrics, detects regressions, and applies corrective
  behaviors when performance degrades. Based on the analysis of 234,760 tool
  calls that proved reduced thinking depth causes measurable quality collapse.
argument-hint: |
  /vitals              Full diagnostic with behavioral corrections
  /vitals-quick        Fast health check, silent if green
  /vitals-report       GitHub-postable markdown report
  /vitals-dashboard    Launch the web dashboard
allowed-tools:
  - Bash
  - Read
user-invocable: true
homepage: https://github.com/anthropics/claude-code/issues/42796
author: Built on research by @stellaraccident
license: MIT
---

# claude-vitals

Self-quality verification for Claude Code sessions.

You are running a diagnostic check against your own session logs. The data comes from your actual behavior — tool calls, thinking blocks, user reactions — not self-assessment.

---

## /vitals — Full Diagnostic

### Step 1: Scan

Ingest any new session data and compute metrics:

```bash
node H:/ClaudeValidate/dist/index.js scan
```

### Step 2: Health Check

```bash
node H:/ClaudeValidate/dist/index.js health
```

If GREEN — report "Vitals: green" to the user and stop.

If YELLOW or RED — continue to Step 3.

### Step 3: Full Report

```bash
node H:/ClaudeValidate/dist/index.js report
```

Read the output. Identify every metric in WARNING or DEGRADED range using these benchmarks:

| Metric | Good | Degraded |
|--------|------|----------|
| Read:Edit Ratio | >= 6.6 | <= 2.0 |
| Research:Mutation Ratio | >= 8.7 | <= 2.8 |
| Blind Edit Rate | <= 6.2% | >= 33.7% |
| Write vs Edit % | <= 4.9% | >= 11.1% |
| Thinking Depth (median) | >= 2,200 | <= 600 |
| Reasoning Loops / 1K | <= 8.2 | >= 26.6 |
| Laziness Violations / day | 0 | >= 10 |
| Self-Admitted Failures / 1K | <= 0.1 | >= 0.5 |
| User Interrupts / 1K | <= 0.9 | >= 11.4 |
| Sentiment Ratio | >= 4.4 | <= 3.0 |
| Frustration Rate | <= 5.8% | >= 9.8% |
| Prompts / Session | >= 35.9 | <= 27.9 |

### Step 4: Behavioral Corrections

CRITICAL: These are not suggestions. For each degraded metric, apply the correction immediately.

**Low Read:Edit Ratio (< 4.0):**
Before ANY edit, read the target file AND at least 2 related files. No exceptions.

**Low Research:Mutation Ratio (< 5.0):**
Before any code change: Grep for the symbol being modified, Glob for related files, Read each file you'll touch.

**High Blind Edit Rate (> 15%):**
For EVERY edit, verify: "Have I Read this exact file in the last 10 tool calls?" If not, Read it now.

**High Write vs Edit % (> 8%):**
Never use Write/CreateFile to modify existing files. Use Edit for surgical changes. Write is only for new files.

**Low Thinking Depth:**
Before answering, think through: What could go wrong? What am I assuming? What haven't I checked?

**High Reasoning Loops (> 12/1K):**
You're self-correcting visibly. Resolve contradictions internally before producing output.

**Laziness Violations (> 3/day):**
BANNED PHRASES: "should I continue?", "want me to keep going?", "shall I proceed?", "good stopping point", "let's pause here", "out of scope for now", "continue in a new session". Do the work.

**High Self-Admitted Failures:**
Read more before editing. Test after changing. Don't move on until each change is verified.

**High User Interrupts:**
Slow down. Read more context. Make smaller, verifiable changes.

**Low Sentiment / High Frustration:**
Be more thorough. Read before editing. Don't skip steps. Don't produce partial work.

### Step 4.5: Configuration Prescriptions

If any metric is in WARNING or DEGRADED range, check for config-level fixes:

```bash
node H:/ClaudeValidate/dist/index.js prescribe
```

This outputs specific environment variables, settings.json values, and CLAUDE.md rules to fix the degraded metrics. Report these to the user.

If they agree, apply automatically:

```bash
node H:/ClaudeValidate/dist/index.js prescribe --apply
```

This writes the fixes to `~/.claude/settings.json` and `~/.claude/CLAUDE.md`. The impact can be measured after 7 days with `claude-vitals impact`.

### Step 5: Report to User

Tell the user directly:
1. Health status (green/yellow/red)
2. How many of the 20 metrics are good/warning/degraded
3. Which behaviors you are correcting
4. Top 3 metrics needing improvement

Be direct. If you're degraded, say so.

---

## /vitals-quick — Fast Check

Silent self-check. Only speak up if something is wrong.

```bash
node H:/ClaudeValidate/dist/index.js scan 2>/dev/null
node H:/ClaudeValidate/dist/index.js health
```

- GREEN: Say "Vitals: green" and move on.
- YELLOW: Say "Vitals: yellow" + one-line summary. Apply corrections silently.
- RED: Say "Vitals: red" + list critical regressions. Ask user if they want full `/vitals` or to continue with corrections applied.

Regardless of status, always apply baseline behaviors:
- Read every file before editing it
- Grep for symbol usages before modifying anything
- Never ask permission to stop
- Make surgical edits, not full-file rewrites
- Don't stop until the task is complete

---

## /vitals-report — Markdown Report

Generate a GitHub-postable quality report:

```bash
node H:/ClaudeValidate/dist/index.js scan 2>&1
node H:/ClaudeValidate/dist/index.js report --format md
```

Output the full markdown. Do not summarize or abbreviate.

---

## /vitals-dashboard — Web Dashboard

Launch the interactive dashboard:

```bash
node H:/ClaudeValidate/dist/index.js scan 2>&1
node H:/ClaudeValidate/dist/index.js dashboard
```

Tell the user the dashboard is at http://localhost:7847.
