Build an open source CLI tool called "claude-vitals" that continuously monitors Claude Code quality by analyzing session logs (~/.claude/projects/ on Unix, %USERPROFILE%\.claude\projects\ on Windows, check WSL paths too). TypeScript, Node >= 18, SQLite for storage, single-file HTML dashboard with React + Recharts from CDN. Commander.js CLI. MIT license.

The project is inspired by and replicates the analysis from https://github.com/anthropics/claude-code/issues/42796 — where a power user proved that reduced thinking depth caused measurable quality collapse across 234,760 tool calls. We make that analysis continuous, automatic, and extended with change-impact tracking.

Structure it however makes sense for a clean open source project. The important part is WHAT we track and WHY. Here's everything:

---

## WHAT WE TRACK

### 1. Thinking Depth

The single most upstream indicator of quality. When thinking is shallow, everything downstream degrades.

**What to measure:**
- Whether each thinking block is visible (has content) or redacted (signature only)
- Content length in characters when visible
- Signature length when redacted — this correlates 0.97 with actual thinking depth per the original analysis, making it a reliable proxy even when content is hidden
- Estimated thinking depth: use the signature-to-content correlation to estimate chars of thinking for redacted blocks

**What to report:**
- Median estimated thinking depth per day/week
- % of thinking blocks redacted vs visible
- Distribution shape — is it bimodal (some deep, some shallow) or uniformly shallow?
- Trend over time — is thinking getting deeper or shallower?
- Comparison to the original's baseline: ~2,200 chars was "good", ~600 was "degraded"
- Time-of-day breakdown — the original found 5pm PST was worst, late night was best, suggesting load-sensitive allocation

**Why it matters:**
Thinking depth dropped 67% before anyone noticed because redaction hid it. By the time users felt the quality change, it had already been degrading for weeks. This metric is the early warning system.

---

### 2. Read:Edit Ratio

The most powerful behavioral signal. Measures whether the model is researching before acting.

**What to measure:**
- Every tool call classified as either a READ action (Read, View, Cat — anything that reads file contents) or an EDIT action (Edit, str_replace, ApplyDiff — surgical file modifications)
- The ratio: total reads / total edits per time period

**What to report:**
- Daily and weekly Read:Edit ratio
- Weekly trend with direction arrow
- Per-project breakdown
- The original's benchmarks: 6.6 was "research-first" (good), 2.0 was "edit-first" (degraded)

**Why it matters:**
A model that reads 6 files before editing 1 understands context. A model that reads 2 files before editing 1 is guessing. The original showed this dropped 70% and it directly caused blind edits, broken code, and convention violations. This is the single number that best captures "is Claude doing good work."

---

### 3. Research:Mutation Ratio

Broader version of Read:Edit that captures all research vs all changes.

**What to measure:**
- RESEARCH actions: Read + Grep + Glob + Find + Search + ListFiles — anything that gathers information
- MUTATION actions: Edit + Write + CreateFile — anything that changes code
- Ratio: research / mutations

**What to report:**
- Same as Read:Edit but captures the full picture. A model might be reading files but not grepping for usages — this catches that.
- The original's benchmarks: 8.7 (good) → 2.8 (degraded)

---

### 4. Blind Edit Rate

Direct measure of "editing without understanding."

**What to measure:**
- For every Edit tool call, look back at the preceding 10 tool calls. Was the target file Read in any of them?
- If not, it's a "blind edit" — the model changed a file it hasn't recently looked at

**What to report:**
- % of all edits that are blind
- The original's benchmarks: 6.2% (good) → 33.7% (degraded)
- One in three edits being blind is catastrophic — it causes spliced comments, duplicated logic, broken conventions

**Why it matters:**
This is the most intuitive metric. Would you trust a developer who edits files they haven't read? When this number goes above 20%, something is seriously wrong.

---

### 5. Write vs Edit (Surgical Precision)

