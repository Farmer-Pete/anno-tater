#!/bin/sh
# A Claude Code PreToolUse hook on Bash. Blocks git commands that skip the pre-commit checks
# (--no-verify, or -n among commit's short flags) or point git at other hooks (core.hooksPath).
command=$(jq -r '.tool_input.command // ""')
if printf '%s' "$command" | grep -qE -e '--no-verify|core\.hooksPath' \
  || printf '%s' "$command" | grep -qE -e 'git( +-[^ ]+)* +commit\b.* -[a-zA-Z]*n[a-zA-Z]*( |$)'; then
  echo "The pre-commit checks can't be skipped in this repo. Fix what they report instead." >&2
  exit 2
fi
