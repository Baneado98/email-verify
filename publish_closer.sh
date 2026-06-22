#!/bin/bash
# Persistent, session-independent closer for the email-verify npm publish.
# Run periodically by a Windows Scheduled Task (MayordomoEmailVerifyPublish).
# On each run: if mailbox-verify-mcp@0.1.0 is not yet on npm, attempt publish.
# On success: dispatch the GH workflow (MCP Registry via OIDC) and delete the
# scheduled task (self-cleanup). On 429: log and exit 0 (next run retries).
# Never fails loudly; never spams Kiran.

set -a
source "C:/Users/Kiran/mayordomo/config/bill.env" 2>/dev/null
source "C:/Users/Kiran/mayordomo/config/deploy.env" 2>/dev/null
set +a

PROJ="C:/Users/Kiran/proyectos/email-verify"
LOG="$PROJ/publish_closer.log"
PKG="mailbox-verify-mcp"
VER="0.1.0"
TASK="MayordomoEmailVerifyPublish"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
cd "$PROJ" || exit 0

# Already published? -> finish + remove task.
if curl -sf "https://registry.npmjs.org/$PKG/$VER" >/dev/null 2>&1; then
  echo "[$(ts)] $PKG@$VER already on npm. Dispatching registry workflow + removing task." >> "$LOG"
  curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/Baneado98/email-verify/actions/workflows/publish-mcp.yml/dispatches" \
    -d '{"ref":"v0.1.0"}' >> "$LOG" 2>&1
  schtasks //Delete //TN "$TASK" //F >> "$LOG" 2>&1
  exit 0
fi

# Try to publish.
npm run build >/dev/null 2>&1
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
out=$(npm publish --access public 2>&1); code=$?
rm -f .npmrc

if [ $code -eq 0 ] || curl -sf "https://registry.npmjs.org/$PKG/$VER" >/dev/null 2>&1; then
  echo "[$(ts)] PUBLISHED $PKG@$VER. Dispatching registry workflow + removing task." >> "$LOG"
  curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/Baneado98/email-verify/actions/workflows/publish-mcp.yml/dispatches" \
    -d '{"ref":"v0.1.0"}' >> "$LOG" 2>&1
  schtasks //Delete //TN "$TASK" //F >> "$LOG" 2>&1
  exit 0
fi

if echo "$out" | grep -q "E429"; then
  echo "[$(ts)] still 429 rate-limited; will retry next run." >> "$LOG"
else
  echo "[$(ts)] publish failed (non-429): $(echo "$out" | tail -2)" >> "$LOG"
fi
exit 0
