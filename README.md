# AI 测试客户端（ai-test）

桌面端 AI 测试客户端：输入需求文档 / 接口文档 / 已有 Excel 用例，输出结构化用例、可执行的
pytest / Playwright 脚本、执行报告与失败归因。底层 agent 引擎为 **Codex App Server**，
内嵌 Chromium 承载被测页面。

> 设计依据：《AI 测试客户端技术架构实现文档》。代码与文档章节的对应关系见
> [docs/architecture.md](docs/architecture.md)。

核心原则：**AI 负责“写”，不负责“跑”**——首次由 agent 生成用例与确定性脚本；日常回归直接跑脚本、
不消耗模型；只有失败且无法确定原因时才调 agent 归因。人在关键节点审核。

## 仓库结构

```
engine/        Python 执行引擎（确定性部分，不耗模型）
  aitest/
    models.py      数据模型（Project / TestCase / LintIssue / Run …）
    store.py       SQLite 存储，写入时做用例 JSON Schema 校验
    importer.py    Excel 导入 / 导出（字段映射可配置）
    linter.py      用例规范检查（10 条结构类规则）
    router.py      执行方式路由（ui / api / capture / doc / manual）
    docparser.py   需求文档 → Markdown → 按章节切块
    openapi.py     OpenAPI 3 / Swagger 2 解析
    apigen.py      接口用例生成 + 数据驱动 pytest 脚本生成
    runner.py      pytest 回归执行、JUnit 解析、初步失败归因
    workspace.py   项目 workspace（AGENTS.md、技能文件、git 版本管理）
    cli.py         JSON 命令行，供 MCP Server 与编排层调用
mcp-servers/   注册给 Codex 的本地 MCP Server（TypeScript SDK，stdio）
  src/ui/         二期 UI 测试：浏览器会话与录制、定位器规范、Playwright 脚本生成、
                  UI 回归执行器、埋点抓包、造数与时间控制、Midscene 视觉工具
  templates/ui/   写入项目 workspace 的 Playwright 配置、全局登录与辅助函数
desktop/       Electron + React 桌面壳
  src/main/codex/   Codex App Server 客户端（stdio JSON-RPC）与协议适配层
  src/main/orchestrator.ts  编排层：回归调度、agent 任务、token 记录
  src/main/approval.ts      沙箱审批策略
  src/main/secrets.ts       钥匙串加密存储 + 本地凭据代理
```

## 快速开始

需要 Python ≥ 3.10、Node.js ≥ 20。

```bash
# 引擎
pip install -e engine            # Word/PDF 解析：pip install -e "engine[docs]"
cd engine && python -m pytest -q && cd ..

# TypeScript（Electron 二进制可按需跳过下载）
npm install
npm run build
npm test

# 启动桌面端：先下载锁定版本的 codex 到 .release/codex（安装包内置同一版本），
# 也可用 AITEST_CODEX_BIN=/path/to/codex 指定其他 codex
scripts/fetch-codex.sh
npm run dev

# 只看界面：在普通浏览器中用演示数据预览（不需要 Electron 与后端）
npm run preview:web -w desktop   # 打开 http://localhost:5173
```

### 只用命令行跑通接口测试主线

```bash
export AITEST_DB=/tmp/aitest.db
aitest init-project --name demo --workspace ./demo-ws \
  --environments '{"test": {"base_url": "http://localhost:8000"}}'
aitest generate-api-cases --project <项目ID> --openapi engine/tests/fixtures/petstore.yaml
aitest write-api-suite   --project <项目ID>
AITEST_AUTH_TOKEN="Bearer xxx" aitest run-api-suite --project <项目ID> --env test
aitest summarize-failures --run <run_id>
```

### 导入已有 Excel 用例并做规范检查

```bash
aitest import-excel --project <项目ID> --file 用例.xlsx
aitest lint --project <项目ID> --with-issues
aitest export-excel --project <项目ID> --out 修复后.xlsx
```

## 安全设计

- 凭据只存在系统钥匙串（Electron `safeStorage`），数据库只存引用。
- agent 调用工具时只传**环境名**；`run_api_suite` 执行时由 MCP Server 向仅监听 `127.0.0.1`、
  带一次性 token 的凭据代理换取凭据，注入到引擎子进程，不出现在工具输出和模型上下文中。
- workspace 外写入、删除、访问生产环境或白名单外地址，均弹窗由用户审批。

### UI 测试（二期）

