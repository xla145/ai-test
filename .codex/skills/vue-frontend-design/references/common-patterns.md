# UI Pattern Library

## Display Patterns

### Status Tag

Display status with colored tags using mapping functions.

**Template:**
```vue
<el-table-column prop="status" label="状态" width="100">
  <template #default="{ row }">
    <el-tag :type="getStatusType(row.status)">
      {{ getStatusLabel(row.status) }}
    </el-tag>
  </template>
</el-table-column>
```

**Mapping Functions:**
```typescript
function getStatusType(status: string) {
  const map: Record<string, any> = {
    active: 'success',
    inactive: 'info',
    locked: 'warning',
    banned: 'danger',
  }
  return map[status] || 'info'
}

function getStatusLabel(status: string) {
  const map: Record<string, string> = {
    active: '活跃',
    inactive: '未激活',
    locked: '已锁定',
    banned: '已封禁',
  }
  return map[status] || status
}
```

| Status | Tag Type | Color |
|--------|----------|-------|
| active | success | Green |
| inactive | info | Gray |
| locked | warning | Orange |
| banned | danger | Red |

---

### Date Formatting

Format datetime strings for consistent display.

```typescript
function formatDate(date?: string) {
  if (!date) return '-'
  return new Date(date).toLocaleString('zh-CN')
}
```

```vue
<el-table-column prop="created_at" label="创建时间" width="180">
  <template #default="{ row }">
    {{ formatDate(row.created_at) }}
  </template>
</el-table-column>
```

---

### Multiple Tags

Display array of tags (e.g., roles, categories).

```vue
<el-table-column label="角色" width="200">
  <template #default="{ row }">
    <el-tag
      v-for="role in row.roles"
      :key="role.id"
      size="small"
      style="margin: 2px"
    >
      {{ role.name }}
    </el-tag>
    <span v-if="!row.roles?.length" style="color: #999">
      未分配
    </span>
  </template>
</el-table-column>
```

---

## Action Patterns

### Dropdown Menu

Use dropdown for additional actions to save space.

```vue
<el-dropdown trigger="click">
  <el-button link type="primary">
    更多<el-icon class="el-icon--right"><ArrowDown /></el-icon>
  </el-button>
  <template #dropdown>
    <el-dropdown-menu>
      <el-dropdown-item @click="handleAction1(row)">
        操作1
      </el-dropdown-item>
      <el-dropdown-item @click="handleAction2(row)">
        操作2
      </el-dropdown-item>
      <el-dropdown-item divided @click="handleDelete(row)">
        删除
      </el-dropdown-item>
    </el-dropdown-menu>
  </template>
</el-dropdown>
```

**Icon Import:**
```typescript
import { ArrowDown } from '@element-plus/icons-vue'
```

---

### Conditional Actions

Show different actions based on row data.

```vue
<el-table-column label="操作" width="240" fixed="right">
  <template #default="{ row }">
    <el-button link type="primary" @click="openEdit(row)">
      编辑
    </el-button>
    <el-button
      v-if="row.status === 'active'"
      link
      type="warning"
      @click="handleDisable(row)"
    >
      禁用
    </el-button>
    <el-button
      v-else
      link
      type="success"
      @click="handleEnable(row)"
    >
      启用
    </el-button>
    <el-button
      v-if="!row.is_system"
      link
      type="danger"
      @click="handleDelete(row)"
    >
      删除
    </el-button>
  </template>
</el-table-column>
```

**Common Conditions:**
| Condition | Use Case |
|-----------|----------|
| `v-if="row.status === 'active'"` | Status-based actions |
| `v-if="!row.is_system"` | Prevent editing system records |
| `v-if="row.created_by === currentUserId"` | Owner-only actions |

---

### Confirmation Dialog

Always confirm before destructive actions.

```typescript
async function handleDelete(row: Entity) {
  try {
    await ElMessageBox.confirm(
      `确定要删除「${row.name}」吗？此操作无法撤销。`,
      '提示',
      { type: 'warning' }
    )

    await entityStore.remove(row.id)
    ElMessage.success('删除成功')
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error.message || '删除失败')
    }
  }
}
```

**Important:** Check for `error !== 'cancel'` to avoid showing error when user cancels.

---

## Search & Filter Patterns

### Multi-Field Search Form

Standard inline search form layout.

```vue
<el-form :inline="true" class="search-form">
  <el-form-item label="名称">
    <el-input
      v-model="searchForm.name"
      placeholder="请输入名称"
      clearable
      @keyup.enter="handleSearch"
    />
  </el-form-item>
  <el-form-item label="状态">
    <el-select v-model="searchForm.status" placeholder="请选择状态" clearable>
      <el-option label="全部" value="" />
      <el-option label="活跃" value="active" />
      <el-option label="已锁定" value="locked" />
    </el-select>
  </el-form-item>
  <el-form-item>
    <el-button type="primary" @click="handleSearch">搜索</el-button>
    <el-button @click="handleReset">重置</el-button>
  </el-form-item>
</el-form>
```

