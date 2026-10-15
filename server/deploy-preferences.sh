#!/usr/bin/env bash
# 只更新账号服务（新增 preferences 表 + /api/account/preferences 路由）。
#
# 与 deploy-ai-parse.sh 的差别：**不碰模型代理**。本次改动只落在 account-server.mjs 上，
# 重启模型服务是无关的抖动（正在解析的请求会被打断）。
#
# 数据库无需迁移：新表用 `CREATE TABLE IF NOT EXISTS`，老库首次打开时自动补建。
# 但仍然先做一次在线备份 —— 加表本身是安全的，可万一脚本传错了文件，
# 备份是唯一能立刻回退的东西。
set -euo pipefail
task_account=/opt/morning-mainline-account
task_model=/opt/morning-mainline-model
task_incoming="$task_account/incoming-prefs"
task_backup="$task_account/backups/prefs-$(date +%Y%m%d%H%M%S)"
task_nginx=/etc/nginx/sites-available/morning-mainline-public-https

test -f "$task_account/account-server.mjs"
test -f "$task_incoming/account-server.mjs" || { echo "缺少待部署文件：$task_incoming/account-server.mjs"; exit 1; }

install -d -m 700 "$task_backup"
cp -p "$task_account/account-server.mjs" "$task_backup/account-server.mjs"
cp -p "$task_nginx" "$task_backup/nginx.conf"
# 运行中的 WAL 库不能只复制主文件；VACUUM INTO 出一份干净可用的单文件备份。
# ⚠️ node 在 model 目录下（与 deploy-ai-parse.sh 一致），account 目录里没有自己的 node。
"$task_model/node/bin/node" --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(process.argv[1]);
  db.exec("PRAGMA busy_timeout=10000");
  db.prepare("VACUUM INTO ?").run(process.argv[2]);
  db.close();
' "$task_account/data/accounts.sqlite" "$task_backup/accounts.sqlite"

rollback() {
  echo "部署失败，回滚代码与服务…"
  cp -p "$task_backup/account-server.mjs" "$task_account/account-server.mjs"
  cp -p "$task_backup/nginx.conf" "$task_nginx"
  systemctl restart morning-mainline-account.service || true
  nginx -t && systemctl reload nginx || true
}
trap rollback ERR

install -m 644 "$task_incoming/account-server.mjs" "$task_account/account-server.mjs"
nginx -t
systemctl restart morning-mainline-account.service

for attempt in {1..30}; do
  if curl -s -o /dev/null http://127.0.0.1:8788/api/account/me; then break; fi
  sleep 0.2
done
systemctl is-active --quiet morning-mainline-account.service

# 本地探测：未登录时新老接口都应回 401（404 说明新路由没生效）。
curl -s -o /dev/null -w '  本地 /api/account/preferences → %{http_code}（期望 401）\n' http://127.0.0.1:8788/api/account/preferences
systemctl reload nginx
trap - ERR

echo "服务状态：$(systemctl is-active morning-mainline-account.service)"
ss -lnt | grep '127.0.0.1:8788'
printf '备份：%s\n' "$task_backup"