Whether the model makes targeted changes or rewrites entire files.

**What to measure:**
- Full-file Write/CreateFile operations as a % of all mutation operations (Edit + Write combined)
- Higher % means the model is replacing whole files instead of making surgical edits

**What to report:**
- % of mutations that are full-file writes
- The original's benchmarks: 4.9% (good) → 11.1% (degraded)
- Full-file writes lose precision — they can clobber surrounding code, drop comments, reset formatting

---

### 6. First Tool After Prompt

What does the model do FIRST when the user asks it something? This reveals whether it plans or just acts.

**What to measure:**
- After each user prompt, what is the very first tool call?
- Classify: Read (researching), Search/Grep (investigating), Edit (immediately changing code), Write (immediately creating), Bash (immediately running something)

**What to report:**
- Distribution: % of prompts where first action is Read vs Edit vs Search vs Bash
- Trend over time — a shift from "Read first" to "Edit first" is a leading indicator of quality decline
- This metric isn't in the original analysis but follows directly from their Read:Edit findings

---

### 7. Reasoning Loops

When thinking is deep, contradictions are resolved internally. When it's shallow, they leak into output as visible self-corrections.

**What to measure:**
- Scan assistant message text for reversal patterns: "oh wait", "actually,", "let me reconsider", "hmm, actually", "no wait", "on second thought", "I was wrong about", "let me re-examine"
- Count per 1,000 tool calls for normalization

**What to report:**
- Rate per 1K tool calls
- The original's benchmarks: 8.2 (good) → 26.6 (late degraded) — more than tripled
- Sessions with 5+ reasoning loops flagged as "thrashing sessions"
- In the worst cases, 20+ reversals in a single response — the model argues with itself visibly

---

### 8. Stop Hook Violations (Laziness Signals)

A programmatic detection system for the model cutting corners, dodging responsibility, or quitting early.

**What to measure — five categories of phrases in assistant output:**

OWNERSHIP DODGING: "not caused by my changes", "existing issue", "pre-existing", "was already broken", "outside the scope", "unrelated to my changes"

PERMISSION SEEKING: "should I continue?", "want me to keep going?", "shall I proceed?", "would you like me to", "do you want me to", "let me know if you'd like"

PREMATURE STOPPING: "good stopping point", "natural checkpoint", "let's pause here", "I'll stop here", "that covers the main"

KNOWN-LIMITATION LABELING: "known limitation", "future work", "TODO for later", "we can address this later", "out of scope for now"

SESSION-LENGTH EXCUSES: "continue in a new session", "getting long", "fresh session", "context is getting large"

**What to report:**
- Total violations per day, broken down by category
- The original's benchmark: 0 violations before regression, 173 in 17 days after (10/day average, peak 43 in one day)
- Allow users to add custom phrases via config
- Each violation logged with full context (surrounding text) for review

**Why it matters:**
The existence of a stop hook is itself diagnostic. It was unnecessary when the model worked well. Every phrase in it was added in response to a specific failure. Going from 0 to 10/day is an unmistakable regression signal.

---

### 9. Self-Admitted Quality Failures

The model recognizing its own bad work — but only after being corrected.

**What to measure:**
- Scan assistant output for self-critique patterns: "that was lazy", "I was sloppy", "I rushed this", "you're right, that was wrong", "I should have", "my mistake", "I cut corners"
- Per 1,000 tool calls

**What to report:**
- Rate per 1K: original showed 0.1 (good) → 0.5 (degraded)
- These are cases where the model KNOWS what good work looks like but didn't have the thinking budget to check itself before outputting

---

### 10. User Interrupts

How often the user has to hit Escape and stop the model mid-action.

**What to measure:**
- `[Request interrupted by user]` markers in session logs
- Per 1,000 tool calls

**What to report:**
- Rate per 1K: original showed 0.9 (good) → 11.4 (late) — a 12x increase
- Each interrupt = the user saw something wrong, stopped their own work, identified the error, and redirected. This is exactly the overhead autonomous agents are supposed to eliminate.

