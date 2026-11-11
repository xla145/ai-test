# 当前项目约定

以下路径相对于 `rundo_platform_java`，是源码导航而非永久不变的架构快照。先确认路径存在，并以目标模块当前实现为准。

| 项目 | 当前约定与核实位置 |
|---|---|
| 构建 | 根 `pom.xml`：Java 17、Spring Boot 3.5.15、MyBatis-Plus 3.5.16；继承项目 POM，不另建 Spring Boot parent |
| 模块 | `runjian-modules/runjian-*`；聚合清单读 `runjian-modules/pom.xml` |
| 公共组件 | `runjian-common/runjian-common-*`；启动与配置在 `runjian-admin` |
| 包名 | 多数 `org.dromara.<业务域>`；知识库等存在 `com.runjian`，沿用目标模块 |
| 分层 | `controller`、`domain`、`domain/bo`、`domain/vo`、`domain/enums`、`mapper`、`service/impl` |
| 响应 | `org.dromara.common.core.domain.R`；分页 `org.dromara.common.mybatis.core.page.TableDataInfo`、`PageQuery` |
| 实体基类 | `org.dromara.common.mybatis.core.domain.BaseEntity`；租户实体 `org.dromara.common.tenant.core.TenantEntity` |
| Mapper | `org.dromara.common.mybatis.core.mapper.BaseMapperPlus<Entity, Vo>`；已有特殊 Mapper 保留 |
| 转换 | Model/Entity、BO、VO 统一使用 MapStruct Plus 的 `@AutoMapper` + `org.dromara.common.core.utils.MapstructUtils`，查询可直接用 `BaseMapperPlus.selectVo*`；禁止自行实现对象转换或逐字段复制 |
| 安全 | Sa-Token、`org.dromara.common.satoken.utils.LoginHelper`、租户及数据权限组件 |
| 异常 | `org.dromara.common.core.exception.ServiceException`、全局处理器及模块专用异常 |
| 日志 | `@Log` + `BusinessType` 枚举；需要防重复提交的接口使用 `@RepeatSubmit` |
| 文档 | Javadoc 经 therapi/springdoc 生成；有 HTTP 接口的新模块检查 `group-configs` |
| 数据库 | Flyway，位置及命名见 [SQL](sql-template.md) |

## 参考代码的使用方式

- 标准 CRUD 结构：`runjian-modules/runjian-operation/src/main/java/org/dromara/operation/` 下 `HelpDoc` 对应 Controller、BO、VO、Mapper、Service。
- `HelpDoc` 的租户排除表补偿、字段类型、删除校验 TODO 是该实现的具体情况，不是新模块规范；不得照搬 TODO 或把例外推广。
- 复杂业务优先查目标模块同类流程，例如 catalog 的审核/状态逻辑、feature 的独立操作 BO；不复制整套业务字段。
- `runjian-demo` 仅用于理解框架能力，不承载业务。`legacy` 不作为当前实现来源。
- 跨模块交互沿用公开 Service、端口或事件；先核对依赖方向，避免循环依赖。

## 数据模型与接口

新业务表通常采用 Long 雪花 ID，`BaseEntity` 提供 `createDept/createBy/createTime/updateBy/updateTime`，数据库对应蛇形列名。不要再生成 UUID、creator/updater 或毫秒审计字段。实际 ID 策略和时间类型按当前表确认。

新增逻辑删除字段通常为 `del_flag CHAR(1)`，但已有实体类型和值存在差异；核对 `@TableLogic`、MyBatis-Plus 配置与迁移，不能全项目硬编码 0/1 或 0/2。逻辑删除不自动消除唯一索引冲突。

19 位 ID 的对外传输保持项目字符串序列化策略，检查公共 Jackson 配置及实际响应，不能仅因 Java 是 Long 就让前端按 Number 处理。JSON 命名沿用现有接口，不强制 snake_case。

## 租户与审计

读取 `application.yml` 的 `tenant` 配置、租户处理器和 `InjectionMetaObjectHandler`。先区分租户隔离、个人私有、平台共享数据，再选择基类与查询条件。新增租户表不能为了绕过报错加入 `tenant.excludes`。

需要归属的写入从可信上下文显式确定 tenantId；更新条件限制数据范围，不能通过更新 tenantId 转移归属。排除表、原生 SQL、异步任务不能假设插件兜底。BO 继承 BaseEntity 时特别检查审计字段不会经 Mapstruct 覆盖数据库字段。

项目说明中的历史模块数量、绝对路径及扫描表达式可能过期。当前启动类扫描 `org.dromara` 和 `com.runjian`，Mapper 配置也含两者；新增模块仍需核实配置和实际依赖。
