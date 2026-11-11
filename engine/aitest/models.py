"""核心实体（对应架构文档第 12 节数据模型）。"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


class CaseType(str, Enum):
    API = "api"
    UI = "ui"
    APP = "app"  # 移动端 App（Android / iOS）


class ExecutionMode(str, Enum):
    UI = "ui"
    API = "api"
    CAPTURE = "capture"  # 埋点抓包
    DOC = "doc"  # 文档核对
    MANUAL = "manual"
    APP = "app"  # 移动端 App：Pinky 探索 + Maestro 回归


class CaseStatus(str, Enum):
    DRAFT = "draft"  # 草稿
    REVIEWED = "reviewed"  # 已审
    DEPRECATED = "deprecated"  # 废弃


class LintLevel(str, Enum):
    BLOCK = "block"  # 阻断：不修复不入库
    BLOCK_SCRIPT = "block_script"  # 阻断脚本生成
    WARN = "warn"  # 警告
    INFO = "info"  # 提示


class LintStatus(str, Enum):
    UNCHECKED = "unchecked"
    PASSED = "passed"
    WARNED = "warned"
    BLOCKED = "blocked"


class RunMode(str, Enum):
    REGRESSION = "regression"  # 回归：不耗模型
    EXPLORE = "explore"  # 探索
    HEAL = "heal"  # 自愈


class FailureType(str, Enum):
    PRODUCT_BUG = "product_bug"
    SCRIPT_ERROR = "script_error"  # 用例/脚本错误或页面改版
    ENVIRONMENT = "environment"
    UNKNOWN = "unknown"


PRIORITIES = ("P0", "P1", "P2", "P3")
CATEGORIES = ("功能测试", "安全相关", "兼容性", "其它")


@dataclass
class Project:
    name: str
    workspace_path: str
    environments: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: new_id("proj"))
    # 两层项目：kind="group" 为大项目（不含用例、无 workspace，只放共享配置）；
    # 子项目的 parent_id 指向大项目，继承其执行环境、角色账号与设置
    parent_id: str = ""
    kind: str = "project"


@dataclass
class Requirement:
    project_id: str
    source_file: str
    section: str
    content: str
    id: str = field(default_factory=lambda: new_id("req"))


@dataclass
class ApiSpec:
    """接口类用例的可执行描述（脚本数据与脚本分离）。"""

    method: str
    path: str
    path_params: dict[str, Any] = field(default_factory=dict)
    query: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, Any] = field(default_factory=dict)
    body: Any = None
    auth: bool = True
    expected_status: list[int] = field(default_factory=lambda: [200])
    response_schema: dict[str, Any] | None = None
    expected_fields: dict[str, Any] = field(default_factory=dict)
    # 接口间依赖：从响应中提取变量供后续用例以 ${var} 引用，如 {"user_id": "data.id"}
    extract: dict[str, str] = field(default_factory=dict)
    operation_id: str = ""
    # 多账号：用哪个角色的凭据调用（空 = 环境的默认 token）。角色 token 来自钥匙串，或用环境的「接口登录」换取
    role: str = ""
    # 流程步骤名（api_flow 中使用），如「买家下单」
    name: str = ""


@dataclass
class TestCase:
    __test__ = False  # 防止 pytest 把它当作测试类收集

    title: str
    project_id: str = ""
    requirement_ids: list[str] = field(default_factory=list)
    type: str = CaseType.UI.value
    priority: str = "P2"
    category: str = "功能测试"
    module_path: list[str] = field(default_factory=list)
    execution_mode: str = ExecutionMode.UI.value
    owner: str = ""
    preconditions: list[str] = field(default_factory=list)
    data_refs: list[str] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    expected: list[str] = field(default_factory=list)
    lint_status: str = LintStatus.UNCHECKED.value
    status: str = CaseStatus.DRAFT.value
    api: ApiSpec | None = None
    # 接口流程：多个请求按顺序执行（每步可用不同角色），如 下单 → 支付 → 审核 → 退款；
    # 步骤间用 extract + ${var} 传值，任一步失败即整条用例失败
    api_flow: list[ApiSpec] = field(default_factory=list)
    source_row: int | None = None
    id: str = field(default_factory=lambda: new_id("tc"))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TestCase":
        data = dict(data)
        api = data.pop("api", None)
        flow = data.pop("api_flow", None) or []
        tc = cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        if api:
            tc.api = ApiSpec(**api) if isinstance(api, dict) else api
        tc.api_flow = [ApiSpec(**s) if isinstance(s, dict) else s for s in flow]
        return tc

    @property
    def is_api_executable(self) -> bool:
        """单个请求（api）或流程（api_flow）都可生成接口脚本。"""
        return self.api is not None or bool(self.api_flow)


@dataclass
class LintIssue:
    case_id: str
    rule: str
    level: str
    message: str
    suggestion: str = ""
    resolved: bool = False
    id: str = field(default_factory=lambda: new_id("lint"))


@dataclass
class TestData:
    __test__ = False

    project_id: str
    key: str
    check_script: str = ""
    seed_script: str = ""
    id: str = field(default_factory=lambda: new_id("td"))


@dataclass
class RoleAccount:
    project_id: str
    role_name: str
    credential_ref: str  # 钥匙串引用，数据库不存明文
    storage_state_path: str = ""
    id: str = field(default_factory=lambda: new_id("role"))


@dataclass
class Script:
    case_id: str
    path: str
    framework: str
    version: str = ""
    id: str = field(default_factory=lambda: new_id("scr"))


@dataclass
class RunResult:
    run_id: str
    case_id: str
    status: str  # passed / failed / skipped / error
    duration: float = 0.0
    message: str = ""
    evidence_paths: list[str] = field(default_factory=list)
    failure_type: str | None = None


@dataclass
class Run:
    project_id: str
    env: str
    started_at: str
    mode: str = RunMode.REGRESSION.value
    result: dict[str, Any] = field(default_factory=dict)
    id: str = field(default_factory=lambda: new_id("run"))


@dataclass
class AgentSession:
    codex_thread_id: str
    purpose: str
    project_id: str = ""
    token_usage: int = 0
    id: str = field(default_factory=lambda: new_id("as"))


def dumps(obj: Any) -> str:
    def default(o: Any) -> Any:
        if hasattr(o, "__dataclass_fields__"):
            return asdict(o)
        if isinstance(o, Enum):
            return o.value
        raise TypeError(f"not serializable: {type(o)}")

    return json.dumps(obj, ensure_ascii=False, default=default)


class ProposalStatus(str, Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


@dataclass
class HealProposal:
    """自愈产出的脚本修改建议：只有用户确认后才合并（第 7 节）。"""

    case_id: str
    script_path: str
    original: str
    proposed: str
    diff: str
    reason: str = ""
    failure_type: str = FailureType.SCRIPT_ERROR.value
    run_id: str = ""
    status: str = ProposalStatus.PENDING.value
    commit: str = ""
    id: str = field(default_factory=lambda: new_id("heal"))


@dataclass
class ReviewItem:
    """AI 判定结果（视觉判定等）进入人工复核队列，不直接算通过（第 11 节）。"""

    case_id: str
    kind: str  # visual / ai_assert
    description: str
    evidence_paths: list[str] = field(default_factory=list)
    ai_verdict: str = ""  # pass / fail / ""（未判定）
    run_id: str = ""
    status: str = "pending"  # pending / confirmed_pass / confirmed_fail
    id: str = field(default_factory=lambda: new_id("rev"))
