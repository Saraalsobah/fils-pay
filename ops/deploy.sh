#!/usr/bin/env bash
# Deploy / redeploy FilsPay on the Dilmune server (run ON the server, as root or with sudo).
#
#   First time:   curl -fsSL https://raw.githubusercontent.com/Saraalsobah/fils-pay/main/ops/deploy.sh | sudo bash
#   Redeploy:     cd /opt/filspay && sudo ./ops/deploy.sh      (pulls latest main, rebuilds, restarts)
#
# Safe to re-run. It never prints or commits secrets; ops/.env.prod is created once with fresh
# random values and kept (git-ignored).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Saraalsobah/fils-pay.git}"
APP_DIR="${APP_DIR:-/opt/filspay}"
PUBLIC_IP="${PUBLIC_IP:-165.232.189.108}"
COMPOSE=(docker compose -f ops/docker-compose.prod.yml --env-file ops/.env.prod)

echo "==> 1/6 system packages (docker, git) and swap"
if ! command -v git >/dev/null 2>&1; then apt-get update -y && apt-get install -y git curl; fi
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
if ! swapon --show | grep -q .; then
  # The box has 2 GB RAM; image builds (tsc/vite/go) spike, so give it swap.
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> 2/6 code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

echo "==> 3/6 secrets (ops/.env.prod, created once)"
if [ ! -f ops/.env.prod ]; then
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  umask 077
  cat > ops/.env.prod <<ENV
DOMAIN=${DOMAIN}
POSTGRES_PASSWORD=$(openssl rand -hex 24)
SETTLEMENT_INTERNAL_TOKEN=$(openssl rand -hex 32)
INTERNAL_API_TOKEN=$(openssl rand -hex 32)
ACQUIRER_CALLBACK_SIGNING_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -base64 32)
ENV
  echo "created ops/.env.prod"
fi
DOMAIN="$(grep '^DOMAIN=' ops/.env.prod | cut -d= -f2)"

echo "==> 4/6 build and start (first build takes a few minutes)"
"${COMPOSE[@]}" up -d --build </dev/null

echo "==> 5/6 seed demo data (only if the database is empty)"
COUNT="$("${COMPOSE[@]}" exec -T postgres psql -U filspay -d filspay -tAc "select count(*) from merchants" 2>/dev/null || echo 0)"
if [ "${COUNT:-0}" = "0" ]; then
  # </dev/null: when this script is piped from curl, docker would otherwise read the rest of
  # the script from stdin and the script would silently stop here.
  "${COMPOSE[@]}" --profile seed run --rm seed </dev/null
else
  echo "database already has $COUNT merchants; not reseeding (seeding truncates tables)"
fi

echo "==> 6/6 health"
for i in $(seq 1 30); do
  if curl -fsS "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
    echo "OK: https://${DOMAIN}/healthz"; break
  fi
  sleep 5
done
"${COMPOSE[@]}" ps </dev/null
echo
echo "Merchant dashboard: https://${DOMAIN}/dashboard/login"
echo "Admin console:      https://admin.${DOMAIN}"
