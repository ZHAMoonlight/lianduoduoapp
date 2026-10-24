# 练多多 连锁经营工作台

基于四端 HTML 原型实现的全栈 MVP，包含平台、品牌总部、门店店长与教练、学员与家庭成员体验。数据由 Cloudflare D1 持久化，服务端验证角色范围，单行版本 CAS 保证预约、冻结、消课与清分原子更新。

这是私有示例业务空间。体验角色切换用于验证协同流程，不代表已经完成正式多用户认证、小程序发行、微信实名或支付接入。真实上线前事项见产品文档。

## 已实现

- 平台：品牌入驻审核并开通租户、订阅版本与服务有效期、运营状态、系统公告、操作审计。
- 总部：经营汇总、课程履约趋势、门店筛选、学员与教练查询、跨店清分确认、任务下发、品牌公告、CSV 导出。
- 门店：排课、教练与场地冲突检查、教练邀请及资质审核、课程名单、签到消课、任务执行。教练仅可操作本人课程。
- 学员：门店与课程选择、本人和孩子切换、课卡资格校验、预约冻结、取消释放、预约记录和课包余量。

预约只冻结课时，签到后确认消课才扣减余额；取消须严格早于开课前 60 分钟。跨店清分按售卡课时价值计算，只记录内部账务，不触发资金支付。

## 本地启动

需要 Node.js 22.13 或以上，首次运行：

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_smiling_wind_dancer.sql
npm run dev
```

开发服务器默认地址为 `http://localhost:5173`。本机匿名访问自动使用 `local-demo`；数据保存在忽略提交的 `.wrangler/state`。首次访问初始化示例业务数据。刷新页面会保留业务变更，角色视角默认回到总部。

迁移仅在新数据库执行一次。以后新增迁移按顺序追加，不能重放旧迁移。开发时可运行 `npm run dev -- --port 5174` 避免和已有预览冲突。

查看构建版本：

```sh
npm run build
npm run start -- --port 5173
```

修改源代码后须重新构建并重启构建版服务器，避免旧入口引用已替换的资源。开发模式支持热更新。

## 验证

```sh
npm run typecheck
npm test
```

26 项领域测试覆盖余额守恒、幂等、容量、取消边界、资质、冲突、权限与跨店清分。启动构建版服务器后，可对实际本地 D1 运行 HTTP 集成测试：

```sh
LIANDUODUO_TEST_URL=http://127.0.0.1:5173 node --test tests/api.integration.mjs
```

集成测试只允许本机地址，使用随机拥有者空间，不修改浏览器示例空间。开发服务器会剥离测试身份头，因此集成测试必须使用构建版 `npm run start`。

## 工程结构

- `app/page.tsx` 与 `app/globals.css`：平台、总部与四端外壳。
- `app/components/Experience.tsx`：门店、教练与学员交互。
- `app/api`：工作空间查询与业务动作接口。
- `lib/domain.ts`：权限、校验、状态机、余额不变量。
- `lib/workspace-store.ts`：D1 读取、版本 CAS 和拥有者隔离。
- `db`、`drizzle`：数据库声明与迁移。
- `docs/PRODUCT.md`：产品设计和规则。
- `docs/ARCHITECTURE.md`：技术设计和生产演进。
- `docs/ACCEPTANCE.md`：验收清单和实测记录。
- `docs/original-prototype.html`：原始设计参考。

## 部署与外部接入

托管采用 Sites 私有访问策略与 D1 绑定；认证网关注入拥有者身份，非本机请求缺少身份返回 401。应用不能直接暴露到允许任意访客伪造认证头的服务器。`.openai/hosting.json` 保存项目身份，部署会应用 `drizzle` 下的数据库迁移。

当前不含真实微信登录、手机号和实名核验、商户进件、支付退款、订阅消息、课堂照片与监护人关系验证。订单账本、冲正、教练资料补传和正式组织成员授权属于下一阶段。签约课包总额和消课价值是示例账面指标，不等同于营收、支付结算或现金到账。
