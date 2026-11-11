# BO / VO 模板

保留本文件名以兼容已有引用；内容采用当前项目的 `domain/bo` 和 `domain/vo`。

## 框架转换约定

Model/Entity、BO、VO 的对象及集合转换统一由 MapStruct Plus 完成：通过 `@AutoMapper` 声明关系，使用 `MapstructUtils.convert` 或 `BaseMapperPlus.selectVo*` 获取结果。不得自行实现 Converter/Assembler、手写 `toVo/fromBo` 字段复制方法，或使用 BeanUtils/反射复制绕开框架。

异名字段、忽略字段和转换方向使用当前版本支持的映射注解/配置，参考项目已有用法。缺少映射时补框架声明并验证注解处理器生成结果，不退回手写转换。关联查询结果、派生业务值及可信租户上下文可在框架转换后按业务补充，但不得借此重写基础属性映射。

## BO

普通 CRUD 可沿用同一 Bo + AddGroup/EditGroup；查询条件默认可选。创建、部分更新、状态操作差异明显时拆成独立 BO，沿用目标模块 Bo/BO 命名，不为统一大小写改旧代码。

```java
import io.github.linpeilie.annotations.AutoMapper;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import lombok.Data;
import org.dromara.common.core.validate.AddGroup;
import org.dromara.common.core.validate.EditGroup;
// 导入当前模块 Entity。

@Data
@AutoMapper(target = {Entity}.class, reverseConvertGenerate = false)
public class {Entity}Bo {
    @NotNull(groups = EditGroup.class)
    private Long id;

    // 仅当业务存在 name 且约定最大 100 字符时保留。
    @NotBlank(groups = {AddGroup.class, EditGroup.class})
    @Size(max = 100, groups = {AddGroup.class, EditGroup.class})
    private String name;
}
```

字段约束与业务契约一致；使用分组时检查所有约束所属组及嵌套 @Valid，避免声明校验但接口未触发。需要 params 等既有能力时可沿用 BaseEntity，但其系统字段不能作为可写业务字段映射。创建 ID 由服务端生成，即使共用 BO 接收了 id 也必须拒绝或清除。

## VO

```java
import io.github.linpeilie.annotations.AutoMapper;
import lombok.Data;
import java.io.Serializable;
// 导入当前模块 Entity。

@Data
@AutoMapper(target = {Entity}.class)
public class {Entity}Vo implements Serializable {
    private Long id;
    // 按列表或详情契约声明响应字段。
}
```

只暴露所需字段，不返回 Entity 代替 VO。只有需要导出时才加 Excel 注解；关联名称批量填充，不能逐行查库。映射器方向与 selectVo* 的转换需求一并验证；ID 字符串传输沿用公共 JSON 策略。

部分更新必须定义未传、null、空串/空集合的含义；普通 nullable 字段不能区分缺失与显式 null，按现有接口采用可表达字段存在性的结构，不全局放开 null 更新策略。
