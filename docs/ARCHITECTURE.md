# 练多多本地技术架构

更新日期：2026 年 10 月 28 日。当前默认运行方式为 Node.js HTTP + 异步 mysql2 + MySQL 8.4、Vite/React 管理后台及原生微信小程序。旧 Cloudflare/D1、拥有者独立示例空间和 ChatGPT 认证文件不是本版运行依赖。

## 运行拓扑

```text
浏览器 → Vite :5173 ── /api 同源代理 ──┐
原生微信小程序 ───── HTTP :43101 ──────┤
                                      ↓
                              Node HTTP / server/app.mjs
                                      ↓
                         领域校验 + 组织/成员/对象权限
                                      ↓
                          MySQL 8.4 / InnoDB :43306
                         Docker volume: lianduoduo_mysql_data
```

先运行 `npm run db:up` 与管理员 `npm run db:init`，需要旧数据时再执行一次 `db:migrate`；开发时 `npm run dev` 同时启动 Vite 与 Node API。`npm run build` 构建浏览器静态文件并编译领域模块；`npm start` 由 Node 按当前配置在 43101 同时提供静态后台和 API。配置只读取 `app/.env`，进程环境值优先。`npm run config:wechat` 以及 dev/build/start 按白名单生成小程序 API 地址、超时和项目 AppID；AppSecret 等服务端字段永不复制前端。

| 模块 | 职责 |
| --- | --- |
| `app/frontend/main.tsx`、`app/vite.local.config.ts` | 浏览器入口、React 挂载、开发代理、静态构建 |
| `app/app/page.tsx`、`components/AuthGate.tsx` | 初始化、真实登录、会话加载、已授权上下文切换与退出 |
| `components/Operations.tsx`、`Experience.tsx` | 运营、课程履约、学员与反馈交互 |
| `app/server/app.mjs` | 异步 HTTP、认证、账号与成员授权、事务业务协调、微信 code 交换与静态文件 |
| `app/server/database.mjs` | mysql2 Promise 连接池、MySQL schema/触发器、同连接事务与全局版本行锁 |
| `app/local/migrate-mysql.mjs` | 只读 SQLite 一次导入、逐字段/BLOB 校验与重复执行保护 |
| `app/lib/domain.ts` | 排课预约、资格和冲突校验、状态机、权益不变量及角色投影 |
| `app/lib/operations.ts` | 门店/学员、开卡续费退款、异常履约、跟进、反馈与追加权益流水 |
| `app/lib/types.ts` | 领域对象、授权、动作与字段契约 |
| `app/local`、`scripts/compile-local.mjs` | 环境加载、领域编译、开发/构建/启动与测试编排 |
| `miniprogram` | 原生 Page、WXML、WXSS 与统一 API 请求/认证封装 |

保留的 Next/Vinext、D1 声明和 `*:legacy` 命令属于历史兼容路径。当前验收执行本地入口，不向旧体验站点写入或部署。

## 初始化与真实认证

先通过 `db:init` 创建 MySQL 表结构和历史保护触发器，不注入业务 seed；日常 API 使用业务账号。后台维持账号密码初始化和登录，尚无账密用户时首次页面默认独立教练；`POST /api/setup` 显式发送 `mode:'solo'`，只必填姓名、账号、密码，空间名与科目可选。在同一事务内创建租户、用户、唯一的 `selfManaged` 本人教练，以及带本人 `coachId` 的 owner `hq` 授权。该 owner 不具有 platform 授权，`stores=[]`，不写入任何虚拟 Store。本地独立空间不受机构 expiresAt 服务到期锁限制：新 solo 使用 `9999-12-31`，旧 solo 的历史过期字段也兼容；仍必须 active，机构到期与空间停用限制保留。课包和会话各自的有效期不受此规则改变。

