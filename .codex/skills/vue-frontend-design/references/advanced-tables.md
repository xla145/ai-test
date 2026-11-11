# Advanced Table Patterns

## Table with Custom Column Templates

### Multi-Line Cell Content

```vue
<el-table-column label="执行统计" width="150">
  <template #default="{ row }">
    <div style="font-size: 12px">
      <div>总计: {{ row.total_run_count }}</div>
      <div style="color: #67c23a">成功: {{ row.success_count }}</div>
      <div style="color: #f56c6c">失败: {{ row.failure_count }}</div>
    </div>
  </template>
</el-table-column>
```

### Avatar with Name

```vue
<el-table-column label="用户" width="180">
  <template #default="{ row }">
    <div style="display: flex; align-items: center; gap: 8px">
      <el-avatar :size="32" :src="row.avatar">
        {{ row.name.charAt(0) }}
      </el-avatar>
      <div>
        <div>{{ row.name }}</div>
        <div style="font-size: 12px; color: #909399">{{ row.email }}</div>
      </div>
    </div>
  </template>
</el-table-column>
```

### Progress Bar in Cell

```vue
<el-table-column label="完成度" width="180">
  <template #default="{ row }">
    <div>
      <el-progress
        :percentage="row.progress"
        :status="row.progress === 100 ? 'success' : undefined"
      />
    </div>
  </template>
</el-table-column>
```

### Badge with Count

```vue
<el-table-column label="通知" width="100" align="center">
  <template #default="{ row }">
    <el-badge :value="row.unreadCount" :max="99">
      <el-icon :size="20"><Message /></el-icon>
    </el-badge>
  </template>
</el-table-column>
```

### Link with Icon

```vue
<el-table-column prop="url" label="链接" width="200">
  <template #default="{ row }">
    <a :href="row.url" target="_blank" style="color: var(--el-color-primary)">
      {{ row.title }}
      <el-icon><Link /></el-icon>
    </a>
  </template>
</el-table-column>
```

---

## Expandable Rows

For showing additional details without a separate page.

```vue
<script setup lang="ts">
import { ref } from 'vue'

const tableData = ref([
  {
    id: 1,
    name: '任务 A',
    status: 'running',
    details: {
      startTime: '2024-01-01 10:00',
      logs: ['开始执行', '处理中...', '接近完成']
    }
  }
])
</script>

<template>
  <el-table :data="tableData" row-key="id">
    <el-table-column type="expand">
      <template #default="{ row }">
        <div style="padding: 16px">
          <h4>详细信息</h4>
          <p><strong>开始时间:</strong> {{ row.details.startTime }}</p>
          <h5>执行日志:</h5>
          <ul>
            <li v-for="(log, index) in row.details.logs" :key="index">
              {{ log }}
            </li>
          </ul>
        </div>
      </template>
    </el-table-column>
    <el-table-column prop="name" label="任务名称" />
    <el-table-column prop="status" label="状态" />
  </el-table>
</template>
```

---

## Selection & Batch Operations

### Multi-Select with Batch Actions

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const tableData = ref([...])
const selectedRows = ref([])

function handleSelectionChange(selection: any[]) {
  selectedRows.value = selection
}

async function handleBatchDelete() {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择要删除的项')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定要删除选中的 ${selectedRows.value.length} 项吗？`,
      '批量删除',
      { type: 'warning' }
    )

    const ids = selectedRows.value.map(row => row.id)
    // await batchDelete(ids)
    ElMessage.success('删除成功')
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error('删除失败')
    }
  }
}

async function handleBatchExport() {
  if (!selectedRows.value.length) {
    ElMessage.warning('请先选择要导出的项')
    return
  }

  const ids = selectedRows.value.map(row => row.id)
  // Export logic
}
</script>

<template>
  <div class="page">
    <!-- Batch Actions Toolbar -->
    <div v-if="selectedRows.length > 0" class="batch-toolbar">
      <span>已选择 {{ selectedRows.length }} 项</span>
      <div class="batch-actions">
        <el-button size="small" @click="handleBatchExport">
          <el-icon><Download /></el-icon>
          批量导出
        </el-button>
        <el-button size="small" type="danger" @click="handleBatchDelete">
          <el-icon><Delete /></el-icon>
          批量删除
        </el-button>
      </div>
    </div>

    <!-- Table with Selection -->
    <el-table
      :data="tableData"
      @selection-change="handleSelectionChange"
    >
      <el-table-column type="selection" width="55" />
      <el-table-column prop="name" label="名称" />
      <!-- More columns... -->
    </el-table>
  </div>
</template>

<style scoped>
.batch-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: var(--el-color-primary-light-9);
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 4px;
  margin-bottom: 16px;
}

.batch-actions {
  display: flex;
  gap: 8px;
}
</style>
```

---

## Sortable Columns

```vue
<script setup lang="ts">
function handleSortChange({ prop, order }: { prop: string; order: string | null }) {
  console.log('Sort by:', prop, order)
  // Update API request with sort params
}
</script>

<template>
  <el-table
    :data="tableData"
    :default-sort="{ prop: 'date', order: 'descending' }"
    @sort-change="handleSortChange"
  >
    <el-table-column prop="date" label="日期" sortable width="180" />
    <el-table-column prop="name" label="名称" sortable />
    <el-table-column prop="amount" label="金额" sortable />
  </el-table>
</template>
```

**Custom sort:**
```vue
<el-table-column
  prop="custom"
  label="自定义排序"
  sortable="custom"
