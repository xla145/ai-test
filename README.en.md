<div align="center">

# AIProbe

**AI writes the test cases and scripts; regressions just run the scripts. A desktop AI testing tool for QA teams.**

[![Release](https://img.shields.io/github/v/release/xla145/ai-test?label=download)](https://github.com/xla145/ai-test/releases/latest)
[![CI](https://github.com/xla145/ai-test/actions/workflows/ci.yml/badge.svg)](https://github.com/xla145/ai-test/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

[简体中文](README.md) | English

</div>

AIProbe takes requirement documents, API specs or existing Excel test cases and produces structured test cases
and executable scripts (pytest / Playwright / Maestro). It runs them, reports the results and attributes failures.
The agent engine is the **Codex App Server**; the system under test is opened in an embedded Chromium.

**Core principle: AI writes, it does not run.** The agent generates cases and deterministic scripts once.
Daily regressions run those scripts directly without calling a model. The agent is only asked to
investigate failures whose cause cannot be determined. A person reviews the key steps.

> The user interface is currently in Simplified Chinese.

## Features

| Capability | Description |
| --- | --- |
| Case generation and linting | Import from documents (Word / PDF / Markdown), OpenAPI / Swagger or Excel; 10 structural lint rules; export back to Excel |
| API testing | Data-driven pytest scripts; variable extraction and passing; **multi-account flows** (order → pay → approve → refund, with a different role per step) |
| Web UI testing | The agent explores the app in the embedded browser and records Playwright scripts; regressions use no model; self-healing with a reviewable diff when the page changes |
| App testing | Android / iOS: explore with [Pinky](https://github.com/DIYgod/pinky), regress with generated [Maestro](https://maestro.dev) flows |
| Database checks | Assertions and data setup against MySQL / PostgreSQL / SQLite; queries are forced read-only and production is never written to |
| Failure attribution | Deterministic rules first (environment, data, assertion…); otherwise the agent reads traces and screenshots; a person confirms |
| Reports | Run history and details; export a single-file HTML report (screenshots embedded, several runs combined) or Excel |
| Teams and CI | Cases and scripts are shared through git; `aitest-ci` runs regressions in GitHub Actions / GitLab CI without a model |
| Projects | Two levels (group + sub-projects); sub-projects inherit environments, accounts and database connections; usage tracking and monthly budgets |
| Models | OpenAI, Alibaba Cloud Bailian, DeepSeek, Volcengine Ark, or any self-hosted OpenAI-compatible service |
| Auto update | New versions download in the background; click "restart and update" — no reinstall needed |

## Download

Get the installer from [Releases](https://github.com/xla145/ai-test/releases/latest):

| Platform | File |
| --- | --- |
| Windows | `AIProbe-<version>-win-x64.exe` |
| macOS (Apple silicon) | `AIProbe-<version>-mac-arm64.dmg` |
| Linux | `AIProbe-<version>-linux-x86_64.AppImage` |

- Python 3.10+ must be installed. The engine dependencies and Codex are bundled.
- The installers are not signed with a developer certificate:
  - **macOS**: after the first launch is blocked, open System Settings → Privacy & Security and click "Open Anyway",
    or run `xattr -dr com.apple.quarantine "/Applications/AIProbe.app"`.
  - **Windows**: if SmartScreen appears, click "More info → Run anyway".
- After the first install, later versions update automatically (see [Auto update](#auto-update)).

## Development

Requires Python ≥ 3.10 and Node.js ≥ 20.

```bash
# Engine
pip install -e engine            # Word / PDF parsing: pip install -e "engine[docs]"
cd engine && python -m pytest -q && cd ..

# TypeScript packages
npm install
npm run build
npm test

# Desktop app: download the pinned codex into .release/codex first (installers bundle the same version),
# or point AITEST_CODEX_BIN at another codex binary
scripts/fetch-codex.sh
npm run dev

# UI only: preview in a browser with demo data (no Electron or backend needed)
npm run preview:web -w desktop   # open http://localhost:5173
```

## Repository layout

```
engine/        Python engine (the deterministic part, no model calls); CLI: aitest
  aitest/        models, SQLite store, Excel import/export, linting, document and OpenAPI parsing,
                 API script generation and execution, database checks, reports, workspaces
mcp-servers/   Local MCP servers registered with Codex (stdio) and the CI runner aitest-ci
  src/ui/        Web UI testing: browser sessions and recording, locator rules, Playwright generation and regression
  src/app/       App testing: Maestro execution and report parsing
  templates/ui/  Playwright config, global login and helpers written into project workspaces
desktop/       Electron + React desktop app
  src/main/codex/       Codex App Server client (stdio JSON-RPC) and protocol adapter
  src/main/orchestrator.ts  orchestration: regression scheduling, agent tasks, token accounting
  src/main/secrets.ts   keychain-backed secret store and local credential broker
  src/main/updater.ts   auto update
docs/          architecture notes
```

See [docs/architecture.md](docs/architecture.md) (Chinese) for how the design maps to the code.

## Usage

### API testing from the command line

```bash
export AITEST_DB=/tmp/aitest.db
aitest init-project --name demo --workspace ./demo-ws \
  --environments '{"test": {"base_url": "http://localhost:8000"}}'
aitest generate-api-cases --project <project-id> --openapi engine/tests/fixtures/petstore.yaml
aitest write-api-suite   --project <project-id>
AITEST_AUTH_TOKEN="Bearer xxx" aitest run-api-suite --project <project-id> --env test
aitest summarize-failures --run <run-id>
```

### Import and lint existing Excel cases

```bash
aitest import-excel --project <project-id> --file cases.xlsx
aitest lint --project <project-id> --with-issues
aitest export-excel --project <project-id> --out fixed.xlsx
```

### Multi-account API flows

A flow that needs several roles (order → pay → approve → refund) is one case with an `api_flow`: one request per step,
run in order, each step naming its caller with `role` and passing values with `extract` + `${var}`.
If any step fails the case fails, and the report names the step and the role.

- Role credentials live in the system keychain. Store a fixed API token per role, or just a username and password plus an
  "API login" for the environment (login endpoint, body template, token path); each role then logs in once per run.
- Every step can carry `db_setup` / `db_checks` (see Database checks).
- Sub-projects inherit roles and API login settings from their group. In CI, inject `AITEST_ROLES` / `AITEST_ROLE_TOKENS` (JSON).

### Web UI testing

1. Configure role accounts (stored in the keychain) and the login method on the UI testing page.
2. Click "explore and generate script" on a UI case. The agent drives the embedded browser and records each step with the locator
   priority data-testid → role / label → text → CSS, producing `scripts/ui/<case-id>.spec.ts`.
3. "Run UI regression" runs the Playwright scripts without a model. Missing test data is created first; cases that cannot get data are downgraded to manual.
4. Failures with unknown causes go to self-healing: the agent reads the trace and screenshots, and proposes a script diff when the page changed.
5. Visual judgements (colour, overlap, truncation) go to a manual review queue instead of passing automatically.

### App testing (Android / iOS)

- **Explore**: the agent drives a device or emulator through Pinky (MCP); you confirm sensitive steps such as payments in Pinky.
  The result is saved as a Maestro flow `scripts/app/<case-id>.yaml` (`appId: ${APP_ID}`, shared by Android and iOS).
- **Regress**: pick a platform, environment and device on the App testing page; Maestro runs the flows.
- **Setup**: set the Android package / iOS bundle ID per environment, and the Maestro path and Pinky switch in global settings.
  Maestro (Java 17+) and Pinky are installed separately. Maestro does not support physical iOS devices yet; iOS runs on the simulator (Mac with Xcode).

### Database checks

Configure the database connections of the system under test per environment (MySQL / PostgreSQL / SQLite; passwords in the keychain),
run read-only queries, and turn a result into an assertion with one click.

- API cases: `db_checks` (after the request; may reference `${var}`) and `db_setup` (before the request)
- UI cases: the agent records `browser.expect_db` assertions, which become `await expectDb({...})` in the script
- Safety: only single read-only statements are allowed and the connection itself is read-only; writes are only for data setup,
  only outside production, and only when the read-only switch is turned off
- CI: provide `AITEST_DB_PASSWORDS` (JSON: `{"connection": "password"}`)

### Reports

```bash
aitest list-runs     --project <project-id>
aitest run-detail    --run <run-id>
aitest export-report --run <api-run-id> --run <ui-run-id>    # single-file HTML report
aitest export-report --run <run-id> --format xlsx --out results.xlsx
```

`aitest-ci` writes `junit.xml`, `summary.md` and `report.html` under `reports/ci/`.

### Teams and CI

```bash
aitest export-workspace --project <project-id> --commit
aitest import-workspace --workspace ./demo-ws

node mcp-servers/dist/ci.js run  --workspace ./demo-ws --env test
node mcp-servers/dist/ci.js init --workspace ./demo-ws --tool-repo <git url of this repo> --provider github

aitest usage-report --project <project-id> --days 30
aitest metrics      --project <project-id>
```

### Auto update

From v0.3.7 on, the app checks for updates 15 seconds after start and every 4 hours, downloads new versions in the background,
and installs them when you click "restart and update".

- Feed: `https://download.classktv.com/aitest-desktop/` (Cloudflare R2 bucket `oss`, prefix `aitest-desktop`).
- Windows (NSIS) and Linux (AppImage) use electron-updater; Windows downloads only the changed blocks.
- macOS without a developer certificate cannot use Squirrel.Mac, so the app downloads the zip, verifies its sha512,
  and replaces the `.app` on quit. The app must live in a writable folder such as /Applications.
- The release workflow's `update-feed` job uploads to R2 using the repository secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`;
  the repository variables `UPDATE_URL`, `R2_BUCKET`, `R2_PREFIX` and `R2_ACCOUNT_ID` override the defaults.

## Security

- Credentials are stored only in the system keychain (Electron `safeStorage`); the database stores references.
- The agent passes only an **environment name** to tools. At run time the MCP server exchanges it for credentials with a broker that
  listens on `127.0.0.1` with a one-time token, and injects them into the engine process. They never appear in tool output or model context.
- Writes or deletes outside the workspace, access to production, and requests to non-allowlisted hosts require the user's approval.

## Releases

Every push to `main` runs the tests, builds installers for all three platforms, creates a GitHub Release
(version `0.3.<run number>`) and uploads the update files. If one platform fails to build, the others are still released.

## Naming

The product is called AIProbe. For compatibility with existing installs and scripts, these internal names are unchanged:
the `aitest` CLI, `AITEST_*` environment variables, the `aitest` Python package, the `aitest-desktop` data folder and update prefix.
