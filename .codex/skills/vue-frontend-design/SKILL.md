---
name: vue-frontend-design
description: "Generate Vue 3 admin pages following the project's established architecture pattern with Element Plus components, Pinia stores, and TypeScript. Use this skill when the user asks to build new admin pages, views, or CRUD interfaces for the management system."
license: Complete terms in LICENSE.txt
---

# Vue Frontend Design

## Overview

Generate Vue 3 admin pages that follow the project's established architecture. Create consistent, maintainable admin interfaces with proper state management, type safety, and user experience.

## Project Architecture

**View → Store → API** architecture pattern:

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Views** | `front/src/views/` | Page components using stores |
| **Stores** | `front/src/stores/` | Pinia stores managing state |
| **API** | `front/src/api/` | API client functions |
| **Components** | `front/src/components/` | Reusable dialogs, drawers |

**Tech Stack**: Vue 3 Composition API, Element Plus, Pinia, TypeScript

---

## Workflow

### 1) Understand Requirements

- Identify entity name and fields
- Determine CRUD operations needed
- Check for special features (search, filters, tree, master-detail, etc.)
- Review similar existing pages (users.vue, roles.vue, menus.vue, dictionaries.vue, tasks.vue)

### 2) Choose Layout Pattern

| Layout | Use Case | Reference |
|--------|----------|-----------|
| **Simple CRUD** | Standard list/create/edit/delete | [simple-crud-view.md](references/simple-crud-view.md) |
| **Master-Detail** | Parent-child entities (dictionaries) | [advanced-layouts.md](references/advanced-layouts.md#master-detail-layout) |
| **Tab-Based** | Multiple sections (profile, settings) | [advanced-layouts.md](references/advanced-layouts.md#tab-based-layout) |
| **Grid Cards** | Visual card display | [advanced-layouts.md](references/advanced-layouts.md#grid-layout) |

### 3) Implement Store

Use appropriate store pattern:
- **With Caching** (recommended): Better performance
- **Without Caching**: Simpler for less critical data

**Reference**: [store-template.md](references/store-template.md)

### 4) Select UI Patterns

**Basic Patterns**: [common-patterns.md](references/common-patterns.md)
- Status tags, date formatting, dropdowns, search forms, dialogs

**Advanced Components**: [advanced-components.md](references/advanced-components.md)
- Drawer, Upload, Tree, Transfer, Cascader, Timeline, Slider, etc.

**Advanced Tables**: [advanced-tables.md](references/advanced-tables.md)
- Expandable rows, batch operations, inline editing, fixed columns, virtual scroll

**Advanced Forms**: [advanced-forms.md](references/advanced-forms.md)
- Conditional fields, dynamic arrays, custom validators, multi-step wizards

### 5) Extract Components (If Needed)

Extract when:
- Page exceeds 300 lines
- Dialog/drawer exceeds 100 lines
- Same pattern used 2+ times

**Reference**: [component-patterns.md](references/component-patterns.md)

### 6) Generate Code

**Order**:
1. Store file (`front/src/stores/[entity].ts`)
2. Component files (if needed, in `front/src/components/admin/`)
3. View file (`front/src/views/[module]/[entity].vue`)
4. Router registration (if needed)

**Standard structure**:
```vue
<template>
  <div class="page">
    <div class="page-header"><!-- Title + Actions --></div>
    <div class="page-card"><!-- Search + Table + Pagination --></div>
    <!-- Dialogs/Drawers -->
  </div>
</template>

<script setup lang="ts">
// Imports → Store setup → Local state → Handlers → Lifecycle
</script>

<style scoped>
/* Standard styles */
</style>
```

### 7) Verify Checklist

**Essential**:
- [ ] TypeScript with proper types from @/api/types
- [ ] Pinia store with storeToRefs
- [ ] Loading states and error handling
- [ ] Success/error messages (ElMessage)
- [ ] Confirmation for destructive actions (ElMessageBox)
- [ ] Standard page classes (.page, .page-header, .page-card)

**Quality**:
- [ ] Consistent with existing codebase style
- [ ] Proper form validation rules
- [ ] Responsive layout (flexible widths, grid auto-fill)
- [ ] Extract components if page > 300 lines

---

## Design Principles

1. **Start Simple** - Use simple CRUD by default, add complexity only when needed
2. **Consistency Over Creativity** - Follow existing patterns strictly
3. **Performance First** - Use CacheManager, debounced search, lazy loading
4. **TypeScript Everywhere** - Proper interfaces for Props, Emits, forms
5. **Error Handling** - User-friendly messages, loading states, edge cases
6. **Extract Wisely** - Don't extract components prematurely

---

## Quick Decision Guide

```
User Request
    ↓
Simple list/create/edit/delete?
├─ Yes → simple-crud-view.md
└─ No → Check features
    ├─ Parent-child data → Master-Detail (advanced-layouts.md)
    ├─ Multiple sections → Tabs (advanced-layouts.md)
    ├─ File upload → Upload component (advanced-components.md)
    ├─ Hierarchical data → Tree/Cascader (advanced-components.md)
    ├─ Batch operations → Selection (advanced-tables.md)
    ├─ Wizard flow → Multi-step form (advanced-forms.md)
    └─ Complex validation → Custom validators (advanced-forms.md)

If page > 300 lines → Extract components (component-patterns.md)
```

---

## Reference Library

| File | Content |
|------|---------|
| **simple-crud-view.md** | Complete CRUD template |
| **store-template.md** | Pinia store patterns |
| **common-patterns.md** | Status tags, dates, dropdowns, search |
| **advanced-layouts.md** | Master-detail, tabs, grids, collapsible |
| **advanced-components.md** | Drawer, Upload, Tree, Transfer, Cascader, Timeline |
| **advanced-tables.md** | Expandable, batch ops, inline edit, virtual scroll |
| **advanced-forms.md** | Conditional fields, dynamic arrays, validators |
| **component-patterns.md** | Dialog/Drawer extraction, Props/Emits |

All patterns based on existing codebase (users.vue, roles.vue, menus.vue, dictionaries.vue, tasks.vue).

---

**Remember**: Prioritize **consistency** and **functionality** over creativity. Start simple, add complexity only when requirements demand it. The goal is seamless integration with the existing codebase.
