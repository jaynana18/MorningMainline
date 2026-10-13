#!/usr/bin/env bash
set -euo pipefail
test -x /opt/morning-mainline-model/node/bin/node
install -d -m 755 /opt/morning-mainline-account
install -d -o www-data -g www-data -m 700 /opt/morning-mainline-account/data
install -m 644 /opt/morning-mainline-account/incoming/account-server.mjs /opt/morning-mainline-account/account-server.mjs
if [ ! -f /opt/morning-mainline-account/.env.account ]; then
  install -m 600 /opt/morning-mainline-account/incoming/.env.account.example /opt/morning-mainline-account/.env.account
fi
install -m 644 /opt/morning-mainline-account/incoming/account-service.example /etc/systemd/system/morning-mainline-account.service
task_nginx_config=/etc/nginx/sites-available/morning-mainline-public-https
task_nginx_backup="${task_nginx_config}.before-account-$(date +%Y%m%d%H%M%S)"
if ! grep -q 'location /api/account/' "$task_nginx_config"; then
  cp -p "$task_nginx_config" "$task_nginx_backup"
  sed -i '/    location = \/api\/model\/chat\/completions {/i\
    location /api/account/ {\
        client_max_body_size 2m;\
        proxy_pass http://127.0.0.1:8788;\
        proxy_set_header Host $host;\
        proxy_read_timeout 25s;\
    }' "$task_nginx_config"
  if ! nginx -t; then cp -p "$task_nginx_backup" "$task_nginx_config"; exit 1; fi
fi
systemctl daemon-reload
systemctl enable --now morning-mainline-account.service
systemctl is-active --quiet morning-mainline-account.service
nginx -t
systemctl reload nginx
for task_attempt in {1..20}; do
  if curl -s -o /dev/null http://127.0.0.1:8788/api/account/me; then break; fi
  sleep 0.2
done
systemctl is-active morning-mainline-account.service
ss -lnt | grep '127.0.0.1:8788'
curl -s -o /dev/null -w 'Account HTTPS status: %{http_code}\n' https://47.104.95.146/api/account/me
