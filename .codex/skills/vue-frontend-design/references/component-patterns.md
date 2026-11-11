# Component Extraction Best Practices

## When to Extract a Component

Extract a reusable component when:

1. **The dialog/drawer is complex** (>100 lines of template)
2. **The same UI pattern is used in multiple places**
3. **The component has independent logic** (its own state, API calls, validation)
4. **You want to test the component in isolation**

## Component Props & Emits Pattern

### Dialog Component

**TaskDialog.vue:**
```vue
<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage } from 'element-plus'
import type { FormInstance } from 'element-plus'
import { useTasksStore } from '@/stores/tasks'
import type { Task, TaskCreateBody, TaskUpdateBody } from '@/api/types'

interface Props {
  modelValue: boolean          // v-model binding
  task?: Task | null           // Optional task for edit mode
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void  // Close dialog
  (e: 'success'): void                             // After successful save
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const tasksStore = useTasksStore()
const formRef = ref<FormInstance>()
const loading = ref(false)

const isEdit = computed(() => !!props.task?.id)
const dialogTitle = computed(() => isEdit.value ? '编辑任务' : '新建任务')

const form = ref<TaskCreateBody & TaskUpdateBody>({
  name: '',
  description: ''
})

// Watch for dialog open/close to initialize form
watch(() => props.modelValue, (visible) => {
  if (visible) {
    if (props.task) {
      // Edit mode: populate form
      form.value = {
        name: props.task.name,
        description: props.task.description
      }
    } else {
      // Create mode: reset form
      form.value = {
        name: '',
        description: ''
      }
    }
    formRef.value?.clearValidate()
  }
})

async function submit() {
  if (!formRef.value) return

  await formRef.value.validate(async (valid) => {
    if (!valid) return

    loading.value = true
    try {
      if (isEdit.value && props.task) {
        await tasksStore.update(props.task.id, form.value)
        ElMessage.success('更新成功')
      } else {
        await tasksStore.create(form.value as TaskCreateBody)
        ElMessage.success('创建成功')
      }

      emit('success')           // Notify parent
      emit('update:modelValue', false)  // Close dialog
    } catch (error: any) {
      ElMessage.error(error.message || '操作失败')
    } finally {
      loading.value = false
    }
  })
}

function handleClose() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="600px"
    @close="handleClose"
  >
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="100px"
    >
      <el-form-item label="名称" prop="name">
        <el-input v-model="form.name" />
      </el-form-item>
      <!-- More fields... -->
    </el-form>

    <template #footer>
      <el-button @click="handleClose">取消</el-button>
      <el-button type="primary" :loading="loading" @click="submit">
        确定
      </el-button>
    </template>
  </el-dialog>
</template>
```

**Usage in Parent:**
```vue
<script setup lang="ts">
import { ref } from 'vue'
import TaskDialog from '@/components/admin/TaskDialog.vue'

const dialogVisible = ref(false)
const currentTask = ref<Task | null>(null)

function openCreate() {
  currentTask.value = null
  dialogVisible.value = true
}

function openEdit(row: Task) {
  currentTask.value = row
  dialogVisible.value = true
}

async function handleSuccess() {
  // Refresh list after successful create/update
  await tasksStore.fetchList({ force: true })
}
</script>

<template>
  <div class="page">
    <el-button type="primary" @click="openCreate">新建</el-button>

    <el-table :data="tableData">
      <el-table-column label="操作">
        <template #default="{ row }">
          <el-button link @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <TaskDialog
      v-model="dialogVisible"
      :task="currentTask"
      @success="handleSuccess"
    />
  </div>
</template>
```

**Key Points:**
- Use `modelValue` prop for v-model binding
- Emit `update:modelValue` to close dialog
- Emit `success` event for parent to handle post-save actions
- Use `watch` to initialize form when dialog opens
- Separate create/edit logic with computed `isEdit`
- Clear validation on dialog open

---

## Drawer Component

