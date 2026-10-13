#!/usr/bin/env bash
set -euo pipefail
task_account=/opt/morning-mainline-account
task_model=/opt/morning-mainline-model
task_incoming="$task_account/incoming-ai"
task_backup="$task_account/backups/ai-$(date +%Y%m%d%H%M%S)"
task_nginx=/etc/nginx/sites-available/morning-mainline-public-https
test -f "$task_account/account-server.mjs"
test -f "$task_model/model-proxy.mjs"
install -d -m 700 "$task_backup"
cp -p "$task_account/account-server.mjs" "$task_backup/account-server.mjs"
cp -p "$task_model/model-proxy.mjs" "$task_backup/model-proxy.mjs"
cp -p "$task_nginx" "$task_backup/nginx.conf"
"$task_model/node/bin/node" --input-type=module -e 'import {DatabaseSync} from "node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("PRAGMA busy_timeout=10000");db.prepare("VACUUM INTO ?").run(process.argv[2]);db.close();' "$task_account/data/accounts.sqlite" "$task_backup/accounts.sqlite"
rollback() {
  cp -p "$task_backup/account-server.mjs" "$task_account/account-server.mjs"
  cp -p "$task_backup/model-proxy.mjs" "$task_model/model-proxy.mjs"
  cp -p "$task_backup/nginx.conf" "$task_nginx"
  systemctl restart morning-mainline-model.service morning-mainline-account.service || true
  nginx -t && systemctl reload nginx || true
}
trap rollback ERR
install -m 644 "$task_incoming/parse-contract.mjs" "$task_account/parse-contract.mjs"
install -m 644 "$task_incoming/parse-contract.mjs" "$task_model/parse-contract.mjs"
install -m 644 "$task_incoming/model-proxy.mjs" "$task_model/model-proxy.mjs"
install -m 644 "$task_incoming/account-server.mjs" "$task_account/account-server.mjs"
sed -i 's/proxy_read_timeout 25s;/proxy_read_timeout 65s;/' "$task_nginx"
nginx -t
systemctl restart morning-mainline-model.service morning-mainline-account.service
for task_attempt in {1..30}; do
  if curl -s -o /dev/null http://127.0.0.1:8788/api/account/me && curl -s -o /dev/null http://127.0.0.1:8787/api/model/chat/completions; then break; fi
  sleep 0.2
done
systemctl is-active --quiet morning-mainline-account.service morning-mainline-model.service
curl -s -o /dev/null http://127.0.0.1:8788/api/account/me
systemctl reload nginx
trap - ERR
systemctl is-active morning-mainline-account.service morning-mainline-model.service
printf 'Backup: %s\n' "$task_backup"