明确选择 `mode:'organization'` 后创建组织和首家门店；真正空库时仍授予平台与总部两条授权。若库中只有 !wechat-only 微信用户，GET /api/setup 的 initialized 仍为 false，后台可首次开通另一账密账号和新工作空间；事务以既有数据为基底追加，不清空微信空间，仅给新账号自己空间的 hq，不授予 platform。任何账密用户存在后 initialized 为 true，重复 POST setup 返回 409；停用用户或未知非 !wechat-only 格式也计入已有账密用户，防止绕过重开。该字段表示后台账密初始化是否完成，不表示数据库是否为空。后台与微信账号不按姓名/手机合并。为兼容旧调用，省略 setup mode 沿用机构行为；旧 Tenant.mode 未填写也按机构处理。UI 默认与兼容 API 默认应分别理解，不能通过随意变更 mode 扩权。

后台登录账号唯一、大小写归一；密码用独立随机盐和 scrypt 保存，原文不入库。新微信用户存储不可用于密码登录的专用标记，不设置或生成可登录密码。服务端生成随机会话令牌，数据库只保存 SHA-256 摘要和 7 天到期时间；session 保存 login_method，响应 loginMethod。浏览器使用 HttpOnly、SameSite=Lax Cookie；小程序使用 Bearer token。退出撤销该会话。

小程序仅调用 wx.login，再 POST /api/auth/wechat，由服务端 code2Session 校验当前微信。已绑定则返回原用户授权与微信会话；未绑定则返回 needsOnboarding、onboardingToken 和 expiresAt。随机开通票据有效 5 分钟，数据库仅存其摘要与微信映射，客户端只驻留 App 内存，不放本地存储或 URL。POST /api/auth/wechat/register 使用票据、姓名及可选空间名/科目，在事务内创建私有 solo、唯一 selfManaged 本人教练、hq+coachId 授权和微信绑定；无 Store、无 platform，不接受旧组织/角色作为创建目标。成功后同微信未用票据一并失效，防止重复开通；过期或使用后不能重放。

新微信可在已有业务库中创建自己的空间，不接管旧机构。已有微信绑定保留原授权，未绑定旧账号不按姓名或手填手机号合并；新建教练档案可由微信真实手机号验证后领取，不接管已有其他账号授权。服务端保留 setup/login/account.create/bind 兼容能力，后台原有账密界面不变；小程序不提供账密或绑定入口，且只续用服务端确认 loginMethod=wechat 的会话。旧本机账密缓存会清除，不撤销电脑后台会话。AppSecret 仅从服务端环境读取。

`GET /api/auth/session` 对匿名请求返回 `user:null` 和空授权列表；业务 API 对未登录返回 `401`。账号密码格式、同源校验、JSON 请求体限制及登录频率限制在服务端执行。

## 工作空间模式与权限

`users` 保存账号，`memberships` 保存角色与租户/门店/教练/学员范围，`sessions` 保存当前活跃的成员授权。同一组织员工共享业务记录，不按登录人复制整套数据。Tenant.mode 区分 solo/organization；session membership 与 persona 的 workspaceMode 由服务端推导，不由客户端声明赋权。

- 独立 owner 内部 role 为 hq 且绑定唯一本人 coachId，UI 显示独立教练；可运营自己空间，不能创建 Store、邀请/审核其他教练或开通机构员工账号，只可选开通绑定学员的 student 账号。
- 独立实体使用 `storeId:''`，课程 `room` 是自由填写的实际授课地点；空门店 ID 不承担隔离职责，所有读写及场地冲突仍受 tenant_id 范围约束。
- 以下平台、总部和店长分工仅属于机构模式。平台可维护组织及组织管理员；总部可创建本品牌店长、教练和学员账号。
- 店长只能开通本店教练和学员账号，业务写入仍校验本店范围。
- 教练按本人授课、学员负责关系和明确跟进分配读取必要数据；签到消课限定本人课程。
- 教练只能联系、更新日期/状态或结束分配给自己的跟进，不能创建、批量生成或改变分配。
- 学员账号只能操作已绑定学员；账号绑定不等于外部亲属关系已核验。
- 客户端的角色、拥有者和组织字段不能赋权；`/api/workspace?persona=...` 与动作请求外传 `persona`/`owner` 被拒绝。

响应中的 `persona` 由当前会话授权生成，只描述当前上下文。上下文切换必须使用当前账号 `memberships` 中存在的 ID。每次写入在事务内重新读取授权，防止会话已变更后仍按旧上下文写入。

