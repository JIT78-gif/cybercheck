#!/usr/bin/env bash
# Install or update cybercheck on one Ubuntu 24.04 server (AWS Lightsail or EC2).
#
# Run from the cloned repository:   sudo bash deploy/aws/setup.sh
# Run it again later to deploy the latest code (it pulls, rebuilds and restarts).
#
# Everything runs on this one server: Postgres, the API, the worker and the web app, with Caddy
# in front for HTTPS. Projects under test never run here: they run in Nebius sandboxes.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash deploy/aws/setup.sh"; exit 1; fi

APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_USER="${SUDO_USER:-ubuntu}"
ENV_FILE="$APP_DIR/.env"
DB_PASS_FILE=/etc/cybercheck-db-pass

PUBLIC_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
# A free hostname that points at this server's IP, so Caddy can get an HTTPS certificate without buying a domain.
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
SITE_URL="https://$DOMAIN"

echo "==> cybercheck in $APP_DIR, running as $APP_USER, public address $SITE_URL"

# ---- swap: the Next.js build needs more memory than a small server has
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---- system packages: Node 24, Postgres, Caddy
apt-get update
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git postgresql
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

# ---- database (local Postgres; the password is generated once and kept)
[ -f "$DB_PASS_FILE" ] || { openssl rand -hex 24 > "$DB_PASS_FILE"; chmod 600 "$DB_PASS_FILE"; }
DB_PASS="$(cat "$DB_PASS_FILE")"
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname = 'cybercheck'" | grep -q 1 \
  || sudo -u postgres psql -c "create role cybercheck login password '$DB_PASS'"
sudo -u postgres psql -tAc "select 1 from pg_database where datname = 'cybercheck'" | grep -q 1 \
  || sudo -u postgres createdb -O cybercheck cybercheck

# ---- settings: the .env is copied from your laptop; the server-specific lines are set here
if [ ! -f "$ENV_FILE" ]; then
  echo
  echo "No $ENV_FILE yet. Create it with your laptop's .env content:"
  echo "  nano $ENV_FILE      (paste, then Ctrl+O, Enter, Ctrl+X)"
  echo "Then run this script again."
  exit 1
fi
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
sed -i 's/\r$//' "$ENV_FILE" # a .env pasted from Windows may carry CRLF line endings
set_env DATABASE_URL "postgres://cybercheck:$DB_PASS@127.0.0.1:5432/cybercheck"
set_env BETTER_AUTH_URL "$SITE_URL"
set_env WEB_ORIGIN "$SITE_URL"
set_env API_PORT 4000
set_env API_INTERNAL_URL http://127.0.0.1:4000
chown "$APP_USER": "$ENV_FILE" && chmod 600 "$ENV_FILE"

# ---- code: pull the latest, install, build the web app
cd "$APP_DIR"
sudo -u "$APP_USER" git pull --ff-only || echo "(git pull skipped: deploying the code already here)"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" npm run build -w @cybercheck/web
# next build can exit 0 without building (for example when it refuses a version with a known vulnerability)
[ -f apps/web/.next/BUILD_ID ] || { echo "The web build produced no output. Read the build messages above."; exit 1; }

# ---- services: start on boot, restart on crash
NPM="$(command -v npm)"
unit() { # name, description, working dir, start command, extra [Service] lines
  cat > "/etc/systemd/system/cybercheck-$1.service" <<EOF
[Unit]
Description=$2
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$3
$5
ExecStart=$NPM run $4
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}
unit api "cybercheck API" "$APP_DIR/apps/api" start "ExecStartPre=$NPM run db:migrate"
unit worker "cybercheck worker" "$APP_DIR/apps/api" worker:start ""
unit web "cybercheck web" "$APP_DIR/apps/web" start "Environment=PORT=3000"

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:3000
}
EOF

systemctl daemon-reload
systemctl enable postgresql caddy cybercheck-api cybercheck-worker cybercheck-web
systemctl restart cybercheck-api cybercheck-worker cybercheck-web caddy

echo
echo "==> Done. Open $SITE_URL (the HTTPS certificate can take a minute the first time)."
echo "    Logs: journalctl -u cybercheck-api -f   (or -worker, -web, caddy)"
