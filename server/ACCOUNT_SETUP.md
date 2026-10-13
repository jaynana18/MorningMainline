# 个人账号与同步

当前实现用户名/密码注册、登录、退出，账号之间的数据隔离，服务器 SQLite 快照保存，设备端按账号缓存，联网后同步。数据库 owner_id/scope 为以后共享组预留，当前只允许 personal，不开放好友或群组。

密码通过 scrypt 加盐存储。登录凭据是 HttpOnly Cookie，数据库只保存凭据摘要。修改请求校验来源，并有登录/注册频率限制。服务只监听本机 8788，由 Vite 或 Nginx 转发。

## 本地运行

需要支持 node:sqlite 的 Node（服务器现有 Node 22.23.3 可用）。在 server 目录运行 `node account-server.mjs`；默认数据库在 server/data/accounts.sqlite。Vue 开发服务已配置 /api/account/ 转发到 8788。

首次登录可勾选导入本机旧数据，仅云端尚无数据时导入。未勾选则不迁移旧数据。旧 IndexedDB 数据保留，不自动合并不同设备已有数据。账号缓存、待上传数据分账号保存。

第一版同步粒度为整份任务快照，使用服务端版本号防止覆盖；遇到同时修改会暂停上传，提示用户选择云端或本机版本。选择云端前，会将本机冲突数据备份到该账号 localStorage 的 conflict-backup 键。后续可升级为逐任务合并。

## ECS 部署

本轮只开发本地代码，未部署这些新服务。部署时将脚本放入 /opt/morning-mainline-account，创建仅 www-data 可写的 data 目录，复制 .env.account.example 到服务器 .env.account。COOKIE_SECURE=true 用于公网 HTTPS。可在家人完成注册后设置 ALLOW_REGISTRATION=false 并重启账号服务。

account-service.example 为独立 systemd 服务配置；现有模型代理和 DERP 不需要修改。Nginx HTTPS server 增加：

```nginx
location /api/account/ {
    client_max_body_size 2m;
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
}
```

不要公开 8788。通过 SQLite 在线备份或暂停账号服务后备份数据库；运行中的 WAL 数据库不能只复制主文件。数据库、备份和 .env 不提交 Git。

目前 Vue HTTP(S) 浏览器支持完整账号同步。原生 file:// 打包版还需要配置可用的账号 API 地址和原生认证/跨域传输，尚未验证；Watch 仍走既有原生同步链路。暂未提供忘记密码/邮件验证。
