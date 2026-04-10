#!/usr/bin/env bash
#
# Install claude-vitals skills into ~/.claude/commands/
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMMANDS_DIR="$HOME/.claude/commands"

echo "Installing claude-vitals skills..."

# Build the project first
echo "  Building TypeScript..."
cd "$PROJECT_DIR"
npm install --silent 2>/dev/null
npm run build --silent 2>/dev/null

# Create commands directory
mkdir -p "$COMMANDS_DIR"

# Resolve the absolute path to dist/index.js
VITALS_BIN="$(cd "$PROJECT_DIR" && pwd)/dist/index.js"

# Generate skill files with the correct absolute path
cat > "$COMMANDS_DIR/vitals.md" << SKILLEOF
# Self-Quality Verification

Run a full diagnostic using claude-vitals.

\`\`\`bash
node $VITALS_BIN scan
\`\`\`

\`\`\`bash
node $VITALS_BIN health
\`\`\`

If GREEN — report "Vitals: green" and stop.
If YELLOW or RED — run the full report:

\`\`\`bash
node $VITALS_BIN report
\`\`\`

Then follow the behavioral corrections in SKILL.md at $PROJECT_DIR/SKILL.md
SKILLEOF

cat > "$COMMANDS_DIR/vitals-quick.md" << SKILLEOF
# Quick Vitals Check

\`\`\`bash
node $VITALS_BIN scan 2>/dev/null
node $VITALS_BIN health
\`\`\`

GREEN: Say "Vitals: green" and continue.
YELLOW: Say "Vitals: yellow" + one-line summary.
RED: Say "Vitals: red" + list critical regressions.

Always: read before editing, grep before modifying, surgical edits only, no permission-seeking phrases.
SKILLEOF

cat > "$COMMANDS_DIR/vitals-report.md" << SKILLEOF
# Quality Report

\`\`\`bash
node $VITALS_BIN scan 2>&1
node $VITALS_BIN report --format md
\`\`\`

Output the full markdown report. Do not summarize.
SKILLEOF

cat > "$COMMANDS_DIR/vitals-dashboard.md" << SKILLEOF
# Quality Dashboard

\`\`\`bash
node $VITALS_BIN scan 2>&1
node $VITALS_BIN dashboard
\`\`\`

Dashboard runs at http://localhost:7847.
SKILLEOF

echo ""
echo "  Installed 4 skills:"
echo "    /vitals           — Full diagnostic with corrections"
echo "    /vitals-quick     — Fast health check"
echo "    /vitals-report    — GitHub-postable markdown report"
echo "    /vitals-dashboard — Web dashboard"
echo ""
echo "  Skills point to: $VITALS_BIN"
echo ""
echo "Done. Type /vitals in any Claude Code session to self-check."