`Coach.selfManaged` 只标识本人自主管理。它不是机构资质审核结果或认证承诺；仅在服务端确认的独立空间及本人执教关系下放宽机构证书门槛，不能用该字段伪造另一组织的教练权限。

## MySQL 存储与异步事务

正式存储为 MySQL 8.4 / InnoDB，通过 `mysql2/promise` 连接池执行真正异步 SQL。`createLocalServer`、查询、变更、提交与关闭均为 Promise；不存在同步等待模拟或以内存副本替代数据库。当前本地连接为 `127.0.0.1:43306`，数据库/业务用户 `lianduoduo`，持久数据位于 Docker 命名卷 `lianduoduo_mysql_data`。

用户、成员授权、会话、微信绑定、code 防重放与一次性开通票据为独立表；租户、门店、学员、教练、场次、卡、预约、订单、清分、任务、公告、跟进、反馈、审计及权益流水各有独立表。业务表保存对象 ID、租户/门店索引列、单调 `seq` 与 JSON 文本，当前未将全部业务字段拆成关系列。utf8mb4 保留中文文本，金额仍为整数分；附件内容为独立表的私有 BLOB，不放公开静态目录。

`database.transaction` 用 AsyncLocalStorage 将查询固定到同一连接，先锁定 `meta` 的全局 version 行（`SELECT ... FOR UPDATE`），再检查版本、重新读取授权、执行纯领域转换、逐表保存变化、关联凭证、追加账本/审计并更新版本；异常整体回滚，嵌套事务复用外层。工作区及附件授权读取使用一致事务快照，写入结果和响应版本也在同一事务形成。相同版本并发写最多一个成功，另一个返回 `409`，客户端只刷新，不自动重放扣课或预约。微信 code 先原子占用再请求上游，网络等待不占用数据库事务；开通/绑定仍在事务内防重放及扩权。

权益流水、审计和反馈由数据库触发器禁止 UPDATE/DELETE；已关联订单的凭证不能删除或修改。开卡/续卡与订单、权益流水及凭证关联同事务保存，失败后附件仍是可重试草稿。续费建立新卡和订单；退款追加流水，不删除历史。全库版本锁仍按整库共享，品牌之间可能发生版本冲突；扩大并发前应验证容量、细化事务粒度、分页与约束。

配置来自 `app/.env` 的 `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE/CONNECTION_LIMIT`。`MYSQL_ROOT_PASSWORD` 只供 Compose 与首次 `db:init` 建表/触发器，运行时使用业务用户；不关闭 binlog 或授予业务账号 SUPER。通过 `db:stop` 停止保留卷，不用 `down -v`。SQLite 仅保留为备份及 `db:migrate -- --source ...` 的只读一次迁移输入，运行时不再依赖它。源库及 `data/backups/` 不删除；迁移保留账号、授权、会话及期限、微信绑定、凭证 BLOB/关联、创建时间和全局版本，不合并身份或延长权限。命令及正式迁移证据见 [MYSQL.md](MYSQL.md)。

服务端仍会加载业务集合、范围投影并比较变更。这与每拥有者一行 JSON 的旧实现不同，但不能未经容量测试承接大规模数据。

## 关键业务不变量

| 对象 | 约束 |
| --- | --- |
| 课时卡 | `0 ≤ frozen ≤ remaining ≤ total`；可约为剩余减冻结，退款卡不能预约 |
| 预约 | 同学员同场次不重复冻结；活动预约不超容量，学员时间不重叠 |
| 履约 | 预约 → 签到 → 完成；完成只扣一次；普通取消、迟取消、未到店各保留独立状态 |
| 异常与停课 | 员工登记迟取消/未到店释放冻结；整场停课检查开课和履约状态后释放相关预约 |
| 排课 | 本人/机构教练时间不重叠；地点冲突受租户范围约束。机构继续校验教练审核、科目与资质；独立本人可填自管科目与地点，不走机构证书门槛，课包科目资格仍校验 |
| 订单 | 流水号及附件选填；非空流水号 trim 后在品牌内去重。最多 3 份同范围真实凭证；开卡、订单、权益流水和附件关联同一事务落库 |
| 退款 | 仅无消费和冻结的完整课包可全额线下退款登记 |
| 清分 | 同一跨店完成预约至多一单；金额和分配依据保留快照，确认不代表支付 |
| 跟进 | 同学员同原因未结案任务去重；独立模式默认本人负责，机构负责教练须同品牌同门店且已审核 |
| 续费结案 | `renewed` 必须引用同学员同品牌、跟进创建后产生的有效已付款订单 |

