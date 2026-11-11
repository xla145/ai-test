# Store Patterns Reference

## Store Structure Overview

| Section | Purpose |
|---------|---------|
| **State** | Reactive data (entities, loading, error, pagination, filters) |
| **Computed** | Derived values (hasEntities, totalPages) |
| **Actions** | Async operations and state mutations |

---

## State Management

### Core State Properties

| Property | Type | Purpose |
|----------|------|---------|
| `entities` | `ref<Entity[]>` | List of entities |
| `currentEntity` | `ref<Entity \| null>` | Currently selected entity |
| `loading` | `ref<boolean>` | Loading state for UI indicators |
| `error` | `ref<string \| null>` | Error message if operation fails |
| `pagination` | `ref<PaginationState>` | Page, pageSize, total |
| `filters` | `ref<FilterState>` | Search/filter parameters |

### Pagination State Structure

```typescript
const pagination = ref({
  page: 1,
  pageSize: 20,
  total: 0,
})
```

### Filters State Structure

```typescript
const filters = ref({
  name: '',
  status: '',
  // ... other filter fields
})
```

---

## Computed Properties

### Common Computed Values

```typescript
const hasEntities = computed(() => entities.value.length > 0)
const totalPages = computed(() =>
  Math.ceil(pagination.value.total / pagination.value.pageSize)
)
```

---

## Actions Pattern

### Required Actions for CRUD

- [ ] `fetchList(params?)` - Fetch paginated list
- [ ] `search()` - Search with current filters
- [ ] `resetFilters()` - Clear all filters
- [ ] `fetchById(id, force?)` - Get single entity
- [ ] `create(data)` - Create new entity
- [ ] `update(id, data)` - Update existing entity
- [ ] `remove(id)` - Delete entity
- [ ] `changePage(page)` - Change current page
- [ ] `changePageSize(pageSize)` - Change page size
- [ ] `reset()` - Reset store to initial state
- [ ] `clearCache(prefix?)` - Clear cache (if using cache)

---

## Caching Strategy

### Two Approaches

| Approach | Use Case | Complexity |
|----------|----------|------------|
| **With Caching** | Frequently accessed data, performance-critical | Higher |
| **Without Caching** | Simple data, infrequent access | Lower |

### Cache Setup (Recommended)

```typescript
import { CacheManager, DebouncedCache, generateCacheKey } from '@/utils/cache'

const cache = new CacheManager<any>(5 * 60 * 1000) // 5分钟
const debouncedCache = new DebouncedCache()
```

### Cache Key Generation

```typescript
const cacheKey = generateCacheKey(
  'entity:list',
  filters.value.name,
  filters.value.status,
  pagination.value.page,
  pagination.value.pageSize
)
```

### Cache Invalidation Strategy

| Operation | Cache Invalidation |
|-----------|-------------------|
| **Create** | Clear `entity:list` prefix |
| **Update** | Clear `entity:detail:{id}` and `entity:list` prefix |
| **Delete** | Clear `entity:detail:{id}` and `entity:list` prefix |
| **Force Refresh** | Skip cache check with `force: true` param |

---

## Action Implementation Patterns

### fetchList Pattern

**With Caching:**

```typescript
async function fetchList(params?: { force?: boolean; [key: string]: any }) {
  const { force, ...queryParams } = params || {}
  const cacheKey = generateCacheKey('entity:list', ...)

  // Check cache
  if (!force) {
    const cachedData = cache.get(cacheKey)
    if (cachedData) {
      entities.value = cachedData.rows || []
      pagination.value.total = cachedData.rowTotal || 0
      return cachedData
    }
  }

  loading.value = true
  error.value = null

  try {
    const data = await debouncedCache.execute(cacheKey, async () => {
      const { data } = await api.listEntities(queryParams)
      return data?.data
    })

    if (data) {
      entities.value = data.rows || []
      pagination.value.total = data.rowTotal || 0
      cache.set(cacheKey, data)
    }
    return data
  } catch (err: any) {
    error.value = err.message || 'Failed to fetch'
    throw err
  } finally {
    loading.value = false
  }
}
```

**Without Caching (Simpler):**

