# Controller 模板

通常继承 `org.dromara.common.web.core.BaseController`，使用 `@Validated`、`@RequiredArgsConstructor`、`@RestController`；构造器注入业务 Service。仅做参数校验、响应适配和编排。

以下为方法片段，需补齐实际类、import、业务权限与 Service；已有接口路径保持兼容。

```java
@SaCheckPermission("{module}:{feature}:list")
@GetMapping("/list")
public TableDataInfo<{Entity}Vo> list({Entity}Bo bo, PageQuery pageQuery) {
    return service.queryPageList(bo, pageQuery);
}

@SaCheckPermission("{module}:{feature}:query")
@GetMapping("/{id}")
public R<{Entity}Vo> getInfo(@NotNull @PathVariable Long id) {
    return R.ok(service.queryById(id));
}

@SaCheckPermission("{module}:{feature}:add")
@Log(title = "{业务名称}", businessType = BusinessType.INSERT)
@RepeatSubmit
@PostMapping
public R<Void> add(@Validated(AddGroup.class) @RequestBody {Entity}Bo bo) {
    return toAjax(service.insertByBo(bo));
}

@SaCheckPermission("{module}:{feature}:edit")
@Log(title = "{业务名称}", businessType = BusinessType.UPDATE)
@RepeatSubmit
@PutMapping
public R<Void> edit(@Validated(EditGroup.class) @RequestBody {Entity}Bo bo) {
    return toAjax(service.updateByBo(bo));
}

@SaCheckPermission("{module}:{feature}:remove")
@Log(title = "{业务名称}", businessType = BusinessType.DELETE)
@DeleteMapping("/{ids}")
public R<Void> remove(@NotEmpty @PathVariable Long[] ids) {
    return toAjax(service.deleteWithValidByIds(List.of(ids), true));
}
```

默认类路径可参考 `/{module}/{feature}`；状态操作和门户接口沿用各模块设计。分页直接返回 TableDataInfo，普通结果用 R，不另建响应体系。创建需要返回 ID 时按契约使用对应 VO，而不是机械使用 R<Void>。

权限注解来自 `cn.dev33.satoken.annotation.SaCheckPermission`；日志和幂等注解来自 common-log/common-idempotent，校验使用 jakarta.validation。权限码需对齐菜单/角色配置；有需要时提供相应迁移，不能仅写注解就声称角色已可用。

用中文 Javadoc 描述接口、字段及约束，沿用当前文档生成机制。不要给每个方法增加宽泛 try/catch，不返回系统异常原文。导出、匿名访问和字典接口按实际需求增加；不能为调通接口扩大 security.excludes。
