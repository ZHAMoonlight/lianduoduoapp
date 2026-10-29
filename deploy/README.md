# Docker 生产部署

使用现有 MySQL 时，请使用独立的 [外部 MySQL 部署说明](EXTERNAL_MYSQL.md) 和 `compose.external-mysql.yml`。当前 `lianduoduo.aiapaas.com` 已切换为该方式，运行配置为 `/opt/lianduoduo/.env.prod`；以下为新建内置 MySQL 容器的可选部署方式。

部署结构为宿主机现有 Nginx → 本机回环端口 → Node 应用容器 → 内网 MySQL 容器。应用容器内端口为 3001，宿主只发布 `127.0.0.1:${APP_BIND_PORT}`；MySQL 使用独立数据卷，不发布 3306，也不接管宿主已有数据库。

## 在开发机生成发布包

当前服务器资源较少，使用预编译发布包。在本地项目的 `app` 目录执行：

```sh
node deploy/package.mjs --prebuilt --output /absolute/path/lianduoduo-release.tar.gz
```

命令在开发机编译领域模块和 Vite 页面，再按显式白名单归档。发布包包含 `.local-runtime`、`dist-local/client`、服务器源码和精简容器构建文件；不包含真实 `.env`、`node_modules`、`outputs`、SQL 转储、Git 目录或原生小程序。代码在打包过程中变化时命令会失败，需要在修改完成后重跑。输出包括归档、`.sha256` 校验文件及归档内的 `release-manifest.json` 文件清单和摘要。

将归档和校验文件上传到目标服务器的专用发布目录，校验后解压。预编译产物为 JavaScript、CSS 和静态资源；服务器通过 `Dockerfile.prebuilt` 构建自身架构的 Node 镜像，仅安装锁定的 `mysql2` 运行依赖，不安装或构建前端依赖。

常规多阶段源码构建仍可用：`node deploy/package.mjs --source` 生成源码包，配置 `APP_DOCKERFILE=Dockerfile` 后，在资源充足的构建机编译镜像。

## 生产配置

在目标服务器将 `.env.production.example` 复制为 `.env.production` 并设置权限 `600`。填写独立的生产 MySQL 业务密码、root 密码和真实 WeChat AppID/AppSecret。实际环境文件留在服务器，不加入归档或镜像。

- `APP_DOCKERFILE=Dockerfile.prebuilt`：使用本地产物路径；`APP_IMAGE_TAG` 为唯一发布标签。
- `APP_BIND_PORT`：选择宿主空闲回环端口，并与 Nginx upstream 保持一致。
- `PUBLIC_ORIGIN=https://lianduoduo.aiapaas.com`：应用校验公开来源并设置 HTTPS Cookie；`ALLOWED_ORIGINS` 同样填写此来源。
- `TRUSTED_PROXY_IPS`：仅填写应用容器实际收到的宿主代理连接 IP，多个用逗号分隔。先检查 Docker 网关和实际连接，保持空值时不信任代理提供的 IP。Nginx 必须将 `X-Real-IP` 覆盖为 `$remote_addr`；应用不依赖客户端提供的 `X-Forwarded-For` 或 `X-Forwarded-Proto`。
- `SETUP_TOKEN`：在目标服务器生成的随机首次开通口令。全新数据库创建管理员时必须通过 `X-Setup-Token` 提交；公开页面不可匿名抢先开通。
- `NODE_IMAGE`、`MYSQL_IMAGE`：默认官方 Node 22 与 MySQL 8.4 镜像，也可使用已核验的同版本镜像来源。

Compose 仅把 root 密码交给 MySQL 和一次性 `db-init` 容器。应用只接收业务账号密码。收款凭证保存在 `receipt_attachments.content` BLOB 中，持久化由 MySQL 数据卷承担。

默认内存上限：MySQL 512 MB、应用 256 MB、初始化容器 128 MB，均禁用额外容器交换空间。MySQL 缓冲池 64 MB、最多 30 个连接，关闭 Performance Schema；应用 V8 旧空间上限 128 MB。可通过环境中的内存限制调整运行上限。

## 初始化全新数据库并启动

本次部署使用全新数据库，不导入本地业务、账号或微信绑定数据。生产环境文件准备后执行：

```sh
docker compose --env-file .env.production -f compose.production.yml config --quiet
docker compose --env-file .env.production -f compose.production.yml build app
docker compose --env-file .env.production -f compose.production.yml up -d --wait mysql
docker compose --env-file .env.production -f compose.production.yml run --rm db-init
docker compose --env-file .env.production -f compose.production.yml up -d --wait app
docker compose --env-file .env.production -f compose.production.yml ps
curl --fail http://127.0.0.1:43101/api/setup
```

如 `APP_BIND_PORT` 另有设置，请替换最后的端口。`db-init` 会建立版本化表结构和不可改历史账本的触发器，应用健康后再连接 Nginx。数据卷命名属于此 Compose 项目；常规升级保留数据卷。修改环境文件中的密码不会自动修改已有 MySQL 用户密码。

## 接入现有 Nginx 与小程序

阿里云 Linux / RHEL 启用 firewalld 时，如果内部 Docker 网桥没有自动加入 `docker` 区域，初始化容器可能出现 `EHOSTUNREACH`。先用 `docker network inspect` 核对本项目数据库网络对应的 `br-<network ID前12位>`，只将该网桥加入现有 Docker 区域：`firewall-cmd --zone=docker --add-interface=<本项目网桥>`，并以 `--permanent` 再执行一次使其重启后保留。网络重建导致网桥 ID 变化时须重新核对。保留 Docker 的跨网隔离规则。

在现有 Nginx 新增 `server_name lianduoduo.aiapaas.com` 的独立虚拟主机，反代到选定回环端口，设置 12 MB 请求体上限以支持 10 MB 收款凭证。转发 `Host`，将 `X-Real-IP` 设置为 `$remote_addr`，覆盖来源不明的转发头。配置 DNS 和 HTTPS 证书，执行 `nginx -t` 确认全部站点配置有效后 reload。

原生小程序的公开 API 地址需要另行配置为 `https://lianduoduo.aiapaas.com`，并在微信公众平台开通该 request/upload/download 合法域名。容器构建与运行不会写入原生小程序配置，也不会把 AppSecret 编译进浏览器或小程序。

## 升级与回退

使用独立镜像标签保存每次发布；升级前备份数据库和 Nginx 虚拟主机配置，运行 schema 初始化后再更新应用。保留上一版本镜像便于回退。应用镜像回退不会回退数据库结构或业务数据；需要恢复数据时使用经过核验的备份流程。常规停止或重建不要删除数据卷。
