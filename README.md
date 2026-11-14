<div align="center">

# AIProbe

**AI 写用例和脚本，回归直接跑脚本：面向测试团队的桌面端 AI 测试工具**

[![Release](https://img.shields.io/github/v/release/xla145/ai-test?label=%E4%B8%8B%E8%BD%BD)](https://github.com/xla145/ai-test/releases/latest)
[![CI](https://github.com/xla145/ai-test/actions/workflows/ci.yml/badge.svg)](https://github.com/xla145/ai-test/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

简体中文 | [English](README.en.md)

</div>

AIProbe 读取需求文档、接口文档或已有的 Excel 用例，生成结构化测试用例和可执行脚本
（pytest / Playwright / Maestro），执行后输出测试报告并做失败归因。
agent 引擎是 **Codex App Server**，被测页面在内嵌的 Chromium 中打开。

**核心原则：AI 负责「写」，不负责「跑」。** 首次由 agent 生成用例和确定性脚本，日常回归直接执行脚本、不消耗模型，
只有失败且原因无法确定时才请 agent 归因。关键节点由人审核。

## 功能

| 能力 | 说明 |
| --- | --- |
| 用例生成与规范检查 | 需求文档（Word / PDF / Markdown）、OpenAPI / Swagger（JSON/YAML 文件或 HTTP/HTTPS 地址）、Excel 导入；10 条结构类规则检查，可导出回 Excel |
| 接口测试 | 数据驱动的 pytest 脚本；变量提取与传递；**多账号流程**（下单 → 支付 → 审核 → 退款，每步可换角色） |
| Web UI 测试 | agent 在内嵌浏览器中探索并录制 Playwright 脚本；回归不调用模型；页面改版时自愈并给出 diff |
| App 测试 | Android / iOS：通过 [Pinky](https://github.com/DIYgod/pinky) 探索，生成 [Maestro](https://maestro.dev) 脚本回归 |
| 数据库校验 | MySQL / PostgreSQL / SQLite 入库断言与数据准备；查询强制只读，生产环境禁止写入 |
| 失败归因 | 先用确定性规则判定（环境、数据、断言…），无法判定时再由 agent 读 trace、截图归因，结果由人确认 |
| 测试报告 | 执行历史与明细；导出单文件 HTML 报告（截图内嵌，可合并多次执行）或 Excel |
| 团队与 CI | 用例与脚本随 git 共享；`aitest-ci` 在 GitHub Actions / GitLab CI 中回归，不需要模型 |
| 项目管理 | 大项目 + 子项目两层结构，子项目继承环境、账号、数据库连接；用量统计与月度预算 |
| 模型 | OpenAI、阿里云百炼、DeepSeek、火山方舟，或私有化部署的 OpenAI 兼容服务 |
| 自动更新 | 后台下载新版本，点「重启并更新」即可，不需要重新下载安装 |

## 下载安装

到 [Releases](https://github.com/xla145/ai-test/releases/latest) 下载：

| 平台 | 文件 |
| --- | --- |
| Windows | `AIProbe-<版本>-win-x64.exe` |
| macOS（Apple 芯片） | `AIProbe-<版本>-mac-arm64.dmg` |
| Linux | `AIProbe-<版本>-linux-x86_64.AppImage` |

- 需要本机安装 Python 3.11+；引擎依赖和 Codex 已随安装包附带。
- 安装包没有使用开发者证书签名：
  - **macOS**：首次打开被拦截后，到「系统设置 → 隐私与安全性」底部点「仍要打开」；
    也可以执行 `xattr -dr com.apple.quarantine "/Applications/AIProbe.app"`。
  - **Windows**：出现 SmartScreen 提示时，点「更多信息 → 仍要运行」。
- 装过一次之后，新版本会自动更新（见[自动更新](#自动更新)）。

## 快速开始（开发）

需要 Python ≥ 3.11、Node.js ≥ 20。

```bash
# 引擎
pip install -e engine            # 解析 Word / PDF：pip install -e "engine[docs]"
cd engine && python -m pytest -q && cd ..

# TypeScript 部分
npm install
npm run build
npm test

# 启动桌面端：先下载锁定版本的 codex 到 .release/codex（安装包内置同一版本）
# 也可以用 AITEST_CODEX_BIN=/path/to/codex 指定其他 codex
scripts/fetch-codex.sh
npm run dev

# 只看界面：在浏览器中用演示数据预览（不需要 Electron 和后端）
npm run preview:web -w desktop   # 打开 http://localhost:5173
```

`npm run dev` 和 `npm start -w desktop` 会自动准备 `.release/engine-deps` 并加载引擎依赖，首次需要联网。也可在仓库根目录运行 `npm run prepare:engine -w desktop` 手动准备；命令行和引擎测试仍需按上文安装 Python 依赖。

开发模式下，页面由 Vite 热更新；修改主进程、preload 或共享 IPC 定义时会自动重新编译并重启 Electron，确保新接口同时生效。编译失败时保留当前运行实例，修正后再重启。

## 仓库结构

```
engine/        Python 执行引擎（确定性部分，不消耗模型），命令行 aitest
  aitest/        数据模型、SQLite 存储、Excel 导入导出、规范检查、文档解析、OpenAPI 解析、
                 接口脚本生成与执行、数据库校验、测试报告、workspace 管理
mcp-servers/   注册给 Codex 的本地 MCP Server（stdio）与 CI 执行器 aitest-ci
  src/ui/        Web UI 测试：浏览器会话与录制、定位器规范、Playwright 脚本生成与回归、埋点、造数
  src/app/       App 测试：Maestro 执行与报告解析
  templates/ui/  写入项目 workspace 的 Playwright 配置、全局登录与辅助函数
desktop/       Electron + React 桌面端
  src/main/codex/       Codex App Server 客户端（stdio JSON-RPC）与协议适配
  src/main/orchestrator.ts  编排：回归调度、agent 任务、token 记录
  src/main/secrets.ts   钥匙串加密存储 + 本地凭据代理
  src/main/updater.ts   自动更新
docs/          架构说明与实现对照
```

架构与实现对照见 [docs/architecture.md](docs/architecture.md)。

## 使用说明

创建项目时可选择测试端：Web、App、纯接口或多端（Web + App），之后可在「项目设置 → 基本信息」调整。
Web 项目显示 Web UI 测试，App 项目显示 App 测试，纯接口项目隐藏这两个入口，多端项目同时显示。
接口测试、用例库、数据库、报告等为公共能力。旧项目默认多端，调整类型后已有用例、脚本和报告继续保留。
大项目只管理共享配置，各子项目可独立选择测试端。

### 命令行跑通接口测试

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

### 选择接口回归范围

在「接口回归」中按模块、请求方法或接口路径筛选，勾选接口可选中其下全部用例；展开接口可单独选择用例。
仅展示已审核且无阻断问题的接口用例。筛选、翻页不会清除已选项，可点击「清空选择」重新选择。

- 首次执行或审核后修改了用例，先点击「生成已审核脚本」，再选择环境、配置凭据，点击「执行选中项」。生成与执行均不调用模型。
- 「全量回归」执行全部可用的已审核接口用例，不受当前筛选和勾选影响。
- 多步骤流程按整条用例执行，保留全部前置步骤与变量传递。拆成不同用例的依赖不会自动补选，应选择完整链路或整理为流程用例。
- 可「保存为测试集」（例如订单冒烟），下次加载后直接执行；同名保存更新范围。测试集保存在 workspace 的 `api-test-sets.json`，可随 git 共享。
- 空选择、跨项目 / 未审核 / 废弃用例、缺少脚本都会报错，不会退回全量执行；未选中项不计入通过率。
- 回归执行本身不消耗模型；原因不明的失败仍按现有规则自动调用 agent 归因。

命令行也可显式限定用例范围（省略 `--case-ids` 仍兼容原来的全量脚本执行）：

```bash
aitest write-api-suite --project <项目ID> --reviewed-only
aitest run-api-suite --project <项目ID> --env test --case-ids '["tc_one","tc_flow"]'
aitest save-api-test-set --project <项目ID> --name 订单冒烟 --case-ids '["tc_one","tc_flow"]'
aitest list-api-test-sets --project <项目ID>
```

### 接口多账号流程

下单 → 支付 → 审核 → 退款这类需要多个角色配合的流程，写成一条用例的 `api_flow`：每步一个请求，按顺序执行，
每步用 `role` 指定调用者，步骤之间用 `extract` + `${var}` 传值。任一步失败整条用例失败，报告会指出第几步、哪个角色。

- 角色凭据在「接口回归 → 多账号」中维护，存系统钥匙串。可以给角色保存固定的接口 token，
  也可以只保存账号密码，并为环境配置「接口登录」（登录接口、请求体模板、响应中 token 的路径），执行时每个角色登录一次换取 token。
- 每一步都可以加 `db_setup` / `db_checks`，见下文数据库校验。
- 子项目继承大项目的角色与接口登录配置；CI 中通过 `AITEST_ROLES` / `AITEST_ROLE_TOKENS`（JSON）注入。

### Web UI 测试

1. 在「UI 测试」页配置角色账号（存入钥匙串）和登录方式。
2. 对 UI 用例点「探索并生成脚本」：agent 在右侧内嵌浏览器里操作，每步按
   data-testid → role / label → 文本 → CSS 的优先级录制，生成 `scripts/ui/<用例ID>.spec.ts`。
3. 「执行 UI 回归」直接跑 Playwright 脚本，不调用模型；缺少测试数据时先造数，造不出来的用例降级为手工。
4. 失败且原因不明的用例进入自愈：agent 读 trace 和截图归因，页面改版时给出脚本 diff，在界面上确认后合并。
5. 视觉类判定（颜色、遮挡、截断）进入人工复核队列，不直接算通过。

命令行和 CI 下 browser 服务会自行启动 Chromium；桌面端连接内嵌浏览器（`AITEST_CDP_ENDPOINT`）。
可选启用 Midscene 视觉定位：`npm i @midscene/web`，并设置 `AITEST_MIDSCENE=1` 和对应的模型环境变量。

### App 测试（Android / iOS）

思路与 Web UI 测试相同：agent 探索一次生成确定性脚本，回归直接执行，不调用模型。

- **探索**：agent 通过 Pinky（MCP）操作真机或模拟器走通用例，付款、删除等关键步骤在 Pinky 中由你确认；
  走通后保存为 Maestro 脚本 `scripts/app/<用例ID>.yaml`（`appId: ${APP_ID}`，Android 与 iOS 共用）。
- **回归**：「App 测试」页选择平台、环境和设备，用 Maestro 执行；设备未连接、App 未安装等记为环境问题。
- **配置**：在执行环境中填写 Android 包名 / iOS Bundle ID；在「全局设置 → 运行环境」中配置 Maestro 路径并启用 Pinky。
  Maestro（依赖 Java 17+）和 Pinky 需要另行安装。Maestro 暂不支持 iOS 真机，iOS 回归在模拟器上执行（需要 Mac 和 Xcode）。

### 数据库校验（入库校验）

在「数据库」页为每个环境配置被测系统的数据库连接（MySQL / PostgreSQL / SQLite，密码存钥匙串），
可以直接执行只读查询，并把查询结果一键生成为入库校验断言。

- 接口用例：`db_checks`（请求后校验，可引用 `${var}`，如新建记录的 ID）和 `db_setup`（请求前准备数据）
- UI 用例：探索时 agent 用 `browser.expect_db` 录入断言，生成的脚本中为 `await expectDb({...})`
- 安全：查询和断言只允许单条只读语句，连接本身也设为只读；写操作只用于数据准备，且只在非生产环境、
  关闭「只读连接」后可用
- CI：在密钥中配置 `AITEST_DB_PASSWORDS`（JSON：`{"连接名": "密码"}`）

```bash
aitest db-query --project <项目ID> --env test --conn main \
  --sql "SELECT status FROM tags WHERE code = :c" --params '{"c": "TAG-1001"}'
```

### 测试报告与导出

```bash
aitest list-runs     --project <项目ID>                       # 执行历史（接口 / UI）
aitest run-detail    --run <执行ID>                           # 单次执行明细：结果、归因、证据、AI 判定
aitest export-report --run <接口执行ID> --run <UI执行ID>      # 合并导出单文件 HTML 报告（截图内嵌）
aitest export-report --run <执行ID> --format xlsx --out 结果.xlsx
aitest export-excel  --project <项目ID> --out 用例.xlsx       # 导出用例（原 Excel 格式）
```

「测试报告」页可以查看执行历史和明细、打开 Playwright HTML 报告（含 trace）、导出 HTML / Excel。
`aitest-ci` 在 `reports/ci/` 下生成 `junit.xml`、`summary.md` 和 `report.html`。

### 团队共享与 CI

```bash
# 团队共享：导出到 workspace（随 git 提交），其他成员 clone 后导入
aitest export-workspace --project <项目ID> --commit
aitest import-workspace --workspace ./demo-ws

# CI：不调用模型，直接回归；凭据来自 CI 密钥变量
node mcp-servers/dist/ci.js run  --workspace ./demo-ws --env test
node mcp-servers/dist/ci.js init --workspace ./demo-ws --tool-repo <本仓库 git 地址> --provider github

# 用量、预算与验证指标
aitest usage-report --project <项目ID> --days 30
aitest set-setting  --project <项目ID> --key monthly_token_budget --value 2000000
aitest metrics      --project <项目ID>
```

### 大项目与子项目

项目可以分两层组织，侧栏按树形显示：

- **大项目**：不含用例，也没有 workspace，只存放共享配置：执行环境、鉴权 token、角色账号、登录方式、数据库连接、预算与单价。
  大项目页面汇总各子项目的用例数、最近一次执行和本月 token 用量。
- **子项目**：有自己的 workspace、用例库、脚本和执行记录；默认继承大项目的配置，也可以按环境、角色、设置项单独覆盖。
- 命令行：`aitest init-project --kind group`、`--parent <大项目ID>`、`aitest update-project --parent`、`aitest project-overview`。

### 全局设置

侧栏底部的「全局设置」对所有项目生效：

- **模型**：可以添加多个模型，分别指定 agent 和视觉定位使用哪一个，并测试连通；API key 存系统钥匙串。
- **运行环境**：Python、Codex、Maestro 路径，Pinky 开关，agent 单次任务 token 上限。
  环境变量 `AITEST_PYTHON`、`AITEST_CODEX_BIN`、`AITEST_TOKEN_LIMIT` 优先于这里的配置。
- **外观**：跟随系统 / 浅色 / 深色。
- **更新与关于**：当前版本、检查更新、自动检查开关；数据目录和数据库位置。

### 自动更新

装过一次带更新功能的版本（v0.3.7 及以后）后，新版本会自动更新：
启动 15 秒后以及之后每 4 小时检查一次，有新版本就在后台下载，下载完成后弹出提示，点「重启并更新」即可。

- 更新地址：`https://download.classktv.com/aitest-desktop/`（Cloudflare R2 桶 `oss`，前缀 `aitest-desktop`）。
- Windows（NSIS）和 Linux（AppImage）使用 electron-updater，Windows 只下载变化的部分。
- macOS 没有开发者证书时无法使用系统的更新框架，由客户端自己下载 zip、校验 sha512、解压，退出时替换 `.app` 并重新打开。
  应用需要放在「应用程序」等可写目录中，在磁盘映像里直接运行时无法更新。
- 发布流水线的 `update-feed` 任务把安装包和 `latest*.yml` 上传到 R2，需要仓库 Secrets `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；
  可选的仓库变量 `UPDATE_URL`、`R2_BUCKET`、`R2_PREFIX`、`R2_ACCOUNT_ID` 可覆盖默认值。
- 开发模式默认不检查更新；设置环境变量 `AITEST_UPDATE_URL` 可以指定其他更新地址，用于测试。

## 安全设计

- 凭据只存在系统钥匙串（Electron `safeStorage`），数据库只存引用。
- agent 调用工具时只传**环境名**。执行时由 MCP Server 向只监听 `127.0.0.1`、带一次性 token 的凭据代理换取凭据，
  注入到引擎子进程，不出现在工具输出和模型上下文中。
- 在 workspace 之外写入或删除、访问生产环境或白名单之外的地址，都会弹窗请用户审批。
- 数据库查询强制只读；生产环境禁止写入。

## 发布

推送到 `main` 后，发布流水线自动执行测试、构建三个平台的安装包、创建 GitHub Release（版本号为 `0.3.<运行序号>`），
并把更新文件上传到下载站。某个平台构建失败时，其余平台照常发布。

## 命名说明

产品名为 AIProbe。为了兼容已有安装和脚本，以下内部名称保持不变：命令行 `aitest`、环境变量 `AITEST_*`、
Python 包 `aitest`、数据目录 `aitest-desktop`、更新地址前缀 `aitest-desktop`。
