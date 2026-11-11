# 验证与交付

## 静态与契约检查

先格式化生成的 Java、XML、YAML 和 SQL，再检查 `git diff --check`。Java 使用 4 个空格、无 Tab；检查 import 分组、方法链/多行参数缩进、单行多语句和文件末尾换行。

检查包名/import、BO/VO 与 Model/Entity 转换是否使用 MapStruct Plus（无手写转换器、逐字段复制或 BeanUtils 替代）、R/TableDataInfo 签名、权限码、租户与归属、逻辑删除、审计字段、XML namespace 及 Flyway 版本冲突。不能遗留占位符、演示字段、空实现或 TODO 校验。

沿请求 → 校验 → Service → Mapper/SQL → 响应追踪一次；无结构变化不生成迁移。新 Maven 模块额外检查依赖接入、扫描和必要文档分组。

## 构建与测试

命令从 `rundo_platform_java` 根执行，优先项目 wrapper（若存在）：

```bash
mvn -pl runjian-modules/runjian-{module} -am -DskipTests compile
```

本项目根 POM 默认 skipTests=true，Surefire 还通过 `${profiles.active}` 的 groups 过滤 @Tag。运行受影响测试时显式开启测试，检查实际报告用例数；Maven profile 与 Spring @ActiveProfiles 不是同一个机制。

```bash
mvn -o -pl runjian-modules/runjian-{module} test -DskipTests=false -Dtest={受影响测试类}
```

离线命令适用于依赖已缓存的环境。兄弟模块缓存过期时需先构建相应依赖，不能为得到绿色结果继续使用旧制品。项目说明提示测试加 -am 可能触发公共模块既有测试编译问题，先核实当前状态；记录阻塞，不随意改无关模块或跳过失败测试。

按项目测试规范先写受影响业务测试，运行指定类并报告用例数；必要时选择匹配 @Tag 的 Maven profile。不要把 compile、零用例或 Tests are skipped 称为测试通过，不为保险重复跑全量。

普通 Mock 测试不证明 SQL、租户插件或事务回滚有效。涉及这些机制时使用已有隔离集成环境；未经授权不对共享数据库写入或启动会自动迁移的应用。

## 场景验收

| 请求 | 应有行为 |
|---|---|
| 已有模块加状态下拉 | 复用字典/枚举，只加必要接口，不建表或新模块 |
| 新实体 CRUD | 对齐 BO/VO、BaseMapperPlus、权限、审计、租户及 Flyway |
| 字段长度调整 | 同步校验和增量迁移，不将查询字段变为必填 |
| 备注部分更新 | 验证未传、null、空串的约定，避免全局更新策略变化 |
| 主表替换标签 | 验证归属、空集合、回滚、历史保留及批量读取 |
| 租户私有记录 | 同租户允许的操作成功；跨租户/缺少身份失败 |
| 状态变化 | 非法转换、并发冲突和受影响副作用得到验证 |

## 交付

报告行为变化、主要文件、接口与迁移，以及实际执行的编译/测试和用例数。说明依赖、测试环境等未验证项，不把静态检查写成集成通过。不自动提交、迁移或部署。