1. 在桌面端「UI 测试」页配置角色账号（存入钥匙串）和登录方式。
2. 对 UI 用例点「探索并生成脚本」：agent 在右侧内嵌浏览器里操作，每步按
   data-testid → role / label → 文本 → CSS 的优先级录制，生成 `scripts/ui/<用例ID>.spec.ts`。
3. 「执行 UI 回归」直接跑 Playwright 脚本，不调用模型；缺失测试数据先造数，造不出来的用例降级为手工。
4. 失败且原因不明的用例进入自愈：agent 读 trace 与截图归因，页面改版时给出脚本 diff，在界面上确认后合并。
5. 视觉类判定（颜色、遮挡、截断）进入人工复核队列，不直接算通过。

命令行 / CI 下 browser 服务会自行启动 Chromium；桌面端则连接内嵌浏览器（`AITEST_CDP_ENDPOINT`）。
可选启用 Midscene 视觉定位：`npm i @midscene/web`，设置 `AITEST_MIDSCENE=1` 及其模型环境变量。

### 数据库校验（入库校验）

在桌面端「数据库」页为每个环境配置被测系统的数据库连接（MySQL / PostgreSQL / SQLite，密码存钥匙串），
可直接执行只读查询，并把查询结果一键生成为入库校验断言。

- 接口用例：`api.db_checks`（请求后校验，可引用 `${var}`，如新建记录的 ID）与 `api.db_setup`（请求前准备数据）
- UI 用例：探索时 agent 用 `browser.expect_db` 录入断言，生成的脚本中为 `await expectDb({...})`
- 安全：查询与断言只允许单条只读语句，连接本身也设为只读；写操作只用于数据准备，且只在非生产环境、
  关闭「只读连接」后可用
- CI：在密钥中配置 `AITEST_DB_PASSWORDS`（JSON：`{"连接名": "密码"}`）

```bash
aitest db-query --project <项目ID> --env test --conn main --sql "SELECT status FROM tags WHERE code = :c" --params '{"c": "TAG-1001"}'
```

### 测试报告与导出

```bash
aitest list-runs     --project <项目ID>                       # 执行历史（接口 / UI）
aitest run-detail    --run <执行ID>                           # 单次执行明细：结果、归因、证据、AI 判定
aitest export-report --run <接口执行ID> --run <UI执行ID>      # 合并导出单文件 HTML 汇总报告（截图内嵌）
aitest export-report --run <执行ID> --format xlsx --out 结果.xlsx
aitest export-excel  --project <项目ID> --out 用例.xlsx       # 导出用例（原 Excel 格式）
```

桌面端「测试报告」页可查看执行历史与明细、打开 Playwright HTML 报告（含 trace）、导出 HTML / Excel；
用例库页可导出 Excel。`aitest-ci` 在 `reports/ci/` 下同时生成 `junit.xml`、`summary.md` 与 `report.html`。

### 工程化（三期）

```bash
# 团队共享：导出到 workspace（随 git 提交），其他成员 clone 后导入
aitest export-workspace --project <项目ID> --commit
aitest import-workspace --workspace ./demo-ws

# CI：不调用模型，直接回归；凭据来自 CI 密钥变量 AITEST_AUTH_TOKEN / AITEST_ROLES
node mcp-servers/dist/ci.js run  --workspace ./demo-ws --env test
node mcp-servers/dist/ci.js init --workspace ./demo-ws --tool-repo <本仓库 git 地址> --provider github

# 用量、预算与验证指标
aitest usage-report --project <项目ID> --days 30
aitest set-setting  --project <项目ID> --key monthly_token_budget --value 2000000
aitest metrics      --project <项目ID>
```

桌面端「工程化」页集中展示这些内容（按项目）。

### 接口多账号流程

下单 → 支付 → 审核 → 退款这类多个角色配合的流程，写成一条用例的 `api_flow`：每步一个请求，按顺序执行，
每步用 `role` 指定调用者，步骤间用 `extract` + `${var}` 传值，任一步失败整条用例失败（报告指出第几步、哪个角色）。

- 角色凭据在「接口回归 → 多账号」中维护，存系统钥匙串：可以给角色保存固定的接口 token，
  也可以只保存账号密码，并为环境配置「接口登录」（登录接口、请求体模板、响应中 token 的路径），执行时每个角色登录一次换取 token。
- 子项目继承大项目的角色与接口登录配置；CI 中通过 `AITEST_ROLES` / `AITEST_ROLE_TOKENS`（JSON）注入。
- agent 生成接口用例时按 `.agents/skills/api-script.md` 写多账号流程，用例里只写角色名。

### App 测试（Android / iOS）

与 Web UI 测试同一思路：agent 探索一次生成确定性脚本，回归直接执行，不调用模型。

