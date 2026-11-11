# Advanced Component Patterns

## Drawer (抽屉)

For detail views, history logs, or side panels without leaving the current page.

### Basic Drawer

```vue
<template>
  <div class="page">
    <!-- Main content -->
    <el-button @click="drawerVisible = true">查看详情</el-button>

    <!-- Drawer -->
    <el-drawer
      v-model="drawerVisible"
      title="详情"
      :size="600"
      direction="rtl"
    >
      <div class="drawer-content">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="姓名">{{ item.name }}</el-descriptions-item>
          <el-descriptions-item label="手机">{{ item.phone }}</el-descriptions-item>
          <el-descriptions-item label="邮箱">{{ item.email }}</el-descriptions-item>
          <el-descriptions-item label="地址" :span="2">{{ item.address }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <template #footer>
        <el-button @click="drawerVisible = false">关闭</el-button>
        <el-button type="primary" @click="handleEdit">编辑</el-button>
      </template>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const drawerVisible = ref(false)
const item = ref({ name: '', phone: '', email: '', address: '' })
</script>

<style scoped>
.drawer-content {
  padding: 0 20px;
}
</style>
```

### Component-Based Drawer

Extract drawer as a separate component for complex logic.

**UserDetailDrawer.vue:**
```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
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

const loading = ref(false)
const user = ref<User | null>(null)

watch(() => props.userId, async (id) => {
  if (id) {
    loading.value = true
    try {
      // Fetch user detail
      // user.value = await fetchUser(id)
    } finally {
      loading.value = false
    }
  }
})

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
        <el-descriptions-item label="姓名">{{ user.name }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ user.email }}</el-descriptions-item>
        <!-- More fields... -->
      </el-descriptions>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer-content {
  padding: 0 20px;
  min-height: 200px;
}
</style>
```

**Usage in parent:**
```vue
<script setup lang="ts">
import { ref } from 'vue'
import UserDetailDrawer from '@/components/admin/UserDetailDrawer.vue'

const drawerVisible = ref(false)
const currentUserId = ref<number | null>(null)

function openDetail(row: any) {
  currentUserId.value = row.id
  drawerVisible.value = true
}
</script>

<template>
  <div class="page">
    <el-table :data="tableData">
      <el-table-column label="操作">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <UserDetailDrawer v-model="drawerVisible" :user-id="currentUserId" />
  </div>
</template>
```

---

## Slider (滑块)

For numeric input with visual feedback.

```vue
<el-form-item label="优先级" prop="priority">
  <el-slider
    v-model="form.priority"
    :min="1"
    :max="10"
    show-stops
    :marks="{
      1: '低',
      5: '中',
      10: '高'
    }"
  />
</el-form-item>
```

**With input box:**
```vue
<el-slider
  v-model="form.value"
  :min="0"
  :max="100"
  show-input
  :show-input-controls="false"
/>
```

---

## Select with Advanced Features

### Multiple Selection with Create

```vue
<el-form-item label="标签" prop="tags">
  <el-select
    v-model="form.tags"
    multiple
    filterable
    allow-create
    default-first-option
    placeholder="请选择或输入标签"
    style="width: 100%"
  >
    <el-option
      v-for="tag in commonTags"
      :key="tag"
      :label="tag"
      :value="tag"
    />
  </el-select>
</el-form-item>
```

### Remote Search

```vue
<script setup lang="ts">
import { ref } from 'vue'

interface Option {
  value: number
  label: string
}

const loading = ref(false)
const options = ref<Option[]>([])

async function remoteSearch(query: string) {
  if (query) {
    loading.value = true
    try {
      // Fetch options from API
      // options.value = await searchUsers(query)
    } finally {
      loading.value = false
    }
  } else {
    options.value = []
  }
}
</script>

<template>
  <el-select
    v-model="form.userId"
    filterable
    remote
    reserve-keyword
    placeholder="搜索用户"
    :remote-method="remoteSearch"
    :loading="loading"
  >
    <el-option
      v-for="item in options"
      :key="item.value"
      :label="item.label"
      :value="item.value"
    />
  </el-select>
</template>
```

### Grouped Options

```vue
<el-select v-model="form.menuId" placeholder="选择菜单">
  <el-option-group
    v-for="group in menuGroups"
    :key="group.label"
    :label="group.label"
  >
    <el-option
      v-for="item in group.options"
      :key="item.value"
      :label="item.label"
      :value="item.value"
    />
  </el-option-group>
</el-select>
```

---

## Cascader (级联选择器)

For hierarchical data selection.

