#!/bin/bash

# Validate Convex function has proper args and returns validators
# Usage: scripts/claude/validate-convex-function.sh <file-path>

FILE="$1"
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 0
[ -f "$FILE" ] || exit 0

if [[ ! "$FILE" =~ convex/.*\.(ts|js)$ ]]; then
  exit 0
fi

# Skip non-function files
if [[ "$FILE" =~ (schema\.ts|_generated/.*) ]]; then
  exit 0
fi

# Check for query/mutation/action exports
if ! grep -q "export const.*\(query\|mutation\|action\)({" "$FILE"; then
  exit 0
fi

# Look for functions without args validator
FUNCTIONS_WITHOUT_ARGS=$(grep -n "export const.*\(query\|mutation\|action\)({" "$FILE" | while read -r line; do
  LINE_NUM=$(echo "$line" | cut -d: -f1)
  NEXT_10_LINES=$(tail -n +$LINE_NUM "$FILE" | head -20)

  if ! echo "$NEXT_10_LINES" | grep -q "args:"; then
    FUNC_NAME=$(echo "$line" | sed 's/.*export const \([a-zA-Z0-9_]*\).*/\1/')
    echo "$FILE:$LINE_NUM: Function '$FUNC_NAME' missing 'args' validator"
  fi
done)

# Look for functions without returns validator
FUNCTIONS_WITHOUT_RETURNS=$(grep -n "export const.*\(query\|mutation\|action\)({" "$FILE" | while read -r line; do
  LINE_NUM=$(echo "$line" | cut -d: -f1)
  NEXT_10_LINES=$(tail -n +$LINE_NUM "$FILE" | head -20)

  if ! echo "$NEXT_10_LINES" | grep -q "returns:"; then
    FUNC_NAME=$(echo "$line" | sed 's/.*export const \([a-zA-Z0-9_]*\).*/\1/')
    echo "$FILE:$LINE_NUM: Function '$FUNC_NAME' missing 'returns' validator"
  fi
done)

if [ -n "$FUNCTIONS_WITHOUT_ARGS" ] || [ -n "$FUNCTIONS_WITHOUT_RETURNS" ]; then
  echo "⚠️  Convex Validation Warnings:"
  [ -n "$FUNCTIONS_WITHOUT_ARGS" ] && echo "$FUNCTIONS_WITHOUT_ARGS"
  [ -n "$FUNCTIONS_WITHOUT_RETURNS" ] && echo "$FUNCTIONS_WITHOUT_RETURNS"
  echo ""
  echo "All public Convex functions should have 'args' and 'returns' validators."
  echo "Example:"
  echo "  export const myFunc = query({"
  echo "    args: { id: v.id(\"table\") },"
  echo "    returns: v.string(),"
  echo "    handler: async (ctx, args) => { ... }"
  echo "  });"
fi

exit 0