时间戳使用 ISO，业务展示与日期边界使用 Asia/Shanghai。金额保存整数分，课时为整数节；课包实付分摊和跨店消费采用累计分配差额处理整数分舍入，不能用场次展示价格替换订单价值。

## 跟进与信息最小化

跟进保存学员、原因、负责人显示名、`assigneeCoachId`、日期、`open/contacted/closed` 状态、追加联系内容及结案结果。规则当前固定为低余额、14 天内到期和有真实消课记录且无未来预约的 30 天未到课；不是预测模型。

结案结果为 `resumed/renewed/paused/declined/other`。`renewed` 引用真实订单，由服务端检查，文字结果不能替代付款记录。给机构受雇教练的 `renewalCandidates` 仅含订单 ID、时间和课包名；机构受雇教练响应的订单、权益账本、清分、审计、账号数组不暴露经营财务内容。独立 owner 是经营者，其 hq 投影正常包含自己的收款与权益账本，不能套用受雇教练的财务隐藏策略。

## API 与客户端

| 接口 | 用途 |
| --- | --- |
| `GET/POST /api/setup` | 后台账密初始化状态与首次开通；纯微信用户不锁死后台首次开通 |
| `POST /api/auth/login`、`GET /api/auth/session` | 密码登录与会话 |
| `POST /api/auth/context`、`POST /api/auth/logout` | 已有授权切换、退出 |
| `POST /api/auth/wechat` | 微信 code 校验，返回已有授权会话或短期开通票据 |
| `POST /api/auth/wechat/register` | 票据 + 姓名/可选空间名科目，新建本人无店 solo 与微信会话 |
| `POST /api/auth/wechat/phone` | 微信会话或开通票据 + 原生取号 code，返回主体绑定的短期 claim 和脱敏门店候选 |
| `POST /api/auth/wechat/coach-join` | claim + coachId，事务内复核并追加单一门店教练身份，保留已有 solo |
| `POST /api/auth/wechat/bind` | 旧账号绑定兼容接口，当前小程序无此入口 |
| `GET /api/workspace` | 当前授权范围的数据与版本 |
| `POST /api/actions` | `{action,payload,version}` 业务变更 |
| `POST /api/receipt-attachments` | 已授权经营者上传私有 JPG/PNG/WebP/PDF，单份最多 10 MiB |
| `GET /api/receipt-attachments/:id` | 按财务范围鉴权下载真实文件 |
| `POST /api/receipt-attachments/:id/remove` | 仅上传者移除未关联订单的草稿 |

响应成功后客户端才更新数据与关闭表单。`401` 回登录，`403` 保持业务不变，`409` 只刷新版本并提示重试。具体字段以 `app/lib/types.ts` 为准。

## 当前接入与运行边界

本次只本地运行，不部署 Sites、不发布微信小程序。微信 AppID/Secret 沿用 `app/.env` 的已有配置，只有公开 API 地址/超时与 AppID 进入小程序；MySQL 密码与 Secret 不写入前端或文档。现行 API 43101、开发后台 5173；真机的 loopback 不是开发电脑。存储切换不构成新的真实微信 code exchange 或原生 GUI 验收；既往绑定与会话保留，实际登录仍受微信上游及原会话期限控制。

线下收款/退款登记不是微信支付，内部清分不是资金分账。通知、支付回调、部分退款、消课冲正、密码恢复和离职撤权界面、多向业务同步、通用备份恢复、完整财务对账及大容量仍需独立实现或验收。一次 SQLite 迁移不代表具备这些能力。

## 当前 MySQL 验证