/>
```

---

## Fixed Columns & Header

For wide tables with horizontal scroll.

```vue
<template>
  <el-table
    :data="tableData"
    height="500"
    style="width: 100%"
  >
    <!-- Fixed left -->
    <el-table-column
      prop="id"
      label="ID"
      width="80"
      fixed="left"
    />
    <el-table-column
      prop="name"
      label="名称"
      width="150"
      fixed="left"
    />

    <!-- Scrollable middle columns -->
    <el-table-column prop="field1" label="字段1" width="150" />
    <el-table-column prop="field2" label="字段2" width="150" />
    <el-table-column prop="field3" label="字段3" width="150" />
    <el-table-column prop="field4" label="字段4" width="150" />
    <el-table-column prop="field5" label="字段5" width="150" />

    <!-- Fixed right -->
    <el-table-column
      label="操作"
      width="200"
      fixed="right"
    >
      <template #default="{ row }">
        <el-button link type="primary" size="small">编辑</el-button>
        <el-button link type="danger" size="small">删除</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
```

---

## Table with Inline Editing

```vue
<script setup lang="ts">
import { ref } from 'vue'

const tableData = ref([
  { id: 1, name: '项目 A', status: 'active', editing: false }
])

function startEdit(row: any) {
  row.editing = true
  row.originalName = row.name
}

async function saveEdit(row: any) {
  try {
    // await updateItem(row.id, { name: row.name })
    row.editing = false
    ElMessage.success('保存成功')
  } catch (error) {
    ElMessage.error('保存失败')
  }
}

function cancelEdit(row: any) {
  row.name = row.originalName
  row.editing = false
}
</script>

<template>
  <el-table :data="tableData">
    <el-table-column label="名称" width="300">
      <template #default="{ row }">
        <el-input
          v-if="row.editing"
          v-model="row.name"
          size="small"
        />
        <span v-else>{{ row.name }}</span>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="200">
      <template #default="{ row }">
        <template v-if="row.editing">
          <el-button link type="success" size="small" @click="saveEdit(row)">
            保存
          </el-button>
          <el-button link size="small" @click="cancelEdit(row)">
            取消
          </el-button>
        </template>
        <el-button v-else link type="primary" size="small" @click="startEdit(row)">
          编辑
        </el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
```

---

## Summary Row

```vue
<script setup lang="ts">
function getSummaries(param: any) {
  const { columns, data } = param
  const sums: string[] = []

  columns.forEach((column: any, index: number) => {
    if (index === 0) {
      sums[index] = '合计'
      return
    }

    if (column.property === 'amount') {
      const values = data.map((item: any) => Number(item[column.property]))
      sums[index] = values.reduce((prev: number, curr: number) => {
        return prev + curr
      }, 0).toFixed(2)
    } else {
      sums[index] = '-'
    }
  })

  return sums
}
</script>

<template>
  <el-table
    :data="tableData"
    show-summary
    :summary-method="getSummaries"
  >
    <el-table-column prop="name" label="名称" />
    <el-table-column prop="amount" label="金额" />
  </el-table>
</template>
```

---

## Virtual Scrolling for Large Data

For tables with thousands of rows.

```vue
<template>
  <el-table
    :data="tableData"
    height="600"
    v-loading="loading"
  >
    <el-table-column type="index" width="50" />
    <el-table-column prop="name" label="名称" />
    <el-table-column prop="value" label="值" />
  </el-table>

  <!-- Load More Button -->
  <div v-if="hasMore" class="load-more">
    <el-button @click="loadMore" :loading="loading">
      加载更多
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const tableData = ref([])
const loading = ref(false)
const hasMore = ref(true)
const page = ref(1)

async function loadMore() {
  loading.value = true
  try {
    // const data = await fetchData(page.value)
    // tableData.value.push(...data)
    page.value++
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.load-more {
  text-align: center;
  padding: 16px;
}
</style>
```

---

## Table with Filters

```vue
<script setup lang="ts">
const filterHandler = (value: string, row: any) => {
  return row.status === value
}

const statusFilters = [
  { text: '活跃', value: 'active' },
  { text: '已锁定', value: 'locked' },
  { text: '已禁用', value: 'disabled' }
]
</script>

<template>
  <el-table :data="tableData">
    <el-table-column prop="name" label="名称" />
    <el-table-column
      prop="status"
      label="状态"
      :filters="statusFilters"
      :filter-method="filterHandler"
    >
      <template #default="{ row }">
        <el-tag :type="getStatusType(row.status)">
          {{ row.status }}
        </el-tag>
      </template>
    </el-table-column>
  </el-table>
</template>
```

---

## Grouped Table Headers

```vue
<template>
  <el-table :data="tableData">
    <el-table-column prop="name" label="名称" width="150" />

    <!-- Grouped columns -->
    <el-table-column label="个人信息">
      <el-table-column prop="age" label="年龄" width="100" />
      <el-table-column prop="gender" label="性别" width="100" />
    </el-table-column>

    <el-table-column label="联系方式">
      <el-table-column prop="email" label="邮箱" width="200" />
      <el-table-column prop="phone" label="电话" width="150" />
    </el-table-column>
  </el-table>
</template>
```

---

## Table Pattern Decision Guide

| Need | Pattern |
|------|---------|
| Show more details per row | Expandable Rows |
| Bulk operations | Selection & Batch Operations |
| Sort data | Sortable Columns |
| Many columns | Fixed Columns |
| Edit in place | Inline Editing |
| Show totals | Summary Row |
| Thousands of rows | Virtual Scrolling / Load More |
| Quick column filters | Table with Filters |
| Complex data structure | Grouped Headers |
| Multiple lines of info per cell | Custom Column Templates |
