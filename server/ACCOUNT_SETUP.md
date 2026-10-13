# 个人账号与同步

当前实现用户名/密码注册、登录、退出，账号之间的数据隔离，服务器 SQLite 快照保存，设备端按账号缓存，联网后同步。数据库 owner_id/scope 为以后共享组预留，当前只允许 personal，不开放好友或群组。

密码通过 scrypt 加盐存储。登录凭据是 HttpOnly Cookie，数据库只保存凭据摘要。修改请求校验来源，并有登录/注册频率限制。服务只监听本机 8788，由 Vite 或 Nginx 转发。

## 本地运行

本地 Vue 开发服务的账号、任务同步和模型请求统一转发到 https://47.104.95.146，与服务器网页和 App 共用云端账号数据，无需启动本机账号或模型服务。高德查询仍由地图服务提供。

本地早期账号数据库仍保留，但不再默认连接。原有本地账号不会自动成为云端账号，需要登录/注册云端账号；有旧任务要迁移时，选择显式导入。需单独调试后端时，可用支持 node:sqlite 的 Node 在 server 目录运行 `node account-server.mjs`，默认数据库在 server/data/accounts.sqlite。

首次登录可勾选导入本机旧数据，仅云端尚无数据时导入。未勾选则不迁移旧数据。旧 IndexedDB 数据保留，不自动合并不同设备已有数据。账号缓存、待上传数据分账号保存。

第一版同步粒度为整份任务快照，使用服务端版本号防止覆盖；遇到同时修改会暂停上传，提示用户选择云端或本机版本。选择云端前，会将本机冲突数据备份到该账号 localStorage 的 conflict-backup 键。后续可升级为逐任务合并。

## ECS 部署

2026-10-13 已部署账号服务到 ECS，路径 /opt/morning-mainline-account，数据库目录仅 www-data 可写。COOKIE_SECURE=true 用于公网 HTTPS。可在家人完成注册后设置 ALLOW_REGISTRATION=false 并重启账号服务。deploy-account.sh 为部署配置脚本。

account-service.example 为独立 systemd 服务配置；现有模型代理和 DERP 不需要修改。Nginx HTTPS server 增加：

```nginx
location /api/account/ {
    client_max_body_size 2m;
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
}
```

不要公开 8788。通过 SQLite 在线备份或暂停账号服务后备份数据库；运行中的 WAL 数据库不能只复制主文件。数据库、备份和 .env 不提交 Git。

Vue HTTP(S) 浏览器通过同源 /api/account/ 支持账号同步。原生 file:// 打包版使用 account.request 桥接，由 URLSession 访问固定 HTTPS 地址 https://47.104.95.146/api/account，凭据保留在原生 Cookie 存储，不向 JS 回传；无需开放 null Origin 或关闭 HTTPS 证书校验。原生 location.current 桥接通过 CoreLocation 按需申请使用期间定位权限，再交给高德转换坐标；拒绝定位后仍可名称搜索与手动选择出发地。

公网 HTTPS 注册/登录/快照保存读取/退出及原生编译已经检查。手机实机授权、登录重启后凭据保持、后台提醒和 Watch 仍需真机验证；Watch 保留既有原生同步链路。暂未提供忘记密码/邮件验证。