真实 MySQL HTTP 45/45（原 44 项业务回归加 1 项数据库约束）、迁移测试 5/5，共 50 项通过。正式源库迁移已输出 imported，逐字段/BLOB/顺序校验与独立表计数一致，源与停机备份的 SHA-256 不变；第二次运行返回 already-imported，不覆盖数据。已确认 MySQL 8.4.11、业务账号、schema v2 和 8 个历史保护触发器，摘要见 [MYSQL.md](MYSQL.md)。迁移不造学员/课卡/附件。新 API 43101 与后台 5173 同源 `/api/setup` 均为 200、wechatConfigured:true；全新原生运行时 52560 恢复迁移会话与本人空间授权，并进入工作台，但未重新 wx.login，不构成新的微信上游或真机证明。

此前领域 31/31、公开配置 2/2、小程序客户端/模板 43/43 及静态 14 页/98 事件/176 动态绑定为已保存结果。HTTP 中微信交换为受控测试；历史 GUI 证据仍按当时版本和存储记录。

## 历史：2026-10-25 SQLite 与早期微信入口验收

以下为当时原记录，其中端口、空 Secret 和测试计数均反映历史状态，不作为当前 MySQL 或微信配置结论：

领域回归 26 项、真实 SQLite HTTP 33/33、公开配置 2/2 通过。HTTP 含机构/独立闭环、长期服务状态、微信开通票据有效期与重放、已有库中新私有空间、微信先开通后的后台独立 setup、数据保留和身份隔离等；code 交换为受控测试，不是微信上游实测。小程序客户端/模板 22/22、静态 14 页/91 事件/150 动态绑定通过，包含服务端 loginMethod 权威校验，旧账密缓存不能绕过微信入口。

历史后台 GUI 和 10 月 24–25 日旧账号密码版原生 GUI 已完成的建档、收款、排课代约、履约、反馈与跟进证据保留；不能由此推断新的微信免密登录已经真实成功。当前 Secret 尚空，真实上游与真机仍需单独验收。并发 409 的重读及人工重试是既有保护，不宣称控制台零 error。详见 [验收记录](ACCEPTANCE.md)。

本次原生微信入口 GUI 在隔离 3002 使用 wechatCodeExchange 注入 synthetic openid，验证 wx.login 后跳开通、仅姓名创建及进入本人工作台；真实 3001 页面仅微信入口并提示未配置。注入模式的证据有 testOnly 标记，不能当真实 code2Session 成功。

## 微信手机号领取教练档案（schema v3）

新增 `wechat_phone_codes`、`wechat_phone_claims`、`wechat_coach_links`。取号 code 在调用上游前独立事务占用；一次性 claim 绑定 openid/user/可选 onboarding 摘要和 phone 摘要，最长 5 分钟。取号依赖 server/wechat-phone.mjs：服务端 stable_token 缓存、single-flight、确定 token 失效的一次刷新，网络错误不自动重放取号。校验微信 watermark AppID/时效与大陆 11 位号码，拒绝客户端传入原始手机号作为认证。

手机号与后台机构教练匹配，显式选择一条档案后事务内重新检查手机号、资质审核、证书有效期、品牌和门店状态、账号冲突。新微信只新建 Wechat-only user/binding 和对应 coach membership，不新建 tenant/store/coach；已登录微信只追加 membership。coach_id 主键保证档案只绑定一个用户，事务失败全部回滚；同主体同 claim 同教练重试幂等。该身份的后续会话读取也校验 live 档案与 phone 摘要，失效时剔除，仍有 solo 等合法授权可安全回退。

hq/manager 工作区的 `wxLinked` 为服务端只读派生字段，业务写入拒绝伪造；不存入教练 JSON。纯后台账密账户及旧绑定不按手机号自动接管，原后台使用方式保留。真实微信能力、资格和额度不由 `wechatPhoneConfigured` 保证。

本次校验：完整服务端 `test:local` 78/78（原业务/迁移 50 + 手机号集成 20 + 取号传输 8）；领域 31/31、公开配置 2/2、小程序 57/57；静态 15 页、自定义导航、5 个注册 tab、106 事件与 211 动态绑定通过；Lint 零警告、类型检查和构建通过。集成测试使用随机 MySQL 测试库与受控微信响应，不写正式业务数据。

