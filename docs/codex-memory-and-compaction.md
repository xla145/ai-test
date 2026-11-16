# 项目内 Codex App Server：记忆与上下文压缩

AIProbe 启动 App Server 前通过 `desktop/src/main/codex/config.ts` 生成配置。
配置保存在应用数据目录的 `codex/config.toml`，不是用户的 `~/.codex/config.toml`；下次启动会重新生成。

默认配置（已用与项目锁定版本相同的 Codex CLI 0.167.0 严格配置校验）：

```toml
model_post_turn_compact_threshold_percent = 80

[features]
memories = true

[memories]
generate_memories = true
use_memories = true
```

- **记忆**：启用 Codex 原生的后台记忆生成及后续任务读取，不等于复用上一次 thread 的完整上下文。生成时机、筛选和可用性由 Codex 管理，不保证每次任务结束立即生成记忆。各 AIProbe 项目仍使用各自 workspace，但共用应用的 CODEX_HOME；这不是项目间的严格记忆隔离。
- **模型兼容**：指定 agent 模型时，记忆的 `extract_model` 和 `consolidation_model` 同样使用它，避免自定义供应商收到不支持的默认 OpenAI 模型请求。
- **压缩**：轮结束后达到模型上下文的 80% 时允许自动压缩；轮内沿用 Codex 的模型默认压缩阈值。不硬编码上下文长度，也不启用尚在开发中的 `async_compaction`。模型和供应商的兼容性仍影响实际压缩能否成功。
- **生效时间**：已运行的 App Server 不会热加载这项变更，应用重新构建并重启后，下一次启动 App Server 时生效。
- **用量**：后台记忆生成和压缩可能产生额外模型调用。现有桌面预算统计主要来自业务 thread 的 token 事件，不能保证涵盖独立的后台记忆任务。

本次验证配置解析、功能开关和现有协议测试，没有调用真实模型验证记忆生成或触发长上下文压缩。