```typescript
async function fetchList(params?: any) {
  loading.value = true
  error.value = null
  try {
    const { data } = await api.listEntities(params)
    if (data?.data) {
      entities.value = data.data.rows || []
      pagination.value.total = data.data.rowTotal || 0
    }
    return data?.data
  } catch (err: any) {
    error.value = err.message || 'Failed to fetch'
    throw err
  } finally {
    loading.value = false
  }
}
```

### search Pattern

```typescript
async function search() {
  pagination.value.page = 1  // Reset to first page
  return fetchList({
    name: filters.value.name || undefined,
    status: filters.value.status || undefined,
  })
}
```

### create Pattern

```typescript
async function create(entityData: EntityCreateBody) {
  loading.value = true
  error.value = null

  try {
    const { data } = await api.createEntity(entityData)
    if (data?.data) {
      // Invalidate cache
      cache.deleteByPrefix('entity:list')
      // Refresh list
      await fetchList({ force: true })
      return data.data
    }
  } catch (err: any) {
    error.value = err.message || 'Failed to create'
    throw err
  } finally {
    loading.value = false
  }
}
```

### update Pattern

```typescript
async function update(id: number, entityData: EntityUpdateBody) {
  loading.value = true
  error.value = null

  try {
    const { data } = await api.updateEntity(id, entityData)
    if (data?.data) {
      // Invalidate cache
      cache.delete(generateCacheKey('entity:detail', id))
      cache.deleteByPrefix('entity:list')

      // Update local state
      const index = entities.value.findIndex(e => e.id === id)
      if (index !== -1) {
        entities.value[index] = data.data
      }
      return data.data
    }
  } catch (err: any) {
    error.value = err.message || 'Failed to update'
    throw err
  } finally {
    loading.value = false
  }
}
```

### remove Pattern

```typescript
async function remove(id: number) {
  loading.value = true
  error.value = null

  try {
    await api.deleteEntity(id)

    // Invalidate cache
    cache.delete(generateCacheKey('entity:detail', id))
    cache.deleteByPrefix('entity:list')

    // Update local state
    entities.value = entities.value.filter(e => e.id !== id)
    pagination.value.total = Math.max(0, pagination.value.total - 1)
  } catch (err: any) {
    error.value = err.message || 'Failed to delete'
    throw err
  } finally {
    loading.value = false
  }
}
```

### Pagination Handlers

```typescript
function changePage(page: number) {
  pagination.value.page = page
  return fetchList()
}

function changePageSize(pageSize: number) {
  pagination.value.pageSize = pageSize
  pagination.value.page = 1  // Reset to first page
  return fetchList()
}
```

---

## Error Handling Principles

1. **Always set `loading` and `error` state**
2. **Catch errors and set error message**
3. **Re-throw errors for view layer to handle**
4. **Use `finally` to reset loading state**

```typescript
loading.value = true
error.value = null
try {
  // operation
} catch (err: any) {
  error.value = err.message || 'Operation failed'
  throw err  // Re-throw for view
} finally {
  loading.value = false
}
```

---

## Store Export Pattern

```typescript
export const useEntityStore = defineStore('entity', () => {
  // State
  const entities = ref<Entity[]>([])
  // ... other state

  // Computed
  const hasEntities = computed(() => entities.value.length > 0)
  // ... other computed

  // Actions
  async function fetchList() { /* ... */ }
  // ... other actions

  return {
    // State
    entities,
    loading,
    error,
    pagination,
    filters,
    currentEntity,

    // Computed
    hasEntities,
    totalPages,

    // Actions
    fetchList,
    search,
    resetFilters,
    fetchById,
    create,
    update,
    remove,
    changePage,
    changePageSize,
    reset,
    clearCache,
  }
})
```

---

## Store Generation Checklist

Before completing a store, verify:

- [ ] Uses `defineStore` with setup syntax
- [ ] Defines all core state properties (entities, loading, error, pagination, filters)
- [ ] Implements all required computed properties
- [ ] Implements all required CRUD actions
- [ ] Uses proper error handling pattern in all actions
- [ ] Sets loading state before and after operations
- [ ] Invalidates cache after mutations (if using cache)
- [ ] Updates local state optimistically after mutations
- [ ] Exports all state, computed, and actions
- [ ] Uses TypeScript types throughout
- [ ] Handles pagination correctly (reset page on filter change)
- [ ] Re-throws errors for view layer to handle
