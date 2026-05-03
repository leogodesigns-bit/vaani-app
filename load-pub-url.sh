#!/usr/bin/env bash
# Source this with: source ./load-pub-url.sh
export PUB_URL=$(railway variables --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['DATABASE_PUBLIC_URL'])" 2>/dev/null)
if [ -z "$PUB_URL" ]; then
  echo "❌ Failed to load PUB_URL — is railway CLI linked?"
  return 1
fi
echo "✅ PUB_URL loaded (length: ${#PUB_URL})"
