#!/bin/bash
# Retry npm publish until the 429 rate-limit clears, then trigger the GH workflow
# (which re-publishes idempotently and registers in the MCP Registry via OIDC).
set -a
source "C:/Users/Kiran/mayordomo/config/bill.env" 2>/dev/null
source "C:/Users/Kiran/mayordomo/config/deploy.env" 2>/dev/null
set +a
cd "C:/Users/Kiran/proyectos/email-verify"

published=0
for i in $(seq 1 20); do
  # already on registry?
  code=$(curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/mailbox-verify-mcp)
  if [ "$code" = "200" ]; then echo "[try $i] mailbox-verify-mcp now on npm (200)"; published=1; break; fi

  echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc
  out=$(npm publish --access public 2>&1)
  rm -f .npmrc
  if echo "$out" | grep -q "E429"; then
    echo "[try $i] still 429 rate-limited; backing off 600s"
    sleep 600
    continue
  fi
  if echo "$out" | grep -qiE "\+ mailbox-verify-mcp@0.1.0|npm notice Publishing"; then
    # verify
    sleep 5
    code=$(curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/mailbox-verify-mcp)
    echo "[try $i] publish attempt done; registry HTTP $code"
    if [ "$code" = "200" ]; then published=1; break; fi
  fi
  echo "[try $i] unexpected output: $(echo "$out" | tail -2)"
  sleep 300
done

if [ "$published" = "1" ]; then
  ver=$(curl -s https://registry.npmjs.org/mailbox-verify-mcp/latest | python -c "import sys,json;print(json.load(sys.stdin).get('version'))" 2>/dev/null)
  echo "[ok] npm mailbox-verify-mcp@${ver} PUBLISHED"
  echo "[ok] dispatching workflow for MCP Registry (OIDC) step..."
  curl -s -X POST -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/Baneado98/email-verify/actions/workflows/publish-mcp.yml/dispatches" \
    -d '{"ref":"v0.1.0"}' -w "dispatch HTTP %{http_code}\n"
  sleep 90
  echo "[ok] MCP Registry check:"
  curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=email-verify" | head -c 400
else
  echo "[FAIL] still not published after retries; npm rate-limit persists. Re-run _publish_retry.sh later."
fi
echo "[DONE]"