```vue
<script setup lang="ts">
import { ref } from 'vue'

const form = ref({
  categoryPath: []
})

const categoryOptions = [
  {
    value: 'electronics',
    label: '电子产品',
    children: [
      {
        value: 'phone',
        label: '手机',
        children: [
          { value: 'iphone', label: 'iPhone' },
          { value: 'android', label: 'Android' }
        ]
      },
      {
        value: 'computer',
        label: '电脑'
      }
    ]
  },
  {
    value: 'clothing',
    label: '服装'
  }
]
</script>

<template>
  <el-form-item label="分类" prop="categoryPath">
    <el-cascader
      v-model="form.categoryPath"
      :options="categoryOptions"
      :props="{ checkStrictly: true }"
      clearable
      filterable
      placeholder="请选择分类"
    />
  </el-form-item>
</template>
```

**Props options:**
- `checkStrictly: true` - Allow selecting any level
- `multiple: true` - Multiple selection
- `expandTrigger: 'hover'` - Expand on hover

---

## DatePicker / DateTimePicker

### Date Range

```vue
<el-form-item label="日期范围">
  <el-date-picker
    v-model="dateRange"
    type="daterange"
    range-separator="至"
    start-placeholder="开始日期"
    end-placeholder="结束日期"
    format="YYYY-MM-DD"
    value-format="YYYY-MM-DD"
  />
</el-form-item>
```

### DateTime with Shortcuts

```vue
<script setup lang="ts">
const shortcuts = [
  {
    text: '最近一周',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 3600 * 1000 * 24 * 7)
      return [start, end]
    }
  },
  {
    text: '最近一个月',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 3600 * 1000 * 24 * 30)
      return [start, end]
    }
  },
  {
    text: '最近三个月',
    value: () => {
      const end = new Date()
      const start = new Date()
      start.setTime(start.getTime() - 3600 * 1000 * 24 * 90)
      return [start, end]
    }
  }
]
</script>

<template>
  <el-date-picker
    v-model="form.dateTime"
    type="datetimerange"
    :shortcuts="shortcuts"
    range-separator="至"
    start-placeholder="开始时间"
    end-placeholder="结束时间"
  />
</template>
```

---

## Upload (上传)

### Image Upload with Preview

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadProps, UploadUserFile } from 'element-plus'

const fileList = ref<UploadUserFile[]>([])
const dialogImageUrl = ref('')
const dialogVisible = ref(false)

const handleRemove: UploadProps['onRemove'] = (uploadFile) => {
  console.log('Remove:', uploadFile)
}

const handlePreview: UploadProps['onPreview'] = (uploadFile) => {
  dialogImageUrl.value = uploadFile.url!
  dialogVisible.value = true
}

const handleExceed: UploadProps['onExceed'] = (files) => {
  ElMessage.warning(`最多只能上传 3 个文件`)
}

const beforeUpload: UploadProps['beforeUpload'] = (rawFile) => {
  if (rawFile.size / 1024 / 1024 > 2) {
    ElMessage.error('文件大小不能超过 2MB')
    return false
  }
  return true
}
</script>

<template>
  <el-form-item label="上传图片">
    <el-upload
      v-model:file-list="fileList"
      action="/api/upload"
      list-type="picture-card"
      :limit="3"
      :on-preview="handlePreview"
      :on-remove="handleRemove"
      :on-exceed="handleExceed"
      :before-upload="beforeUpload"
    >
      <el-icon><Plus /></el-icon>
    </el-upload>

    <el-dialog v-model="dialogVisible">
      <img :src="dialogImageUrl" alt="Preview" style="width: 100%" />
    </el-dialog>
  </el-form-item>
</template>
```

### File Upload with Custom Request

```vue
<script setup lang="ts">
import type { UploadProps } from 'element-plus'
import { uploadFile } from '@/api/files'

const handleUpload: UploadProps['httpRequest'] = async (options) => {
  const formData = new FormData()
  formData.append('file', options.file)

  try {
    const response = await uploadFile(formData)
    options.onSuccess(response)
    ElMessage.success('上传成功')
  } catch (error) {
    options.onError(error as Error)
    ElMessage.error('上传失败')
  }
}
</script>

<template>
  <el-upload
    :http-request="handleUpload"
    :show-file-list="false"
    accept=".xlsx,.xls"
  >
    <el-button type="primary">
      <el-icon><Upload /></el-icon>
      上传文件
    </el-button>
  </el-upload>
</template>
```

---

## Transfer (穿梭框)

For moving items between two lists (e.g., assigning permissions).

```vue
<script setup lang="ts">
import { ref } from 'vue'

interface Permission {
  key: number
  label: string
  disabled?: boolean
}