**UserDetailDrawer.vue:**
```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useUsersStore } from '@/stores/users'
import type { User } from '@/api/types'

interface Props {
  modelValue: boolean
  userId: number | null
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const usersStore = useUsersStore()
const loading = ref(false)
const user = ref<User | null>(null)

// Fetch user detail when userId changes
watch(() => props.userId, async (id) => {
  if (id && props.modelValue) {
    loading.value = true
    try {
      user.value = await usersStore.fetchById(id)
    } catch (error) {
      ElMessage.error('加载失败')
    } finally {
      loading.value = false
    }
  }
}, { immediate: true })

function handleClose() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    title="用户详情"
    :size="600"
    @close="handleClose"
  >
    <div v-loading="loading" class="drawer-content">
      <el-descriptions v-if="user" :column="2" border>
        <el-descriptions-item label="姓名">
          {{ user.name }}
        </el-descriptions-item>
        <el-descriptions-item label="邮箱">
          {{ user.email }}
        </el-descriptions-item>
        <!-- More fields... -->
      </el-descriptions>
    </div>

    <template #footer>
      <el-button @click="handleClose">关闭</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.drawer-content {
  padding: 0 20px;
  min-height: 200px;
}
</style>
```

**Usage:**
```vue
<script setup lang="ts">
import { ref } from 'vue'
import UserDetailDrawer from '@/components/admin/UserDetailDrawer.vue'

const drawerVisible = ref(false)
const currentUserId = ref<number | null>(null)

function openDetail(row: User) {
  currentUserId.value = row.id
  drawerVisible.value = true
}
</script>

<template>
  <div>
    <el-table :data="users">
      <el-table-column label="操作">
        <template #default="{ row }">
          <el-button link @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <UserDetailDrawer
      v-model="drawerVisible"
      :user-id="currentUserId"
    />
  </div>
</template>
```

---

## Component Directory Structure

```
front/src/components/
├── admin/                    # Admin-specific components
│   ├── UserDialog.vue
│   ├── UserDetailDrawer.vue
│   ├── TaskDialog.vue
│   ├── TaskHistoryDrawer.vue
│   └── AssignRoleDialog.vue
├── common/                   # Shared across modules
│   ├── PageHeader.vue
│   ├── SearchBar.vue
│   └── StatusTag.vue
├── layout/                   # Layout components
│   ├── MainLayout.vue
│   ├── Sidebar.vue
│   └── Navbar.vue
└── auth/                     # Auth-specific
    └── ProtectedRoute.vue
```

---

## Naming Conventions

### Component Files
- Use PascalCase: `UserDialog.vue`, `TaskHistoryDrawer.vue`
- Suffix with component type: `*Dialog.vue`, `*Drawer.vue`, `*Form.vue`

### Props & Events
```typescript
// Props: camelCase
interface Props {
  modelValue: boolean
  userId: number | null
  maxItems?: number
}

// Events: kebab-case when emitting
emit('update:modelValue', false)
emit('success')
emit('item-selected', item)
```

### Store References
```typescript
// Use descriptive names
const usersStore = useUsersStore()  // ✅
const store = useUsersStore()       // ❌ Too generic
```

---

## Props Best Practices

### Use Optional Props with Defaults

```typescript
interface Props {
  title?: string
  size?: 'small' | 'default' | 'large'
  showFooter?: boolean
}

// With defaults
withDefaults(defineProps<Props>(), {
  title: '详情',
  size: 'default',
  showFooter: true
})
```

### Validate Prop Types

```typescript
interface Props {
  userId: number         // Required number
  userName?: string      // Optional string
  roles: string[]        // Required array
  config?: Record<string, any>  // Optional object
}
```

### Avoid Mutating Props

```vue
<script setup lang="ts">
// ❌ Bad: Mutating prop directly
const props = defineProps<{ user: User }>()
props.user.name = 'New Name'  // Don't do this!

// ✅ Good: Create local copy
const localUser = ref({ ...props.user })
localUser.value.name = 'New Name'
</script>
```

---

## Event Handling Patterns

