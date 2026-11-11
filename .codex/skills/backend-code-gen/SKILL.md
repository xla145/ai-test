---
name: backend-code-gen
description: 为湾区项目 rundo_platform_java（RuoYi-Vue-Plus、Spring Boot、MyBatis-Plus、Sa-Token）新增或扩展后端业务功能，按现有模块生成 Controller、BO/VO、Service、Mapper 和必要 Flyway 迁移。适用于 CRUD、查询、字典、主子表及业务接口开发。
---

# 后端业务代码生成

默认目标为工作区中的 `rundo_platform_java`。生成与当前代码一致的业务功能，不把一个新功能自动变成新 Maven 模块。用户指定其他工程时重新核实约定，不直接套用本项目模板。

## 开始前

1. 定位后端根目录，读取适用的 AGENTS.md、项目说明（本项目为 `CLAUDE.md`）、目标模块规范及相关设计。只读取实际存在的文件；说明中的旧绝对路径、模块数量和版本以源码为准。
2. 运行只读探测：`python3 <skill目录>/scripts/inspect-project.py --root <后端根目录>`。支持传工作区根目录，但存在多个候选项目时应明确选择。
3. 先读 [项目约定](references/project-conventions.md)，再阅读目标功能的 Controller → Service → Mapper → Entity/BO/VO、相关迁移和测试。优先目标模块，其次职责相近模块；不要参考 legacy、归档或仅有 package-info 的空壳。
4. 确定是已有模块扩展还是确需新建 Maven 模块，记录字段、操作、数据归属、事务范围和修改文件。影响接口或数据模型的必要信息缺失时澄清，其余按源码实施，不额外增加审批流程。

只有技能、没有源码时可输出标注假设的草案，不声称完成集成或编译。

## 按任务读取

涉及字段或接口时读取 [业务契约](references/contract.md)，按需读取以下文档，不一次加载全部模板。

| 场景 | 参考 | 范围 |
|---|---|---|
| 标准 CRUD | [CRUD](references/crud-template.md)、对应分层模板 | 用户要求的接口、必要迁移 |
| 已有接口或字段调整 | 对应分层模板、[SQL](references/sql-template.md) | 沿用已有路径、命名和兼容约束 |
| 只读/统计 | CRUD、Service、BO/VO | 仅查询，不补写接口和表 |
| 字典/下拉 | [枚举与字典](references/constants-template.md) | 先判断系统字典还是代码枚举 |
| 主子表/文件引用/状态变化 | CRUD、[正确性](references/correctness.md) | 归属、事务、并发和删除语义 |
| 新 Maven 模块 | [POM](references/pom-template.md) | 聚合、依赖、扫描及文档分组 |

分层模板：[Entity/Mapper](references/entity-mapper-template.md) · [BO/VO](references/dto-templates.md) · [Service](references/service-template.md) · [Controller](references/controller-template.md)。模板占位符和示例字段仅用于展示结构，交付代码必须替换、裁剪并补齐实现。

## 数据访问与模块边界

- Service 层不编写 SQL，不使用 `@Select`/`@Insert`/`@Update`/`@Delete`，也不通过字符串拼接 SQL 查询。单表读写直接注入并调用该表对应的 Model/Entity Mapper，通过 `LambdaQueryWrapper`、`QueryWrapper` 或项目已有的 `selectVo*` 方法表达条件。
- 一个 Mapper 默认只负责一个 Model/Entity 和对应的一张表。只有确实需要多表关联、聚合或跨表权限校验时，才新增职责明确的汇合 Mapper；不要把多个单表查询集中到一个“万能” Mapper，也不要在 Service 中用多段 SQL 模拟它。
- 新增 Model/Mapper 前先按表名、类名和包名全仓查重，确认其他模块没有已有实现；字段、列名、类型、可空性、基类和索引必须与实际 DDL 对齐。
- 只有用户明确要求或确有跨模块复用边界时才建立通用 ORM 模块。该模块只放约定范围内的 Model/Entity 与对应 Mapper，不放 Service、Controller、业务 DTO、审计处理器或无关表；消费模块通过依赖使用它们。
- 具体功能范围以用户指定的方案/文档为准。迁移一个功能时只改该功能需要的表和引用，既有表、既有模型及其他登录/认证流程不因“顺手统一”而移动或重构。
- SQL 按功能模块统一交付：同一功能的建表、结构修改、约束/索引和必要初始化数据合并到同一份版本迁移中；不要按单表、单字段或初始化数据另起 SQL 文件。不同数据库方言分别保留对应脚本，已执行的迁移不得回改。
- 生成代码交付前必须格式化并做空白检查：Java 统一 4 个空格缩进、禁止 Tab，采用项目现有大括号和 import 分组风格；多行方法链、参数和条件按层级缩进，禁止多条语句同行。XML、YAML、SQL 同样保持层级缩进、合理换行和文件末尾换行。

## 实施与交付

1. 查重并确定模块归属，复用公共响应、基类、异常、身份工具及已有业务能力。跨业务域的业务操作优先调用公开服务/端口；用户明确规划的共享 ORM Model/Mapper 按约定依赖使用，不另建重复定义。
2. 从同一份字段与操作契约推导 Entity/Mapper、BO/VO、Service、Controller。先完成数据访问归属检查，再决定是否需要自定义 SQL；遵循目标项目测试要求。本项目业务代码按项目说明采用测试先行，针对受影响行为编写断言。
3. 检查租户、所属者、权限、系统字段和更新条件；多表操作放在有效事务边界内，状态变化检查条件更新结果。
4. 结构变化新增 Flyway 迁移；无结构变化不生成 SQL。新增 Maven 模块才注册；已有模块扩展不重复注册。
5. 按 [验证清单](references/verification.md) 验证，报告修改、接口、迁移及实际构建/测试结果。技能自身修改不等于 Java 业务改动，无需因此运行业务测试。

## 核心约束

- 用户要求和当前源码优先于模板。默认包名、接口风格、ID 和删除值不覆盖已有契约。
- `@SaCheckPermission` 是操作权限，不能替代租户与数据归属校验。继承 `TenantEntity` 也不证明租户拦截生效。
- 身份从 `LoginHelper` 等可信上下文获取；必需上下文缺失时报错，不静默使用平台租户或 system。后台任务身份需显式定义。
- Model/Entity、BO、VO 之间的对象转换统一使用项目 MapStruct Plus：`@AutoMapper`、`MapstructUtils.convert` 或 `BaseMapperPlus.selectVo*`。不自行实现 Converter/Assembler，不用逐字段 getter/setter、BeanUtils 或反射复制替代框架转换；字段差异通过框架映射配置处理。
- 审计、租户、删除标志、内部状态不允许由请求任意覆盖；映射工具不能替代字段白名单。
- 沿用全局异常处理和 `ServiceException` 或模块既有异常，不为普通接口添加统一 catch 后返回异常原文。
- 多表失败必须传播以回滚；唯一性和状态变化由数据库约束/条件更新兜底。避免分页 N+1，不把逐条 insert 称为批处理。
- 不自动执行迁移、连接共享库进行写入验证、提交或部署。启动应用可能触发 Flyway，不能把启动当成无副作用检查。
