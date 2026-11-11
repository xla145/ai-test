# View Structure Checklist

## Component Structure

| Section | Required | Purpose |
|---------|----------|---------|
| **Template** | Yes | DOM structure with standard page layout |
| **Script Setup** | Yes | TypeScript with Composition API (`<script setup lang="ts">`) |
| **Styles** | Yes | Scoped styles for component-specific CSS |

---

## Script Setup Structure

### 1) Imports

```typescript
// Core Vue
import { ref, onMounted } from 'vue'
import { storeToRefs } from 'pinia'

// Element Plus
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'

// Store
import { useEntityStore } from '@/stores/entity'

// Types
import type { Entity, EntityCreateBody } from '@/api/types'
```

### 2) Store Setup

**Always use `storeToRefs` for reactive destructuring:**

```typescript
const entityStore = useEntityStore()
const { entities, loading, pagination, filters } = storeToRefs(entityStore)
```

**❌ Don't:**
```typescript
const { entities } = entityStore  // Not reactive!
```

### 3) Local State

| State | Type | Purpose |
|-------|------|---------|
| `dialogVisible` | `ref<boolean>` | Control dialog visibility |
| `dialogTitle` | `ref<string>` | Dialog title (新建/编辑) |
| `formRef` | `ref<FormInstance>` | Form instance for validation |
| `formLoading` | `ref<boolean>` | Form submission loading state |
| `editId` | `ref<number \| null>` | ID of entity being edited |
| `form` | `ref<FormData>` | Form data object |

### 4) CRUD Handlers

Required handlers for standard CRUD views:

- [ ] `fetchList()` - Load data from API
- [ ] `handleSearch()` - Search/filter data
- [ ] `openCreate()` - Open create dialog
- [ ] `openEdit(row)` - Open edit dialog with row data
- [ ] `submitForm()` - Submit create/update
- [ ] `handleDelete(row)` - Delete with confirmation
- [ ] `handlePageChange(page)` - Pagination control
- [ ] `handlePageSizeChange(size)` - Page size control

### 5) Error Handling Pattern

**Always use try-catch with type-safe error messages:**

```typescript
try {
  await entityStore.someAction()
  ElMessage.success('操作成功')
} catch (e: unknown) {
  ElMessage.error(e instanceof Error ? e.message : '操作失败')
}
```

### 6) Lifecycle

```typescript
onMounted(fetchList)  // Initialize data on mount
```

---

## Template Structure

### Page Layout Hierarchy

```
.page                          // Main container
  .page-header                 // Title and primary action
  .page-card                   // Content card
    .page-card__header         // Card title and actions
    .page-card__body           // Card content
      .filter-bar              // Search/filter form
      el-table                 // Data table
      .pagination-bar          // Pagination controls
  el-dialog                    // Modal dialogs
```

### Required Layout Classes

| Class | Purpose |
|-------|---------|
| `.page` | Main page container with padding |
| `.page-header` | Page title and primary action button |
| `.page-card` | White background content card |
| `.page-table` | Full-width table |
| `.pagination-bar` | Right-aligned pagination |
| `.filter-bar` | Search/filter form container |

### Table Configuration

**Standard table props:**

```vue
<el-table
  v-loading="loading"
  :data="tableData"
  border
  stripe
  class="page-table"
>
```

**Actions column:**

```vue
<el-table-column label="操作" width="200" fixed="right">
  <template #default="{ row }">
    <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
    <el-button link type="danger" @click="handleDelete(row)">删除</el-button>
  </template>
</el-table-column>
```

### Pagination Configuration

```vue
<el-pagination
  v-model:current-page="pagination.page"
  v-model:page-size="pagination.pageSize"
  :total="pagination.total"
  layout="total, sizes, prev, pager, next"
  @current-change="handlePageChange"
  @size-change="handlePageSizeChange"
/>
```

### Dialog Structure

```vue
<el-dialog
  v-model="dialogVisible"
  :title="dialogTitle"
  width="480px"
  @close="formRef?.resetFields()"
>
  <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
    <!-- Form items -->
  </el-form>
  <template #footer>
    <el-button @click="dialogVisible = false">取消</el-button>
    <el-button type="primary" :loading="formLoading" @click="submitForm">
      确定
    </el-button>
  </template>
</el-dialog>
```

---

## Form Validation

### Rules Definition

```typescript
const rules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '请输入正确的邮箱地址', trigger: 'blur' }
  ],
}
```

### Submit Handler Pattern

```typescript
async function submitForm() {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) return

    formLoading.value = true
    try {
      if (editId.value != null) {
        await entityStore.update(editId.value, form.value)
        ElMessage.success('更新成功')
      } else {
        await entityStore.create(form.value)
        ElMessage.success('创建成功')
      }
      dialogVisible.value = false
    } catch (e: unknown) {
      ElMessage.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      formLoading.value = false
    }
  })
}
```

---

## Styles

### Scoped Styles Pattern

```vue
<style scoped>
.page {
  padding: 0 4px;
}
.page-table {
  width: 100%;
}
</style>
```

---

## Generation Checklist

Before completing a view component, verify:

- [ ] Uses `<script setup lang="ts">` with TypeScript
- [ ] Imports store with `storeToRefs` for reactive state
- [ ] Defines all required local state (dialog, form, loading)
- [ ] Implements all CRUD handlers with error handling
- [ ] Uses `ElMessage` for user feedback
- [ ] Uses `ElMessageBox.confirm` for delete confirmations
- [ ] Follows standard page layout structure
- [ ] Table has `border`, `stripe`, and `v-loading` props
- [ ] Pagination uses two-way binding with proper events
- [ ] Dialog resets form on close
- [ ] Form has validation rules
- [ ] Submit handler checks for both create and update
- [ ] Initializes data in `onMounted`
- [ ] Includes scoped styles
