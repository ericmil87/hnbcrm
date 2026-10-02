#!/usr/bin/env bash
# Verify HNBCRM API connectivity
# Usage: HNBCRM_API_URL=... HNBCRM_API_KEY=... bash verify-connection.sh

set -euo pipefail

if [ -z "${HNBCRM_API_URL:-}" ] || [ -z "${HNBCRM_API_KEY:-}" ]; then
  echo "Error: HNBCRM_API_URL and HNBCRM_API_KEY must be set"
  echo "Usage: HNBCRM_API_URL=https://SEU-DEPLOYMENT.convex.site HNBCRM_API_KEY=your-key bash $0"
  exit 1
fi

echo "Connecting to: $HNBCRM_API_URL"
echo ""

response=$(curl -s -w "\n%{http_code}" \
  -H "X-API-Key: $HNBCRM_API_KEY" \
  "$HNBCRM_API_URL/api/v1/team-members")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
  echo "Connected successfully!"
  echo ""
  echo "Team members:"
  echo "$body" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('members', []):
    status = m.get('status', '?')
    mtype = m.get('type', '?')
    role = m.get('role', '?')
    name = m.get('name', 'Unknown')
    print(f'  - {name} ({mtype}/{role}) [{status}]')
" 2>/dev/null || echo "$body"
else
  echo "Connection failed (HTTP $http_code)"
  echo "$body"
  exit 1
fi
