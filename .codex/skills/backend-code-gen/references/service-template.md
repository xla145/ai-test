# Service 模板

优先沿用目标模块的接口与实现。普通 CRUD 常见 `I{Entity}Service` + `{Entity}ServiceImpl implements I{Entity}Service`，构造器注入 Mapper；不要为了模板强行继承 MyBatis-Plus ServiceImpl，也不为内部小辅助类新增无用途接口。

Service 只编排业务规则、权限/租户校验、事务和 Mapper 调用。禁止在 Service 中直接执行 SQL、拼接 SQL 或通过 `JdbcTemplate`/`@Select` 等方式绕过对应表 Mapper；单表条件使用该表 Mapper 的 Wrapper 查询。多表场景使用职责明确的汇合 Mapper，避免把多个表的 SQL 塞进一个单表 Mapper。

以下是可选的方法形态，仅保留用户需要的操作：

```java
{Entity}Vo queryById(Long id);
TableDataInfo<{Entity}Vo> queryPageList({Entity}Bo bo, PageQuery pageQuery);
List<{Entity}Vo> queryList({Entity}Bo bo);
Boolean insertByBo({Entity}Bo bo);
Boolean updateByBo({Entity}Bo bo);
Boolean deleteWithValidByIds(Collection<Long> ids, Boolean isValid);
```

分页片段（方法内还需加入该业务的数据范围条件）：

```java
LambdaQueryWrapper<{Entity}> query = Wrappers.lambdaQuery();
// 根据 BO 加可选筛选、可信归属条件及稳定排序。
Page<{Entity}Vo> page = baseMapper.selectVoPage(pageQuery.build(), query);
return TableDataInfo.build(page);
```

公共类：`org.dromara.common.mybatis.core.page.PageQuery/TableDataInfo`、`org.dromara.common.core.utils.MapstructUtils`、`org.dromara.common.core.exception.ServiceException`、`org.dromara.common.satoken.utils.LoginHelper`。

## 写操作的实现顺序

1. 验证操作权限所需的业务前置条件及可信身份/租户上下文。
2. 对象转换统一调用 `MapstructUtils.convert`，查询 VO 优先使用 Mapper 的 `selectVo*`；不得手写 Converter、toVo/fromBo 或逐字段复制。通过框架映射配置限定可写字段，转换后检查结果；审计字段交给现有填充机制。BO 继承基类时不能任由继承字段被复制。
3. 创建使用项目 ID 生成器；客户端不能指定或覆盖新记录 ID。需租户归属时从可信上下文赋值，缺失则报错。
4. 更新、删除以 ID + 必要归属 + 有效记录/原状态条件执行，检查影响行数；仅“先查属于自己，再无条件更新”不能解决并发变化。
5. 校验关联对象归属、唯一性、状态及引用。唯一约束作为并发兜底，异常转换沿用项目处理器。
6. 多表写入使用 `@Transactional(rollbackFor = Exception.class)`，确认经 Spring 代理调用；禁止吞异常后返回成功。数据库以外的消息/外部调用按既有提交后事件或补偿机制处理。

`isValid` 不是允许用户绕过校验的开关，不暴露为请求参数；不能留下“TODO 删除校验”就交付。批量删除根据契约检查是否允许部分成功。状态流转独立操作，不让通用 updateByBo 任意更改内部状态。

枚举转换、文件归属和批量读取见 [CRUD](crud-template.md)、[正确性](correctness.md)。
