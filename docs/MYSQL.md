# 本地 MySQL 存储与 SQLite 一次迁移

当前正式运行使用 Node.js 异步 `mysql2/promise` + MySQL 8.4（InnoDB）。管理后台和小程序共用此数据库；SQLite 仅作为保留的备份与一次迁移输入，运行时不读取或写入 SQLite。

## 连接与持久化

| 项目 | 当前配置 |
| --- | --- |
| MySQL | `127.0.0.1:43306`，容器内端口 3306 |
| 业务数据库 / 用户 | `lianduoduo` / `lianduoduo` |
| API / 开发后台 | `http://127.0.0.1:43101` / `http://127.0.0.1:5173` |
| Docker 配置 | `app/compose.mysql.yml`，镜像 `mysql:8.4` |
| MySQL 数据 | Docker 命名卷 `lianduoduo_mysql_data` |
| 原 SQLite 及备份 | `app/data/lianduoduo.sqlite`、`app/data/backups/`；保留，不删除 |

配置在 `app/.env`，进程环境变量优先。下列仅列字段，不展示任何实际密码；两个密码字段需自行填写，不能直接使用空示例：

```dotenv
DB_CLIENT=mysql
MYSQL_HOST=127.0.0.1
MYSQL_PORT=43306
MYSQL_USER=lianduoduo
MYSQL_PASSWORD=
MYSQL_DATABASE=lianduoduo
MYSQL_CONNECTION_LIMIT=10
MYSQL_ROOT_PASSWORD=
# MYSQL_SCHEMA_USER=root
```

`DB_CLIENT=mysql` 明确选择当前存储；启动器拒绝其他数据库类型，不回退 SQLite。`MYSQL_PASSWORD` 用于日常业务连接。`MYSQL_ROOT_PASSWORD` 仅用于 Compose 首次初始化 MySQL 和 `db:init` 建表/触发器；API、业务操作与迁移使用 `MYSQL_USER`，不使用 root。MySQL 默认 binlog 策略下首次创建历史保护触发器需要管理员权限，因此先运行 `db:init`；不通过关闭 binlog 或向业务账号授予 SUPER 绕过该要求。已有数据卷的 MySQL 用户密码不会因修改 `.env` 自动改变。`MYSQL_SCHEMA_USER` 可选，默认 root，仅用于 `db:init`。

微信配置仍保留在同一 `.env`。公开配置生成器只同步 API 地址、超时及 AppID，MySQL 密码、root 密码和微信 Secret 均不进入小程序或文档。`DATABASE_PATH` 不再用于选择运行时数据库。

## 首次启动

需要 Node.js 22.13 或以上、可用的 Docker/Compose。在 `app` 目录执行：

```sh
npm ci
npm run db:up
npm run db:init
# 仅需要保留原 SQLite 业务数据时执行一次；全新空库跳过此行。
npm run db:migrate -- --source ./data/lianduoduo.sqlite
npm run dev
```

`db:up` 依据 `compose.mysql.yml` 启动本地 MySQL 并等待健康检查；`db:init` 创建表结构与不可改历史触发器，不注入示例学员或课程。已有表结构的日常重启仍由业务账号连接。迁移应在启用新 MySQL 业务写入前完成，避免将已有业务的目标库当作空库导入。

停止开发 API/后台按 Ctrl+C；停止数据库执行：

```sh
npm run db:stop
```

停止或重启容器会保留命名卷。不要使用 `docker compose down -v` 进行日常重启，该选项会删除数据库卷。SQLite 旧文件也不能替代当前 MySQL 的完整备份；经营数据应备份 MySQL 库及其中的凭证 BLOB。

## 一次迁移的保留范围

迁移命令只读打开指定 SQLite 源库，向空 MySQL 目标库导入；不删除或覆盖源文件。保留业务对象及其顺序、用户与密码摘要、组织成员授权、会话令牌摘要及到期时间、微信绑定、code 防重放与开通票据、收款凭证原始 BLOB 与订单关联，以及 `meta` 全局版本和创建时间。已过期会话仍按原期限失效，迁移不延长登录权限，也不重建或合并微信身份。

