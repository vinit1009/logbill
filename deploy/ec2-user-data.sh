#!/bin/bash
# Sets up the Logbill demo on Amazon Linux 2023 (arm64): Node 22, the app from GitHub, Caddy for HTTPS.
# Secrets come from SSM Parameter Store (/logbill/*) through the instance role, never from this script.
set -euxo pipefail
exec > >(tee -a /var/log/logbill-setup.log) 2>&1
HOST="__HOST__"
REGION="us-east-1"

dnf install -y git tar xz
if [ ! -f /swapfile ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

# Node 22 (official build, checksum verified)
cd /tmp
F=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-arm64.tar.xz$/{print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/$F"
curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep " $F\$" | sha256sum -c -
tar -xJf "$F" -C /usr/local --strip-components=1
node -v

# Caddy (official release, checksum verified)
TAG=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -1)
curl -fsSLO "https://github.com/caddyserver/caddy/releases/download/v${TAG}/caddy_${TAG}_linux_arm64.tar.gz"
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${TAG}/caddy_${TAG}_checksums.txt" | grep "caddy_${TAG}_linux_arm64.tar.gz" | sha512sum -c -
tar -xzf "caddy_${TAG}_linux_arm64.tar.gz" -C /usr/local/bin caddy
caddy version

# The app
id logbill >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/logbill logbill
id caddy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/caddy caddy
[ -d /opt/logbill ] || git clone --depth 1 https://github.com/vinit1009/logbill /opt/logbill
chown -R logbill:logbill /opt/logbill
sudo -u logbill bash -c 'cd /opt/logbill && npm ci --include=dev --no-audit --no-fund && npm run build'

set +x  # keep the secrets out of the logs
get() { aws ssm get-parameter --region "$REGION" --with-decryption --name "/logbill/$1" --query Parameter.Value --output text; }
umask 077
cat > /etc/logbill.env <<ENV
NODE_ENV=production
PORT=8787
DATA_DIR=/var/lib/logbill
PAYPAL_CLIENT_ID=$(get PAYPAL_CLIENT_ID)
PAYPAL_CLIENT_SECRET=$(get PAYPAL_CLIENT_SECRET)
PAYPAL_INVOICER_EMAIL=sb-zyvft53804461@business.example.com
AI_API_KEY=$(get AI_API_KEY)
AI_DAILY_LIMIT=150
ENV
chown root:logbill /etc/logbill.env && chmod 640 /etc/logbill.env
umask 022
set -x

cat > /etc/systemd/system/logbill.service <<'UNIT'
[Unit]
Description=Logbill demo
After=network-online.target
Wants=network-online.target
[Service]
User=logbill
WorkingDirectory=/opt/logbill
EnvironmentFile=/etc/logbill.env
ExecStart=/opt/logbill/node_modules/.bin/tsx server/index.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<CADDY
${HOST} {
	encode gzip
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
CADDY

cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now logbill caddy
echo "LOGBILL SETUP DONE"
