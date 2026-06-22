#!/bin/bash
# Persistent, session-independent closer for the email-verify Vercel redeploy +
# 402index domain verification. Run periodically by a Windows Scheduled Task
# (MayordomoEmailVerifyRedeploy). The live prod predates /openapi.json,
# /.well-known/x402 and the real 402index hash; one redeploy after the daily
# deploy-limit reset closes all three. On success: verify 402index + remove task.

set -a
source "C:/Users/Kiran/mayordomo/config/deploy.env" 2>/dev/null
source "C:/Users/Kiran/mayordomo/config/bill.env" 2>/dev/null
set +a

PROJ="C:/Users/Kiran/proyectos/email-verify"
LOG="$PROJ/redeploy_closer.log"
BASE="https://email-verify-seven.vercel.app"
TASK="MayordomoEmailVerifyRedeploy"
ts() { date '+%Y-%m-%d %H:%M:%S'; }
cd "$PROJ" || exit 0

# Already done? (openapi present AND verify file = real hash) -> finish.
OPENAPI=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/openapi.json")
VFILE=$(curl -s "$BASE/.well-known/402index-verify.txt")
if [ "$OPENAPI" = "200" ] && [ "$VFILE" = "$EMAILVERIFY_402INDEX_HASH" ]; then
  echo "[$(ts)] discovery routes live + hash served. Running 402index verify + removing task." >> "$LOG"
  printf '{"domain":"email-verify-seven.vercel.app","verification_token":"%s"}' "$EMAILVERIFY_402INDEX_TOKEN" > /tmp/ev_v402.json
  curl -s -X POST "https://402index.io/api/v1/claim/verify" -H "Content-Type: application/json" --data @/tmp/ev_v402.json >> "$LOG" 2>&1
  rm -f /tmp/ev_v402.json
  echo "" >> "$LOG"
  schtasks //Delete //TN "$TASK" //F >> "$LOG" 2>&1
  exit 0
fi

# Attempt a prod redeploy. If the daily limit is still exhausted, log + retry.
out=$(npx --yes vercel@latest deploy --prod --yes --scope baneado-s-projects --token "$VERCEL_TOKEN" 2>&1)
if echo "$out" | grep -qi "api-deployments-free-per-day"; then
  echo "[$(ts)] deploy limit still exhausted; will retry next run." >> "$LOG"
  exit 0
fi
if echo "$out" | grep -qiE "Production|Ready"; then
  echo "[$(ts)] redeploy triggered. Verifying on next run." >> "$LOG"
  sleep 12
  NOW_OPENAPI=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/openapi.json")
  NOW_VFILE=$(curl -s "$BASE/.well-known/402index-verify.txt")
  if [ "$NOW_OPENAPI" = "200" ] && [ "$NOW_VFILE" = "$EMAILVERIFY_402INDEX_HASH" ]; then
    echo "[$(ts)] discovery live. Running 402index verify + removing task." >> "$LOG"
    printf '{"domain":"email-verify-seven.vercel.app","verification_token":"%s"}' "$EMAILVERIFY_402INDEX_TOKEN" > /tmp/ev_v402.json
    curl -s -X POST "https://402index.io/api/v1/claim/verify" -H "Content-Type: application/json" --data @/tmp/ev_v402.json >> "$LOG" 2>&1
    rm -f /tmp/ev_v402.json
    echo "" >> "$LOG"
    schtasks //Delete //TN "$TASK" //F >> "$LOG" 2>&1
  fi
  exit 0
fi
echo "[$(ts)] redeploy unexpected output: $(echo "$out" | tail -2)" >> "$LOG"
exit 0