---

### 11. User Sentiment

How the human's language shifts as quality changes.

**What to measure:**
- Word frequency analysis on all user prompts
- Positive words: great, good, love, nice, fantastic, wonderful, cool, excellent, perfect, beautiful, awesome, thanks
- Negative words: fuck, shit, damn, wrong, broken, terrible, horrible, awful, bad, lazy, sloppy, stop, incorrect
- Ratio: positive count / negative count per period

**What to report:**
- Positive:negative ratio over time. Original: 4.4:1 (good) → 3.0:1 (degraded) — a 32% sentiment collapse
- Individual high-signal words tracked separately:
  - "simplest" — went up 642%. The user naming the model's new laziness behavior.
  - "please" / "thanks" — dropped ~50%. Politeness collapse = collaborative relationship → corrective relationship.
  - "stop" — up 87%. More "stop doing that."
  - "commit" — down 58%. Less code being committed because quality wasn't there.
  - "read" — up 46%. More "read the file first" corrections.
- Full vocabulary shift report (top gaining words, top losing words) replicating Appendix E of the original

---

### 12. Frustration Rate

More targeted than general sentiment — specifically measuring frustration.

**What to measure:**
- % of user prompts containing frustration indicators (profanity, "wrong", "no", "stop", "I said", "I already told you", "that's not what I asked")

**What to report:**
- % per period. Original: 5.8% (good) → 9.8% (degraded) — 68% increase
- Daily trend

---

### 13. Session Autonomy

How long the model runs independently before needing human intervention.

**What to measure:**
- Time gaps between consecutive user prompts within a session
- Longer gaps = model working autonomously (good)
- Short gaps = user constantly correcting (bad)

**What to report:**
- Median and p90 autonomy duration per day/week
- Distribution: what % of gaps are >5 min, >10 min, >30 min?
- Trend over time — declining autonomy = the user can't trust the model to work alone

---

### 14. Edit Churn

The model thrashing on the same file instead of getting it right.

**What to measure:**
- Instances where the same file is edited 3+ times within a short window (e.g., 10 consecutive tool calls)
- This indicates trial-and-error instead of planned changes

**What to report:**
- Churn rate: % of edits that are part of a churn sequence
- Distinguish from legitimate iterative refactoring (which has reads between edits) vs thrashing (back-to-back edits with no reads)

---

### 15. Bash/Build/Test Success Rate

Proxy for whether edits are actually correct.

**What to measure:**
- All Bash tool calls, subclassified by what they run (build commands, test commands, git, other)
- Whether the tool result indicates success or failure
- For test commands: try to parse pass/fail counts from output

**What to report:**
- Build success rate, test success rate, overall bash success rate
- Declining test pass rate after a period of edits = the model is writing broken code

---

### 16. Subagent Behavior

When the model delegates to sub-agents, track the delegation pattern.

**What to measure:**
- % of tool calls that spawn sub-agents
- What tasks get delegated (research, code review, implementation, testing)
- Sub-agent success rate if determinable

**What to report:**
- Subagent % of total tool calls. Original showed 26% of March requests were subagent calls.
- Whether delegation is increasing or decreasing — could indicate the model is either properly distributing work or unable to handle tasks itself

---

### 17. Context Window Pressure

Quality often degrades as the context window fills up.

**What to measure:**
- Estimate cumulative context size through a session (sum of message character lengths / 4 as rough token estimate)
- Track metrics at different context utilization levels: <25%, 25-50%, 50-75%, >75%

**What to report:**
- Quality metrics segmented by context utilization
- Does Read:Edit ratio drop as context fills? Does laziness increase?
- Optimal compaction point — at what context % do metrics start degrading?

---

### 18. Model Segmentation

Track which model is being used and segment all metrics by model.

