#!/usr/bin/env bash
set -euo pipefail

ORIGIN_URL="${ORIGIN_URL:-http://127.0.0.1:8088}"
OUT_FILE="${OUT_FILE:-/opt/hausCashier/.tunnel_url}"
CLOUDFLARED="/usr/local/bin/cloudflared"

echo "[tunnel] starting quick tunnel -> ${ORIGIN_URL}"

backoff=60
max_backoff=3600

while true; do
  LOG="$(mktemp)"
  set +e
  "${CLOUDFLARED}" tunnel --url "${ORIGIN_URL}" --no-autoupdate 2>&1 | tee "${LOG}"
  code=${PIPESTATUS[0]}
  set -e

  url="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "${LOG}" | head -n1 || true)"
  if [[ -n "${url}" ]]; then
    echo "${url}" > "${OUT_FILE}"
    chmod 644 "${OUT_FILE}" || true
    echo "[tunnel] url saved -> ${url}"
    backoff=60
  else
    echo "[tunnel] no url captured"
  fi

  # If Cloudflare rate-limited us, back off HARD.
  if grep -qE 'status_code="429|error code: 1015|Too Many Requests' "${LOG}"; then
    backoff=900   # 15 minutes
    echo "[tunnel] rate-limited (429/1015). backing off to ${backoff}s"
  fi

  rm -f "${LOG}" || true

  echo "[tunnel] cloudflared exited (code=${code}). sleeping ${backoff}s before retry..."
  sleep "${backoff}"
  backoff=$(( backoff * 2 ))
  if (( backoff > max_backoff )); then backoff="${max_backoff}"; fi
done
