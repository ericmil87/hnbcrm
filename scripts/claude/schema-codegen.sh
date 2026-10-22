#!/bin/bash


cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 0
# Run Convex codegen after schema changes
# Usage: scripts/claude/schema-codegen.sh

echo "🔄 Running Convex codegen..."

if [ -f "package.json" ] && grep -q "\"convex\":" package.json; then
  npx convex codegen --dev
  echo "✅ Convex codegen complete"
else
  echo "⚠️  Not a Convex project (no convex dependency found)"
fi

exit 0
