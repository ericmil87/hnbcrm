#!/bin/bash
# SessionStart hook: injects git branch and Convex target into context.
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || true
branch=$(git branch --show-current 2>/dev/null)
target=none
if [ -f .env.local ]; then
  t=$(grep -E '^CONVEX_DEPLOYMENT=' .env.local | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//; s/^["'"'"']//; s/["'"'"']$//')
  [ -n "$t" ] && target="$t"
fi
msg="Git branch: ${branch:-detached}. Convex target from .env.local: ${target}. Prod is careful-anaconda-127 and is only reached with --prod / npm run deploy:prod."
command -v jq >/dev/null 2>&1 || { printf '%s\n' "$msg"; exit 0; }
jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}'