微信开发者工具全量重开后，已检查授权身份页及「我的」入口，原生打开 `pages/join-store/index`，返回仍可进入本人独立工作台；工具停留在加入页，console errors 为 0。未替用户确认真实手机号，也未执行真实门店加入，不将受控测试称为真实取号验收。[原生页面截图](/Users/xupeng/aicode/lianduoduo/app/outputs/wechat-phone-join/native-join-entry-2026-10-28.png)、[验收摘要](/Users/xupeng/aicode/lianduoduo/app/outputs/wechat-phone-join/verified.json)、[服务端日志](/Users/xupeng/aicode/lianduoduo/app/outputs/wechat-phone-local-tests.log)。

## 排课计划与时段（schema v4）

新增 `schedule_plans` 业务表，工作区为 `schedulePlans` 数组；旧来源可缺该数组，领域与服务端统一补为空数组。计划保存规范化规则、身份/门店范围、状态和停用原因，生成课次保存 `schedulePlanId/bookingMode`，不另建平行预约账本。

`POST /api/schedules/preview` 接收 `{payload}`，在已验证身份的只读事务中返回日期/课次数和冲突清单，不写计划、预约、审计或业务版本。`schedule.publish` 重新计算相同有界规则，校验全部日期的教练资质与时间/场地冲突，和所有新课次、审计、版本一起事务落库；任一失败全部回滚。日期采用北京时间，范围≤90天且≤256时段，availability强制容量1，尾部不足单次时长不生成。时段间隔是该计划内的生成规则。

`schedule.cancel` 校验自己的教练或总部/门店范围，对未来未开始课次复用 class.cancel 释放原冻结；保留历史，未来已有签到/完成则拒绝。学生仅预约合法active计划的实际时段，沿用原容量、课卡科目/日期、学员重复预约和全局版本锁检查。服务重启后规则、时段与账本仍来自 MySQL。

SQLite一次导入改用冻结的 `LEGACY_BUSINESS_TABLES`，不因新的MySQL-only表改变既有源摘要或误报另一份导入；未导入目标已有计划时拒绝覆盖。原迁移与新增排课MySQL专项均回归通过。当前界面与验收见 LOCAL_RUN.md 最新章节。

## 多教练排课与预约绑定

`SchedulePlan` 在原主教练 `coachId` 外保存 `coachIds:string[]` 与 `sharedRoom:boolean`。发布/预览接受最多 20 个不重复教练 ID；兼容仅传旧 `coachId`，同时传入时要求它与数组首位一致。旧单教练计划按 `[coachId]` 读取。字段保存在现有 MySQL 业务 JSON 中，沿用 schema v4，不新增平行预约表。

计划生成采用「时间 × 教练」展开，每节 `ClassSession.coachId` 唯一指向实际教练，`capacity` 为该教练的独立名额；availability 每位教练每段容量为 1。预览 `items/conflicts` 展平并携带 `coachId/coachName/room`；`occurrenceCount` 为开放日期数，`timeSlotCount` 为乘教练前的时间数，`coachCount` 为教练数，`slotCount` 为实际课次数。最多 256 节的限制按全部教练展开后计算，资质、科目和全部日期冲突检查任一失败即整批拒绝，正式写入仍在原 MySQL 事务内回滚。

多教练共享同一场地必须显式 `sharedRoom:true`。仅当前计划内部生成的课次可按此约定同场并行，不豁免其他计划或旧课次的场地独占冲突，也不豁免教练本人的时间冲突。PC 与小程序改动计划后作废旧预览，更换场地同时作废共享确认。

学员界面按教练筛选，并在同计划、同一时间的兄弟课次之间选择授课人。切换后重新判断课卡、容量与已有预约；`booking.create` 以选定 `classId` 预约并提交 `coachId`，服务端在幂等返回前要求其匹配课次。新预约保存教练字段，旧预约未存 `coachId` 时从课次解析。容量冻结、取消释放和防学员重叠仍复用现有规则与业务版本锁。

