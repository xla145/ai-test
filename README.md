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

# 启动桌面端（需要 codex 二进制：AITEST_CODEX_BIN=/path/to/codex）
npm run dev
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

## 当前进度

一期（接口测试主线 + 用例导入规范检查）已实现，详见 [docs/architecture.md](docs/architecture.md#迭代状态)。