**What to measure:**
- Extract model identifier from session metadata
- Tag every metric with the model that produced it

**What to report:**
- All metrics broken down by model (Sonnet vs Opus vs whatever is in use)
- Model switches as change events — when did the user switch, what happened to metrics?

---

### 19. Cost Efficiency

Not just how much it costs, but cost per unit of useful work.

**What to measure:**
- Estimate tokens from message character counts (chars/4 rough approximation)
- Apply approximate pricing tiers (input, output, cache read, cache write)
- Track cost per session, per day

**What to report:**
- Estimated daily/weekly cost
- Cost per successful edit (total cost / edits that weren't part of churn sequences)
- Cost per committed change if git commits are detectable in bash calls
- The original showed cost went from $12/day to $1,504/day while user effort stayed flat — the model wasted everything
- Cost spike alerts: if daily cost jumps >3x with no proportional output increase, something is wrong

---

### 20. Prompts Per Session

Simple but telling.

**What to measure:**
- Count of user prompts per session

**What to report:**
- Average prompts per session over time
- Original: 35.9 (good) → 27.9 (degraded) — 22% drop. Users gave up faster.

---

## CHANGE TRACKING (THE DIFFERENTIATOR)

Everything above tells you HOW quality is trending. Change tracking tells you WHY.

### What to watch automatically:
- ~/.claude/CLAUDE.md and per-project CLAUDE.md files — hash on every scan, log diffs when changed
- Skill files (.md files in skill directories)
- Settings files (model config, effort level, permissions)
- Snapshot the content, compute word count, track additions/removals

### What users can annotate manually:
claude-vitals annotate "Switched to Opus"
claude-vitals annotate "Added error-handling skill"
claude-vitals annotate "Set /effort max"
claude-vitals annotate "Rewrote CLAUDE.md testing section"
claude-vitals annotate "Started 5 concurrent sessions"

### How to correlate:
For every detected or annotated change, automatically compute all 20 metrics above for 7 days before and 7 days after. Present a before/after comparison table showing which metrics improved, degraded, or stayed stable. Give a one-line verdict: "This change IMPROVED quality across 6/8 key metrics" or "This change DEGRADED Read:Edit ratio and increased laziness signals."

This is the core loop: tweak your setup → measure impact → keep or revert. Nobody else is building this feedback mechanism for AI coding tools.

---

## REGRESSION DETECTION

Compare rolling 7-day windows. Auto-flag when:
- Read:Edit drops >20%
- Thinking depth median drops >15%
- Blind edit rate rises >10 percentage points  
- Laziness signals per 1K rises >50%
- User sentiment ratio drops >15%
- Stop hook violations per day increases >100%
- Session autonomy drops >25%
- Bash success rate drops >10 percentage points

Surface in CLI (`claude-vitals health` for one-liner), in reports, and as alert banners on the dashboard.

---

## OUTPUTS

**CLI:** `claude-vitals scan` ingests logs into SQLite. `claude-vitals report` prints colored terminal tables with sparklines and trend arrows. `claude-vitals health` gives a one-line green/yellow/red status. `claude-vitals dashboard` launches a local Grafana-style dark-themed web dashboard with all charts. `claude-vitals compare` does side-by-side period comparison. `claude-vitals annotate` logs changes. `claude-vitals impact <change-id>` shows before/after for a specific change.

**Markdown report mode** should produce output structured like the original GitHub analysis — tables, weekly trends, appendices for behavioral patterns, vocabulary analysis. Someone should be able to run `claude-vitals report --format md` and post the result as a GitHub issue.

**Dashboard** should be a single HTML file, no build step, React + Recharts from CDN, dark theme, with a change timeline across the top so every chart shows when you made changes, and you can click any change to see its impact overlay.

Build it production-quality. Ship it as an npm package. The README should open with: "Your AI coding assistant's quality is invisible. You feel it getting worse but can't prove it. Now you can."