教练授权仅可发布本人单教练计划；多人计划的工作区投影以 `coachIds` 包含本人判断可见性，课次和预约仍只投影本人范围。整计划停用只向原有品牌/门店范围的 `hq/manager` 开放，参与教练无权停止多人计划；旧单教练计划继续按本人或管理范围停用。

本轮领域 58/58、完整 HTTP / MySQL 95/95、小程序自动回归 78/78，静态检查 16 页、142 事件、283 动态绑定通过，构建、Lint 与类型检查通过。上述计数为自动验证，不作为学员小程序真机 GUI 或真实微信上游验证的证明。

## 场地目录与占用（schema v5）

`Venue` 包含 `id/tenantId/storeId/name/location/description/allowShared/status/createdAt/updatedAt`，MySQL `venues` 表使用与其他业务表一致的 JSON 数据、范围索引和顺序字段，工作区为 `venues` 数组。旧快照可缺省该数组；服务端加载统一补空数组。`venue.create/update` 只允许授权范围内的 hq/manager；solo hq 的 `storeId:''`，不关联门店。管理端与教练只读目录按品牌/门店隔离，学生投影 `venues:[]`，不新增对学生公开的内部占用结构。

`server/venues-migration.mjs` 在每次服务启动时进入原 MySQL 事务与 `meta.version FOR UPDATE` 锁。它以原课次/计划的真实 `room`、tenant/store 为来源建立目录，补 `venueId`，不改名称快照或账本。名称比较统一使用 `NFKC → trim → 折叠空白 → toLowerCase`。存在实际变化时仅增加一次全局版本，幂等重启不再增加。已有目录遇到无 ID 的旧共享计划，仅为仍有未来/进行中实际并行课次的计划保留场地共享能力，不因取消或已结束历史恢复共享配置；事务失败整体回滚。

新课程与计划按 `venueId` 绑定且保留 `room` 名称快照，预览明细也返回该 ID。显式 ID 必须属于当前 tenant/store 且 active，不存在、越界、停用时拒绝，绝不以文本兜底。无 ID 的旧写入仅在该范围无目录时保留文本；已有目录则以规范化同名解析并绑定，其他名称拒绝。新增目录或改名前，会给同范围同名无 ID 的旧课次/计划补绑定，保留原 `room`；改名后冲突基于稳定 ID，支持 ID 与旧文本混合检查，不混淆跨店同名场地。

占用来自 scheduled 实际课次的半开区间 `[startAt,endAt)`，包含无人预约、未来及进行中课程；区间接壤允许，可约段 gap 不占用。课次取消释放占用，取消单笔预约不释放整节课的场地，计划停用复用未来课次取消。多教练发布同时要求场地 `allowShared` 和本次 `sharedRoom` 确认，只豁免本次计划内部并行，其他计划继续检查。未来/在课占用阻止停用，实际不同教练重叠阻止共享降为独占；旧文本多人并行存在时，新增同名独占场地也被拒绝。

PC 与小程序必须从 active 目录选场地，空态支持管理与返回草稿。场地失效/切换/共享降级会作废预览并规范化教练选择，旧 ID 不按同名场地静默重选，旧多选草稿不会在能力恢复后复活。预览仍只读，发布与目录变更沿用领域复制校验、全局版本锁及事务持久化。

最终自动验证：领域 70/70、完整 HTTP / MySQL 106/106（场地新增 11 项）、小程序 89/89，静态 17 页/156 事件/315 绑定，构建、Lint、类型检查通过。PC 隔离库 GUI 已实测场地创建、草稿往返、4 次课发布、无人预约占用、改名防绕过、冲突拒绝、停计划释放和启停；fixture 已清理。原生真实创建场地未执行，不能从自动回归推断真机通过。证据见 [场地目录](/Users/xupeng/aicode/lianduoduo/app/outputs/venues/) 与 LOCAL_RUN.md 最新章节。

## 教练报表与结算账单（schema v6）

