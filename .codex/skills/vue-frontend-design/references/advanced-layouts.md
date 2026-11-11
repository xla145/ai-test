# Advanced Layout Patterns

## Master-Detail Layout (主从布局)

For pages that display a list and detail view side-by-side (like dictionaries management).

### Two-Panel Layout

```vue
<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">管理页面</h1>
    </div>

    <div class="split-container">
      <!-- Left Panel: Master List -->
      <div class="master-panel">
        <div class="page-card">
          <div class="page-card__header">
            <span>主列表</span>
            <el-button type="primary" size="small" @click="openCreate">新建</el-button>
          </div>
          <div class="page-card__body">
            <div class="filter-bar">
              <el-input
                v-model="masterFilters.name"
                placeholder="搜索"
                clearable
                size="small"
                @keyup.enter="handleMasterSearch"
              />
              <el-button type="primary" size="small" @click="handleMasterSearch">查询</el-button>
            </div>
            <el-table
              v-loading="masterLoading"
              :data="masterList"
              border
              stripe
              highlight-current-row
              @row-click="handleSelectMaster"
              :row-class-name="({ row }) => isActive(row) ? 'active-row' : ''"
            >
              <el-table-column prop="name" label="名称" />
              <!-- More columns... -->
            </el-table>
            <div class="pagination-bar">
              <el-pagination
                v-model:current-page="masterPagination.page"
                v-model:page-size="masterPagination.pageSize"
                :total="masterPagination.total"
                layout="total, prev, pager, next"
                small
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Right Panel: Detail View -->
      <div class="detail-panel">
        <div class="page-card">
          <div class="page-card__header">
            <span>
              详情
              <el-tag v-if="currentMaster" type="primary" size="small" style="margin-left: 8px">
                {{ currentMaster.name }}
              </el-tag>
            </span>
            <el-button type="primary" size="small" :disabled="!currentMaster" @click="openDetailCreate">
              新建
            </el-button>
          </div>
          <div class="page-card__body">
            <template v-if="currentMaster">
              <!-- Detail content -->
              <el-table
                v-loading="detailLoading"
                :data="detailList"
                border
                stripe
              >
                <!-- Detail columns... -->
              </el-table>
            </template>
            <el-empty v-else description="请选择左侧项目" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

const currentMaster = ref(null)

function handleSelectMaster(row: any) {
  currentMaster.value = row
  // Load detail data for selected master
}

function isActive(row: any) {
  return currentMaster.value?.id === row.id
}
</script>

<style scoped>
.split-container {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.master-panel {
  width: 480px;
  flex-shrink: 0;
}

.detail-panel {
  flex: 1;
  min-width: 0;
}

.page-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--el-border-color-light);
  font-weight: 500;
}

.page-card__body {
  padding: 16px;
}

.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.pagination-bar {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

:deep(.active-row) {
  background-color: var(--el-color-primary-light-9) !important;
}
</style>
```

**Key Features:**
- Fixed-width master panel, flexible detail panel
- Row highlighting for selected item
- Custom card header with actions
- Conditional detail rendering based on selection
- Separate loading states for master and detail

---

## Tab-Based Layout (标签页布局)

For pages with multiple related sections.

```vue
<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">用户详情</h1>
    </div>

    <div class="page-card">
      <el-tabs v-model="activeTab" @tab-change="handleTabChange">
        <el-tab-pane label="基本信息" name="info">
          <!-- Basic info content -->
        </el-tab-pane>
        <el-tab-pane label="操作历史" name="history">
          <el-table v-loading="historyLoading" :data="historyData">
            <!-- History table -->
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="权限设置" name="permissions">
          <!-- Permissions content -->
        </el-tab-pane>
      </el-tabs>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const activeTab = ref('info')
const historyLoading = ref(false)
const historyData = ref([])

async function handleTabChange(tabName: string) {
  if (tabName === 'history' && !historyData.value.length) {
    historyLoading.value = true
    try {
      // Load history data
    } finally {
      historyLoading.value = false
    }
  }
}
</script>
```

**Best Practices:**
- Lazy load tab content on first access
- Show loading state per tab
- Persist active tab in URL query parameter for deep linking

---

## Grid Layout (网格布局)

For card-based views or dashboards.

```vue
<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">应用列表</h1>
      <el-button type="primary" @click="openCreate">新建应用</el-button>
    </div>

    <div class="grid-container">
      <el-card
        v-for="item in items"
        :key="item.id"
        class="grid-item"
        shadow="hover"
      >
        <template #header>
          <div class="card-header">
            <span>{{ item.name }}</span>
            <el-dropdown @command="(cmd) => handleCommand(cmd, item)">
              <el-icon><MoreFilled /></el-icon>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit">编辑</el-dropdown-item>
                  <el-dropdown-item command="delete" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </template>
        <div class="card-body">
          <p>{{ item.description }}</p>
          <div class="card-footer">
            <el-tag size="small">{{ item.status }}</el-tag>
            <span class="text-muted">{{ formatDate(item.created_at) }}</span>
          </div>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.grid-item {
  cursor: pointer;
  transition: all 0.3s;
}

.grid-item:hover {
  transform: translateY(-4px);
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.card-body {
  min-height: 100px;
}

.card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>
```

---

## Collapsible Sections (折叠面板)

For forms or content with many sections.

```vue
<template>
  <div class="page">
    <div class="page-card">
      <el-collapse v-model="activeNames">
        <el-collapse-item title="基本设置" name="basic">
          <el-form :model="form" label-width="100px">
            <el-form-item label="名称">
              <el-input v-model="form.name" />
            </el-form-item>
            <!-- More fields... -->
          </el-form>
        </el-collapse-item>

        <el-collapse-item title="高级设置" name="advanced">
          <el-form :model="form" label-width="100px">
            <!-- Advanced settings -->
          </el-form>
        </el-collapse-item>

        <el-collapse-item title="权限配置" name="permissions">
          <!-- Permissions config -->
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

// Open all sections by default
const activeNames = ref(['basic', 'advanced', 'permissions'])
</script>
```

---

## Fixed Header with Scrollable Content

For pages with lots of content that need persistent header actions.

```vue
<template>
  <div class="page">
    <div class="page-header-sticky">
      <div class="page-header-content">
        <h1 class="page-title">长页面</h1>
        <div class="header-actions">
          <el-button @click="handleCancel">取消</el-button>
          <el-button type="primary" @click="handleSave">保存</el-button>
        </div>
      </div>
    </div>

    <div class="page-content-scrollable">
      <div class="page-card">
        <!-- Long form content -->
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px); /* Adjust based on your layout */
}

.page-header-sticky {
  position: sticky;
  top: 0;
  z-index: 10;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-light);
  padding: 16px 20px;
}

.page-header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.page-content-scrollable {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}
</style>
```

---

## Layout Selection Guide

| Use Case | Recommended Layout |
|----------|-------------------|
| Dictionary management, Category & Items | Master-Detail |
| User profile with multiple sections | Tab-Based |
| Application/Project cards | Grid |
| Complex multi-section form | Collapsible Sections |
| Long form with action buttons | Fixed Header with Scrollable Content |
| Settings page | Tab-Based or Collapsible Sections |