导入与逐字段/BLOB 校验处于同一事务，失败整体回滚。已导入的同一源快照可识别为已完成而不重放；不同源或已有业务数据的目标库会拒绝覆盖。原 SQLite 备份在 `data/backups/` 保留；这是一条单向一次迁移路径，不是长期双写、双向同步或通用恢复工具。

## 自动测试配置

`npm run test:local` 执行真实 MySQL HTTP 与一次迁移回归。测试独立读取 `MYSQL_TEST_HOST`、`MYSQL_TEST_PORT`、`MYSQL_TEST_USER`、`MYSQL_TEST_PASSWORD`；测试账号需有创建/删除随机测试库及初始化触发器的权限。未配置测试字段时会报错，不回退业务库。测试仅创建并清理 `lianduoduo_test_` 随机库，密码不进入公开配置。

旧 `npm run db:generate:legacy` 仍针对 Drizzle/SQLite 历史路径，不用于当前 MySQL；当前初始化与迁移使用 `db:init`、`db:migrate`。

## 验证状态

当前场地版本为 schema v5，新增 `venues` JSON 业务表；领域 70/70、完整 HTTP / MySQL 106/106（场地专项新增 11 项）、小程序 89/89，静态 17 页/156 事件/315 绑定及构建、Lint、类型检查通过。以下迁移阶段的计数仍为当时保留记录。

真实 MySQL HTTP 45/45（原 44 项业务回归加 1 项数据库约束）、迁移测试 5/5，共 50 项通过，包括机构/独立模式、权限、版本冲突、微信免密、凭证 BLOB、关联回滚及重启持久化。正式源库迁移已验证：MySQL 8.4.11、schema v2、8 个历史保护触发器及业务用户连接正常；首次 imported、第二次 already-imported，逐字段/BLOB/顺序及各表计数一致，SQLite 源 SHA-256 与停机备份一致。

历史 SQLite HTTP 44/44 与隔离 SQLite 原生 GUI 证据仍保留为历史记录，不能用它们替代 MySQL 迁移验收。微信 HTTP 场景使用受控 code 交换；本轮存储切换不自动构成新的真实微信上游登录或真机验收。

正式备份为 `app/data/backups/lianduoduo-before-mysql-2026-10-28T10-27-17-243Z.sqlite`；[脱敏迁移校验摘要](/Users/xupeng/aicode/lianduoduo/app/outputs/mysql-migration/verified.json)。原有 1 个账号、空间、本人教练、微信绑定及成员授权与 2 条会话记录已保留；源库的学员、课卡和凭证附件原本为零，没有补造数据。MySQL 切换后的 API 43101 与后台 5173 同源 `/api/setup` 均返回 200、wechatConfigured:true；全新原生运行时 52560 已恢复迁移会话及本人空间授权，并进入本人工作台；未新增真实业务记录。此轮未重新 wx.login，不将会话恢复写成新的微信上游成功。

## schema v5：真实场地目录回填

`venues` 表沿用 JSON 业务存储方式，包含主键 `id`、`tenant_id/store_id` 范围、JSON `data` 与 `seq` 顺序字段；业务数据为名称、位置、说明、共享许可、启停及创建/更新时间。`classes` 和 `schedule_plans` 在 JSON 中增加可选 `venueId`，原 `room` 保留发布时名称快照，不重写历史课名地点或课时/订单/审计账本。服务端 TABLES 同时保留计划与场地，API 对场地的写入和课次发布沿用同一版本锁及事务。

服务启动调用 `backfillVenueCatalog`：在 `database.transaction` 内持有 `meta.version` 行锁，按既有真实 room、tenant/store 建立稳定 ID 的场地并补绑定无 ID 的课次/计划。名称键统一为 `NFKC.trim().replace(/\s+/g,' ').toLowerCase()`；不补示例场地，也不把不同门店的同名地点合并。新增目录、补绑定或更改已有目录时，整批仅把 `meta.version` 加 1；重复启动没有变化时不写入、不加版本。任何一步失败整体回滚，避免半绑定状态或旧客户端版本覆盖迁移结果。