const value = ref<number[]>([])
const data = ref<Permission[]>([
  { key: 1, label: '用户管理' },
  { key: 2, label: '角色管理' },
  { key: 3, label: '菜单管理' },
  { key: 4, label: '系统设置', disabled: true }
])

function handleChange(value: number[], direction: 'left' | 'right', movedKeys: number[]) {
  console.log('Value:', value)
  console.log('Direction:', direction)
  console.log('Moved keys:', movedKeys)
}
</script>

<template>
  <el-transfer
    v-model="value"
    :data="data"
    :titles="['可选权限', '已选权限']"
    filterable
    filter-placeholder="搜索权限"
    @change="handleChange"
  />
</template>
```

---

## Tree (树形控件)

For hierarchical data with checkboxes.

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { ElTree } from 'element-plus'

interface TreeNode {
  id: number
  label: string
  children?: TreeNode[]
}

const treeRef = ref<InstanceType<typeof ElTree>>()
const treeData = ref<TreeNode[]>([
  {
    id: 1,
    label: '一级菜单',
    children: [
      { id: 11, label: '二级菜单 1-1' },
      { id: 12, label: '二级菜单 1-2' }
    ]
  },
  {
    id: 2,
    label: '一级菜单 2',
    children: [
      { id: 21, label: '二级菜单 2-1' }
    ]
  }
])

const defaultProps = {
  children: 'children',
  label: 'label'
}

function getCheckedKeys() {
  return treeRef.value?.getCheckedKeys()
}

function setCheckedKeys(keys: number[]) {
  treeRef.value?.setCheckedKeys(keys)
}
</script>

<template>
  <el-tree
    ref="treeRef"
    :data="treeData"
    :props="defaultProps"
    show-checkbox
    node-key="id"
    default-expand-all
  />
</template>
```

---

## Progress (进度条)

For showing upload/processing progress.

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'

const percentage = ref(0)

onMounted(() => {
  const timer = setInterval(() => {
    percentage.value += 10
    if (percentage.value >= 100) {
      clearInterval(timer)
    }
  }, 500)
})
</script>

<template>
  <div>
    <!-- Linear -->
    <el-progress :percentage="percentage" />

    <!-- With status -->
    <el-progress :percentage="100" status="success" />
    <el-progress :percentage="50" status="warning" />
    <el-progress :percentage="80" status="exception" />

    <!-- Circular -->
    <el-progress type="circle" :percentage="percentage" />

    <!-- Custom color -->
    <el-progress
      :percentage="percentage"
      :color="customColor"
    />
  </div>
</template>
```

---

## Timeline (时间线)

For activity logs or history.

```vue
<template>
  <el-timeline>
    <el-timeline-item
      v-for="activity in activities"
      :key="activity.id"
      :timestamp="activity.timestamp"
      :type="activity.type"
      :color="activity.color"
      placement="top"
    >
      <el-card>
        <h4>{{ activity.title }}</h4>
        <p>{{ activity.content }}</p>
      </el-card>
    </el-timeline-item>
  </el-timeline>
</template>

<script setup lang="ts">
const activities = [
  {
    id: 1,
    title: '创建任务',
    content: '用户创建了新任务',
    timestamp: '2024-01-01 10:00',
    type: 'primary'
  },
  {
    id: 2,
    title: '更新状态',
    content: '任务状态更新为进行中',
    timestamp: '2024-01-01 11:30',
    type: 'success'
  }
]
</script>
```

---

## Popconfirm (气泡确认框)

Lightweight alternative to MessageBox for quick confirmations.

```vue
<template>
  <el-popconfirm
    title="确定删除这条记录吗?"
    confirm-button-text="确定"
    cancel-button-text="取消"
    @confirm="handleDelete"
  >
    <template #reference>
      <el-button link type="danger" size="small">删除</el-button>
    </template>
  </el-popconfirm>
</template>

<script setup lang="ts">
async function handleDelete() {
  // Delete logic
}
</script>
```

---

## Component Usage Decision Tree

```
Need to show detail without navigation?
├─ Yes → Use Drawer
└─ No → Continue

Multiple sections/categories?
├─ Yes → Use Tabs or Collapse
└─ No → Continue

Uploading files?
├─ Yes → Use Upload
└─ No → Continue

Date/Time input?
├─ Yes → Use DatePicker/DateTimePicker
└─ No → Continue

Hierarchical selection?
├─ Yes
│   ├─ Single path → Cascader
│   └─ Multiple items → Tree
└─ No → Continue

Moving items between lists?
├─ Yes → Transfer
└─ No → Continue

Showing progress?
├─ Yes → Progress
└─ No → Continue

Activity/History log?
├─ Yes → Timeline
└─ No → Continue
```