lib/coach-billing.ts 提供范围授权、报表、账单预览和快照动作。报表以课程开始日在上海时区筛选明确完成的预约，用 consume 账本分摊金额作为消课价值；缺少账本时显式标记估算或待核实，不读取课程展示价充当收入。课程节数与时长按不同 classId 去重，完成人次与课时按 booking 汇总。固定课酬按完整课次计算，提成按未入账的可靠金额计算，以整数分和整数基点避免浮点误差。

服务端 GET /api/coach-report、POST /api/coach-bills/preview 在完整来源上计算并授权投影，解决跨店授课中售卡账本不在店长工作区的问题。教练只能读取本人的派生明细和账单，不扩大其原始订单、课卡或账本权限。学生和平台不能使用该报表接口。

coachBill.create 必须携带 expectedPreviewHash，事务内重算并校验预览与防重复约束。账单保存教练、门店、课程、学员、价值来源、规则、明细和应付金额快照。coachBill.settle 只记录线下支付事实，保存 paidDate、可选 ref/备注、操作人与时间；同内容重试幂等，冲突信息拒绝覆盖。所有变更沿用原有全局版本锁和审计，不改变学员资金账本及跨店清分。MySQL coach_bills 与原业务表一同持久化、加载与范围过滤，不生成历史示例账单。

## 课包精确课程权益

课程为选填，服务端从 courseIds 推导 Card.courseMode：[] 或新开卡缺省课程字段保存 all、classTypes:[] 且无 courseRules，包含范围内以后新增课程；非空保存 selected、courseRules 名称＋科目快照和派生 classTypes。指定课程按 NFKC、去首尾与重复空白、不区分大小写的名称＋科目严格匹配；未知 mode、空/坏 selected rules 或 all 混入规则均不放宽。租户、门店、日期、余额仍由预约规则校验。没有 mode 和 courseRules 的旧卡仍按历史 classTypes 使用，已有精确规则卡继续严格匹配。courseIds 只用于解析权威已建课次，不绑定日期或教练；不同日期/教练合并为同逻辑课程。服务端拒绝客户端 mode/快照、跨租户/门店参考及取消课程。指定课程卡续购若遗漏 courseIds 会拒绝；主动 [] 可新开全部适用卡，旧卡不变。lib/card-courses.ts 与小程序 utils/card-courses.js 同步，字段随 cards JSON 持久化，无 schema 迁移。

目录 GET /api/card-courses 按角色和 home/all 从服务端完整来源生成最小摘要。PC以请求身份、源数据和 AbortController 防陈旧响应；内部规范名称科目键提交时映射当前 id。空选不依赖目录成功；保留具体选择时必须核对目录。范围变化自动移除所有选择后须用户在表单明确改为全部或重新选择，避免自动扩宽。历史科目卡续购默认全部但明确提示仅新卡生效。

## 门店团队码与微信身份绑定

团队码是门店级6位随机数字字符串，7天有效；store_team_codes仅存SHA256摘要、tenant/store、generation、创建者和期限。GET仅读授权门店状态；POST仅组织总部或本店店长可生成/重置，返回明文仅当次，审计与meta.version在同事务提交。码不进入WorkspaceData或审计，前端不持久化明文，切门店/身份即隐藏并中止陈旧请求。成功后soft刷新业务版本，失败不丢新码。

team-match必须先验证微信principal（Bearer微信会话或未使用onboarding）；IP/principal计数独立事务提交，失败及重启不丢失。只按有效码所属门店和输入手机号匹配既有教练，返回脱敏姓名/手机号与最小候选。5分钟claim绑定openid、用户/票据、phone摘要、tenant/store/generation；coach-join在事务中重查码、档案、审核证书、门店、账号占用并原子领取。重置使未用claim返回410；跨店403；已完成加入可幂等重试，已有membership不受轮换影响。team_code来源明确区别微信验证手机号，旧wechat_phone数据/API兼容。

小程序编辑任一输入即清claim并使在途请求失效；匹配与入店使用request.persistAuth=false，先经identity/epoch检查再保存成功会话。旧响应的token/cookie及401不允许覆写或清除新身份。原生表单避免触发开发工具缺失SWC helper的computed对象与spread编译路径。
