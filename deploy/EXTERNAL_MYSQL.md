# 使用既有 MySQL 服务

使用独立的 `compose.external-mysql.yml`，不与内置 MySQL Compose 文件合并。它沿用 `lianduoduo-production` 项目与 `app` 服务，仅在 `application` 网络运行，不要求本地 MySQL 容器或旧 `db-init` 容器成功。

生产环境保留现有应用镜像标签、域名、微信配置、首次开通码和代理设置，只替换已核对的 MySQL 连接配置。环境文件权限使用 `600`，不要运行会完整打印密码的 Compose 配置输出。

`MYSQL_HOST=127.0.0.1` 在容器内表示容器本身。连接宿主数据库应填写其可达私网 IP；必要时以 `MYSQL_DOCKER_HOST=host.docker.internal` 显式覆盖。数据库仍须监听可达地址并接受业务账号，不能依靠这个别名解决仅绑定回环地址的 MySQL。

## 初始化

先核对目标数据库版本、表清单和业务行数。初始化脚本只创建或升级应用表结构，不删除、清空或导入业务数据。

默认使用 `MYSQL_USER`、`MYSQL_PASSWORD` 初始化。需要独立 DDL 账号时，成对填写 `MYSQL_SCHEMA_USER`、`MYSQL_SCHEMA_PASSWORD`；或明确设置 `MYSQL_INITIALIZE_AS_ADMIN=true`，再使用 `MYSQL_ROOT_PASSWORD` 以 root 初始化。应用容器仅接收业务账号，不接收这些管理员密码。

若目标命名库尚不存在，显式设置 `MYSQL_CREATE_DATABASE=true`，并选择上述管理员模式。脚本只执行当前 `MYSQL_DATABASE` 的 `CREATE DATABASE IF NOT EXISTS`，不修改任何用户、授权或 MySQL 全局设置。当前业务结构要求 MySQL 8 及 `utf8mb4_0900_bin`，并需要创建触发器的相应权限。

已有生产镜像不包含新增的初始化入口，Compose 中使用只读绑定挂载 `deploy/init-external-mysql.mjs`，也可通过 `EXTERNAL_MYSQL_INIT_SCRIPT` 指定宿主文件绝对路径。若 root 只允许本机登录，可在私有初始化阶段使用 `docker run --network host`，将该次执行的 `MYSQL_HOST` 设为 `127.0.0.1`；应用连接仍使用用户配置的实际地址。

```sh
docker compose --env-file /opt/lianduoduo/.env.prod -f compose.external-mysql.yml config --quiet
docker compose --env-file /opt/lianduoduo/.env.prod -f compose.external-mysql.yml run --rm schema-init
docker compose --env-file /opt/lianduoduo/.env.prod -f compose.external-mysql.yml up -d --no-build --pull never app
```

API 启动会再次执行幂等结构检查，业务账号须具有该库必要的结构检查/创建权限。验证新库 schema 版本、表结构、触发器、容器健康、公开域名和首次开通状态后，再停止旧 MySQL 容器。保留旧容器的数据卷和旧生产环境文件，以便回退。切换时不要使用 `--remove-orphans` 或删除卷的命令。
