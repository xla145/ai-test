# Entity 与 Mapper

位置：`runjian-modules/runjian-{module}/src/main/java/{packagePath}/domain` 和 `mapper`。默认由所属业务模块拥有；只有明确规划的通用 ORM 模块才集中存放指定范围内的 Model/Mapper。

## 归属与查询规则

- 先按表名和领域对象查重，确认没有其他模块已经创建同一表的 Model/Mapper；不能因新增功能重复定义。
- 单表查询直接调用该表对应 Mapper 的条件方法或 `BaseMapper`/`BaseMapperPlus` 能力，不在 Mapper 中为简单条件再包一层 `@Select` SQL，也不在 Service 中执行 SQL。
- Mapper 与 Model 一一对应，一般只映射一张表。多表关联、聚合或跨表权限判断才单独建立汇合 Mapper，并明确其返回对象和用途。
- 通用 ORM 模块只存放已确认要复用的 Model/Mapper；业务 Service、Controller、BO/VO、审计处理器和不在范围内的表留在业务模块。
- Model 字段必须逐项对照 DDL：列名、类型、长度、可空性、基类继承字段、租户字段、逻辑删除字段和主键策略都要核对，不能只按 Java 命名猜测。

以下为租户实体的结构片段，`{Entity}`、`{table_name}` 等需替换；补齐实际业务字段、import、序列化约定。平台共享实体按模型选 BaseEntity，不机械增加 tenantId。

```java
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;
import lombok.EqualsAndHashCode;
import org.dromara.common.tenant.core.TenantEntity;

@Data
@EqualsAndHashCode(callSuper = true)
@TableName("{table_name}")
public class {Entity} extends TenantEntity {
    @TableId(value = "id", type = IdType.ASSIGN_ID)
    private Long id;

    // 按字段契约补齐业务字段。

    @TableLogic
    private String delFlag;
}
```

此处 String delFlag 适配新表 CHAR(1) 约定；有效/删除值必须与配置、DDL 一致，必要时在注解中明确，不改已有实体类型。继承的审计和租户字段不要重复声明。

```java
import org.apache.ibatis.annotations.Mapper;
import org.dromara.common.mybatis.core.mapper.BaseMapperPlus;
// 导入当前模块的 Entity 和 Vo。

@Mapper
public interface {Entity}Mapper extends BaseMapperPlus<{Entity}, {Entity}Vo> {
}
```

简单查询使用 LambdaQueryWrapper 和 `selectVoById/selectVoList/selectVoPage`。复杂关联、聚合 SQL 放在 `src/main/resources/mapper/{module}/*Mapper.xml`，namespace 与方法签名保持一致。自定义 SQL 需单独确认租户、归属、逻辑删除与分页计数，不假设继承 BaseMapperPlus 会修正任意 SQL。

字段类型由契约决定：金额 BigDecimal、业务时间对齐现有 Date/LocalDateTime 和数据库 DATETIME；枚举值跟随数据库和 API，不将所有状态统一改成 Integer。
