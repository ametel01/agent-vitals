#!/usr/bin/env bash
#
# Auto-scan: run claude-vitals scan to capture session data before purge
# Set this up as a daily scheduled task / cron job
#
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

node "$PROJECT_DIR/dist/index.js" scan --db "$HOME/.claude-vitals/vitals.db" 2>/dev/null

# Log the run
echo "$(date -Iseconds) auto-scan complete" >> "$HOME/.claude-vitals/auto-scan.log"