- **探索**：agent 通过 [Pinky](https://github.com/DIYgod/pinky)（MCP）操作真机或模拟器走通用例，付款、删除等关键步骤在 Pinky 中由你确认；
  走通后写成 Maestro 脚本 `scripts/app/<用例ID>.yaml`（`appId: ${APP_ID}`，Android 与 iOS 共用），由 `app` MCP 服务保存并试跑。
- **回归**：「App 测试」页选择平台、环境与设备，用 [Maestro](https://maestro.dev) 执行脚本；失败按规则归因（设备未连接、App 未安装等记为环境问题）。
- **配置**：在执行环境中填写 Android 包名 / iOS Bundle ID；在「全局设置 → 运行环境」中配置 Maestro 路径并启用 Pinky。
  Maestro（依赖 Java 17+）与 Pinky 需另行安装；Maestro 暂不支持 iOS 真机，iOS 回归在模拟器上执行（需要 Mac 与 Xcode），Android 真机与模拟器都支持。角色账号在脚本中以变量引用（如 `${ROLE_ADMIN_USERNAME}`，由 `app.app_info` 列出）。
- 用例类型 `app`，或标题 / 步骤含 App端、Android、iOS 等时自动归为「App」执行方式。

### 大项目与子项目

项目可以分两层组织，侧栏按树形显示：

- **大项目**：不含用例、没有 workspace，只存放共享配置——执行环境、鉴权 token、角色账号、登录方式、预算与单价。
  大项目页面汇总各子项目的用例数、最近一次执行与本月 token 用量。
- **子项目**：有自己的 workspace、用例库、脚本与执行记录；默认继承大项目的上述配置，也可以按环境、角色、设置项单独覆盖
  （项目设置中「覆盖」/「恢复继承」）。月度预算继承自大项目时，按整个大项目累计用量。
- 独立项目可以在项目设置中移入大项目，也可以移出。命令行：`aitest init-project --kind group`、`--parent <大项目ID>`、
  `aitest update-project --parent`、`aitest project-overview`。

侧栏底部的「全局设置」对所有项目生效，不随项目保存：
- **模型**：可添加多个模型（OpenAI、百炼、DeepSeek、方舟或私有化部署的 OpenAI 兼容服务），分别指定 agent 与视觉定位使用哪一个，并测试连通；API key 存系统钥匙串。
- **运行环境**：Python 与 Codex 路径（默认 python3 与内置 Codex）、agent 单次任务 token 上限。环境变量 `AITEST_PYTHON`、`AITEST_CODEX_BIN`、`AITEST_TOKEN_LIMIT` 优先于这里的配置。
- **外观**：跟随系统 / 浅色 / 深色。
- **更新与关于**：当前版本、检查更新、自动检查开关；数据目录与数据库位置。

配置保存在数据目录的 `settings.json`，旧版本的模型配置会自动迁移。

### 自动更新

装过一次带更新功能的版本后，之后的新版本会自动更新，不需要重新下载安装：
启动 15 秒后与每 4 小时检查一次，有新版本就在后台下载，下载完成后弹出提示，点「重启并更新」即可（也可在「全局设置 → 更新与关于」手动检查）。

- 更新地址：`https://download.classktv.com/aitest-desktop/`（Cloudflare R2 桶 `aiprobe`，前缀 `aitest-desktop`）。
- Windows（NSIS）与 Linux（AppImage）使用 electron-updater，Windows 只下载变化的部分。
- macOS 没有开发者证书时无法使用系统的更新框架，由客户端自己下载 zip、校验 sha512、解压，退出时替换 `.app` 后重新打开；
  应用需要放在「应用程序」等可写目录中，在磁盘映像里直接运行时无法更新。
- 发布流水线的 `update-feed` 任务把安装包和 `latest*.yml` 上传到 R2。需要仓库 Secrets `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；
  可选仓库变量 `UPDATE_URL`、`R2_BUCKET`、`R2_PREFIX`、`R2_ACCOUNT_ID` 覆盖默认值。没有配置 Secrets 时跳过上传，不影响 GitHub Release。
- 开发模式默认不检查更新；设置环境变量 `AITEST_UPDATE_URL` 可指定其他更新地址，用于测试。

## 当前进度

一期（接口测试主线 + 用例导入规范检查）、二期（UI 测试：探索 / 回归 / 自愈、多角色、埋点、时间、视觉复核）
与三期（失败归因闭环、验证指标与门禁、用量与预算、团队共享与 CI、国内模型与私有化部署）已实现，详见 [docs/architecture.md](docs/architecture.md#迭代状态)。