### Multiple Events

```typescript
interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'success', id: number): void
  (e: 'error', error: Error): void
  (e: 'item-selected', item: any): void
}

const emit = defineEmits<Emits>()

// Usage
emit('success', newId)
emit('item-selected', selectedItem)
```

### Event with Payload

```typescript
// In component
interface ItemPayload {
  id: number
  action: 'edit' | 'delete'
}

interface Emits {
  (e: 'action', payload: ItemPayload): void
}

emit('action', { id: 123, action: 'edit' })

// In parent
function handleAction(payload: ItemPayload) {
  if (payload.action === 'edit') {
    openEdit(payload.id)
  } else {
    handleDelete(payload.id)
  }
}
```

---

## Slot Patterns

### Named Slots for Customization

```vue
<!-- Component: CustomCard.vue -->
<template>
  <div class="custom-card">
    <div class="card-header">
      <slot name="header">
        <h3>{{ title }}</h3>
      </slot>
    </div>
    <div class="card-body">
      <slot />  <!-- Default slot -->
    </div>
    <div v-if="$slots.footer" class="card-footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<!-- Usage -->
<CustomCard>
  <template #header>
    <div style="display: flex; justify-content: space-between">
      <h3>Custom Title</h3>
      <el-button>Action</el-button>
    </div>
  </template>

  <p>Card content goes here</p>

  <template #footer>
    <el-button>Cancel</el-button>
    <el-button type="primary">Save</el-button>
  </template>
</CustomCard>
```

### Scoped Slots for Data Passing

```vue
<!-- Component: DataList.vue -->
<template>
  <div class="data-list">
    <div v-for="item in items" :key="item.id">
      <slot :item="item" :index="items.indexOf(item)">
        {{ item.name }}
      </slot>
    </div>
  </div>
</template>

<!-- Usage -->
<DataList :items="users">
  <template #default="{ item, index }">
    <div>{{ index + 1 }}. {{ item.name }} ({{ item.email }})</div>
  </template>
</DataList>
```

---

## Component Communication Summary

| Method | Use Case | Example |
|--------|----------|---------|
| **Props** | Parent → Child data | `:user="currentUser"` |
| **Emits** | Child → Parent events | `@success="handleSuccess"` |
| **v-model** | Two-way binding | `v-model="dialogVisible"` |
| **Slots** | Parent → Child template | `<template #header>...</template>` |
| **Provide/Inject** | Ancestor → Descendant (avoid prop drilling) | `provide('theme', theme)` |
| **Store** | Global state | `useUsersStore()` |

---

## Testing Component Isolation

Well-extracted components should be testable in isolation:

```typescript
// TaskDialog.test.ts
import { mount } from '@vue/test-utils'
import TaskDialog from '@/components/admin/TaskDialog.vue'

describe('TaskDialog', () => {
  it('should show create mode when no task provided', () => {
    const wrapper = mount(TaskDialog, {
      props: {
        modelValue: true,
        task: null
      }
    })
    expect(wrapper.text()).toContain('新建任务')
  })

  it('should show edit mode when task provided', () => {
    const wrapper = mount(TaskDialog, {
      props: {
        modelValue: true,
        task: { id: 1, name: 'Test Task' }
      }
    })
    expect(wrapper.text()).toContain('编辑任务')
  })

  it('should emit success on save', async () => {
    const wrapper = mount(TaskDialog, {
      props: { modelValue: true }
    })

    // Fill form and submit
    await wrapper.find('form').trigger('submit')

    expect(wrapper.emitted('success')).toBeTruthy()
  })
})
```

---

## Component Extraction Checklist

Before extracting a component, ask:

- [ ] Is it used in multiple places or likely to be?
- [ ] Does it have clear input (props) and output (events)?
- [ ] Can it function independently with its own logic?
- [ ] Is the component size manageable (< 300 lines)?
- [ ] Does extraction improve code readability?
- [ ] Is it easier to test in isolation?

If you answer "yes" to most questions, extract the component!
