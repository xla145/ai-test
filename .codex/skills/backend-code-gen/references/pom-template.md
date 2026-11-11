# Maven 模块接入

只有现有业务域无法承载、确需独立依赖/职责边界时新建 `runjian-modules/runjian-{module}`。已有模块新增业务不改聚合列表。若用户明确规划通用 ORM 模块，应将其作为纯 Model/Mapper 库接入，限制表范围并避免放入业务服务和接口。

最小 POM 形态：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    <parent>
        <groupId>org.dromara</groupId>
        <artifactId>runjian-modules</artifactId>
        <version>${revision}</version>
    </parent>
    <artifactId>runjian-{module}</artifactId>
    <dependencies>
        <!-- 依据实际 import 和依赖管理添加公共组件，不复制整个参考模块的依赖。 -->
    </dependencies>
</project>
```

按使用能力选择 common-core、mybatis、web、tenant、satoken、log、idempotent、doc 等已有组件，测试依赖沿用相邻模块。内部依赖版本跟随根 dependencyManagement / common BOM，不另立 Spring Boot parent 或硬编码框架版本。

## 接入检查

1. `runjian-modules/pom.xml` 添加聚合模块。
2. 根 POM 按现有方式管理新模块 `${revision}` 版本。
3. `runjian-admin/pom.xml` 或实际消费模块添加依赖；dependencyManagement 不会引入类路径。
4. 核对 `DromaraApplication` 组件扫描、`application.yml` 的 mapperPackage 和 Mapper XML 路径。
5. 模块包含 HTTP 接口时核对 springdoc group-configs；纯库不生成空接口分组。
6. 核对跨模块依赖方向和公开接口；业务操作经公开服务/端口协作。明确规划的共享 ORM Model/Mapper 可由消费模块直接依赖，不重复定义同一张表。

不生成只有 package-info 的预留模块，不为新 CRUD 新建独立启动程序。编译命令见 [验证](verification.md)。