新增历史目录保留旧计划的共享约定；已有目录仅在无 ID 的旧共享计划仍有未来/进行中实际不同教练重叠课次时补保留 `allowShared`，取消或已结束历史不会重新打开既有场地的共享配置。管理动作改名前也会绑定同范围同名旧记录，始终保留旧 room 快照；稳定 ID 防止改名绕过占用。

排课范围没有任何目录时，旧 API 仍可用 room 文本；一旦有目录，旧文本必须匹配已启用的已登记场地并转为 ID，或由新客户端直接提交有效 ID，显式无效 ID 不回退。新界面始终要求选择 active 场地。实际课次无人预约也占用 `[startAt,endAt)`；段间 gap 与接壤不冲突，取消预约不释放整课，取消课程/计划未来课次才释放对应区间。未来/进行中占用禁止停用，多人重叠未调整时禁止共享降为独占。

场地 HTTP/MySQL 验证使用隔离测试库，覆盖回填幂等与版本、范围、ID/文本绑定、改名冲突、共享约束、取消释放和重启持久化。PC 另在隔离库完成创建至启停的完整 GUI 闭环，fixture 已清理；证据在 [场地验收目录](/Users/xupeng/aicode/lianduoduo/app/outputs/venues/)。本轮没有执行原生真实创建场地，不能将客户端自动测试写成真机验收。

## schema v6：教练账单快照

当前账单功能使用 schema v6，新增 coach_bills，旧业务表和历史记录保留。上文场地及迁移验收计数按对应历史版本保留。coach_bills 使用相同的 id/tenant_id/store_id/data/seq JSON 存储，工作区字段为 coachBills。初始化在数据库级迁移锁内幂等建表并记录版本 6，不回填或制造账单，不改课卡、消课账本、清分、课程和预约。旧来源缺省账单数组时规范化为空数组。

coachBill.create 在原有事务和 meta.version 行锁内重新计算预览、校验摘要并检查重复入账，保存明细与规则的快照。coachBill.settle 仅补登记实付日期、参考、备注、操作人和时间；金额取已保存快照。总部按组织、店长按授课门店、教练按本人隔离，学生不返回账单。账单写入不触发转账和学员资金变动。

GET /api/coach-report 与 POST /api/coach-bills/preview 使用完整来源在服务端计算后返回授权的派生明细，不向教练开放原始售卡订单或消课账本。SQLite 一次导入会检查目标 coach_bills 为空，防止把已有账单的数据库当作空库覆盖；历史 SQLite 导入清单和摘要不因此改变。

## schema v7：门店团队码与持久匹配限流

新增store_team_codes（store_id主键、tenant_id、唯一code_hash、generation、created_by、created_at、expires_at）及wechat_team_attempts（IP/principal摘要、计数和15分钟窗口期限）。wechat_phone_claims增加proof_method默认wechat_phone及team_store_id/team_tenant_id/team_generation；wechat_coach_links增加join_method默认wechat_phone。新团队码领取标记team_code，不改写旧取号证明，不默认生成任何码。

初始化在数据库级schema锁下执行；新增列先查information_schema，DDL成功但迁移marker未写时可安全重跑。生成/重置、审计和业务版本原子提交；失败保留原码/版本。尝试计数独立提交后再验证匹配，避免业务失败回滚清掉限流；同claim/不同微信并发领取由原事务版本锁和唯一关联保证。真实业务启动已迁移schema7，团队码仍为零，测试使用随机隔离MySQL库。


## Schema 8：学员微信邀请码

新增 `member_wechat_invites`（单学员邀请码哈希、版本、期限及领取状态）、`wechat_student_claims`（最长 5 分钟的微信与档案确认凭证）、`wechat_member_links`（单档案微信归属）和 `wechat_student_attempts`（持久限流）。邀请码与预览凭证均不存明文；首次迁移幂等保留 schema 7 的团队码、微信会话、原成员授权和所有业务账本。

生成、重置、预览与确认采用既有数据库版本行锁。确认只增加单学员 student 授权或复用当前微信已有有效授权，原教练 / 独立空间不改；禁用授权不能通过重新领取恢复，另一个微信已持有的档案不能自动转移。旧账密账号保留，新邀请不合并其账号或复制家庭成员权限。旧微信绑定接口同步检查学员归属冲突。
