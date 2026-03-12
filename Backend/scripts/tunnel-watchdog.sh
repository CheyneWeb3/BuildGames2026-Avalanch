#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/hausCashier/services/tunnel/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

OUT_FILE="${TUNNEL_URL_FILE:-/opt/hausCashier/.tunnel_url}"
LOCAL_HEALTH="${LOCAL_HEALTH:-http://127.0.0.1:8088/health}"
TUNNEL_PM2_NAME="${TUNNEL_PM2_NAME:-haus-tunnel}"

echo "[watchdog] monitoring url file=$OUT_FILE process=$TUNNEL_PM2_NAME"

while true; do
  # if core-api isn't healthy locally, restarting tunnel is pointless
  if ! curl -fsS --max-time 3 "$LOCAL_HEALTH" >/dev/null 2>&1; then
    sleep 5
    continue
  fi

  url=""
  if [[ -f "$OUT_FILE" ]]; then url="$(cat "$OUT_FILE" || true)"; fi

  if [[ -n "$url" ]]; then
    if ! curl -fsS --max-time 6 "$url/health" >/dev/null 2>&1; then
      echo "[watchdog] public health failed; restarting $TUNNEL_PM2_NAME"
      pm2 restart "$TUNNEL_PM2_NAME" || true
      sleep 6
    fi
  fi

  sleep 10
done
