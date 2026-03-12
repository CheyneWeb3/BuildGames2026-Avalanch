#!/usr/bin/env bash
set -euo pipefail

API="http://127.0.0.1:8088"
TO_WALLET="0xB1447E259986Aa4DE0CAB6413DD207B8b993346c"

KEY="$(grep -E '^FEE_PAYOUT_ADMIN_KEY=' /opt/hausCashier/services/core-api/.env | tail -n1 | cut -d= -f2- | tr -d '\r')"
if [ -z "${KEY}" ]; then
  echo "Missing FEE_PAYOUT_ADMIN_KEY in /opt/hausCashier/services/core-api/.env"
  exit 1
fi

RUN_ID="$(date +%Y%m%d)"   # idempotent per-day

curl -sS -X POST "${API}/admin/fees/payout/run" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: ${KEY}" \
  -d "{\"toWallet\":\"${TO_WALLET}\",\"runId\":\"daily-${RUN_ID}\"}" | jq .
