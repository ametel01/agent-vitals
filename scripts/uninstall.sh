#!/usr/bin/env bash
#
# Remove agent-vitals skills from ~/.claude/commands/
#
set -euo pipefail

COMMANDS_DIR="$HOME/.claude/commands"

echo "Removing agent-vitals skills..."

for f in vitals.md vitals-quick.md vitals-report.md vitals-dashboard.md vitals-prescribe.md; do
  if [ -f "$COMMANDS_DIR/$f" ]; then
    rm "$COMMANDS_DIR/$f"
    echo "  Removed $f"
  fi
done

echo "Done."