**Handlers:**
```typescript
async function handleSearch() {
  try {
    await entityStore.search()
  } catch (error: any) {
    ElMessage.error(error.message || '搜索失败')
  }
}

async function handleReset() {
  entityStore.resetFilters()
  await fetchList()
}
```

**Best Practices:**
- [ ] Use `clearable` prop for inputs and selects
- [ ] Add `@keyup.enter` on text inputs for quick search
- [ ] Reset to page 1 when searching
- [ ] Clear filters completely on reset

---

## Form Patterns

### Form Dialog with Validation

Standard form dialog with validation rules.

**Dialog Template:**
```vue
<el-dialog
  v-model="dialogVisible"
  :title="dialogTitle"
  width="480px"
  @close="formRef?.resetFields()"
>
  <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
    <el-form-item label="名称" prop="name">
      <el-input v-model="form.name" placeholder="请输入名称" />
    </el-form-item>
    <el-form-item label="邮箱" prop="email">
      <el-input v-model="form.email" type="email" placeholder="请输入邮箱" />
    </el-form-item>
  </el-form>
  <template #footer>
    <el-button @click="dialogVisible = false">取消</el-button>
    <el-button type="primary" :loading="formLoading" @click="submitForm">
      确定
    </el-button>
  </template>
</el-dialog>
```

**Validation Rules:**
```typescript
const rules: FormRules = {
  name: [
    { required: true, message: '请输入名称', trigger: 'blur' },
    { min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }
  ],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱地址', trigger: 'blur' }
  ],
}
```

**Common Validation Rules:**
| Rule Type | Example |
|-----------|---------|
| Required | `{ required: true, message: '请输入...', trigger: 'blur' }` |
| Min/Max Length | `{ min: 2, max: 50, message: '长度在 2 到 50 个字符', trigger: 'blur' }` |
| Email | `{ type: 'email', message: '请输入正确的邮箱地址', trigger: 'blur' }` |
| Pattern | `{ pattern: /^[0-9]+$/, message: '请输入数字', trigger: 'blur' }` |
| Custom | `{ validator: customValidator, trigger: 'blur' }` |

---

### Radio Group

For selecting between mutually exclusive options.

```vue
<el-form-item label="类型" prop="type">
  <el-radio-group v-model="form.type">
    <el-radio-button value="menu">菜单</el-radio-button>
    <el-radio-button value="directory">目录</el-radio-button>
    <el-radio-button value="button">按钮</el-radio-button>
  </el-radio-group>
</el-form-item>
```

**Use `el-radio-button` for button style, `el-radio` for default style.**

---

### Switch with Description

Toggle with helper text for clarity.

```vue
<el-form-item label="是否可见" prop="is_visible">
  <el-switch v-model="form.is_visible" />
  <div style="color: #909399; font-size: 12px; margin-top: 4px; display: inline-block; margin-left: 12px">
    不可见的菜单仅用于权限控制
  </div>
</el-form-item>
```

---

### Number Input

For numeric fields with constraints.

```vue
<el-form-item label="排序" prop="sort_order">
  <el-input-number v-model="form.sort_order" :min="0" :max="999" />
</el-form-item>
```

**Common Props:**
| Prop | Purpose |
|------|---------|
| `:min` | Minimum value |
| `:max` | Maximum value |
| `:step` | Increment/decrement step |
| `:precision` | Decimal precision |

---

## Table Patterns

### Tree Table

For hierarchical data like menus.

```vue
<el-table
  v-loading="loading"
  :data="treeData"
  row-key="id"
  border
  stripe
  default-expand-all
  :tree-props="{ children: 'children', hasChildren: 'hasChildren' }"
  class="page-table"
>
  <el-table-column prop="name" label="名称" min-width="140" />
  <el-table-column prop="description" label="描述" />
  <!-- More columns... -->
</el-table>
```

**Key Props:**
- `row-key="id"` - Unique identifier
- `default-expand-all` - Expand all nodes by default
- `:tree-props` - Tree structure configuration

---

### Custom Empty State

Show custom empty state when no data.

```vue
<el-table
  v-loading="loading"
  :data="tableData"
  stripe
  border
  class="page-table"
>
  <template #empty>
    <el-empty description="暂无数据" />
  </template>
  <!-- Columns... -->
</el-table>
```

---

## Pattern Selection Guide

| Scenario | Recommended Pattern |
|----------|-------------------|
| Show status | Status Tag |
| Display datetime | Date Formatting |
| Multiple related items | Multiple Tags |
| Many actions | Dropdown Menu |
| Status-dependent actions | Conditional Actions |
| Delete/remove | Confirmation Dialog |
| Multi-field filter | Multi-Field Search Form |
| Create/Edit | Form Dialog |
| Yes/No option | Switch |
| Choose one from few | Radio Group |
| Numeric input | Number Input |
| Hierarchical data | Tree Table |
| No data | Custom Empty State |
