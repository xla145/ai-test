"""两层项目：大项目（group）存放共享配置，子项目继承。

继承规则（子项目自己的同名配置优先）：
- 执行环境：大项目的环境 + 子项目自己的环境（同名覆盖，整体替换该环境的配置）
- 角色账号：大项目的角色 + 子项目自己的角色（同名覆盖）；账号密码在钥匙串中同样按「先子项目、后大项目」查找
- 设置（预算、单价、门禁）：逐项继承；月度预算继承自大项目时，按整个大项目（含全部子项目）累计用量
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from .models import Project
from .store import Store

GROUP = "group"


def is_group(p: Project) -> bool:
    return p.kind == GROUP


def effective_environments(store: Store, p: Project) -> dict[str, Any]:
    parent = store.get_project(p.parent_id) if p.parent_id else None
    return {**(parent.environments if parent else {}), **p.environments}


def project_view(store: Store, p: Project) -> dict[str, Any]:
    """对外的项目视图：environments 为生效的环境（含继承），own_environments 为自己定义的部分。"""
    parent = store.get_project(p.parent_id) if p.parent_id else None
    inherited = {k: parent.id for k in (parent.environments if parent else {}) if k not in p.environments}
    return {
        **asdict(p),
        "environments": effective_environments(store, p),
        "own_environments": p.environments,
        "inherited_environments": inherited,
        "parent_name": parent.name if parent else "",
        "children": store.child_ids(p.id) if is_group(p) else [],
    }


def scope_ids(store: Store, project_id: str) -> list[str]:
    """大项目自身 + 全部子项目（用于汇总用量与共享预算）。"""
    return [project_id, *store.child_ids(project_id)]
