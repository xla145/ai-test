# Vue Frontend Design Skill

Generate Vue 3 admin pages following the project's established architecture pattern with Element Plus components, Pinia stores, and TypeScript.

## Overview

This skill helps generate consistent, production-ready admin pages for the management system. It follows the **View → Store → API** architecture pattern used throughout the project.

## Structure

```
vue-frontend-design/
├── SKILL.md                    # Main skill definition
├── README.md                   # This file
└── examples/                   # Code examples and templates
    ├── simple-crud-view.md     # Complete CRUD view template
    ├── store-template.md       # Pinia store templates
    └── common-patterns.md      # Reusable UI patterns
```

## Usage

Invoke this skill when you need to:
- Create new admin pages (users, roles, products, etc.)
- Build CRUD interfaces with search and pagination
- Generate Pinia stores for data management
- Implement standard UI patterns consistently

## Technology Stack

- **Framework**: Vue 3 with Composition API
- **UI Library**: Element Plus
- **State Management**: Pinia
- **Language**: TypeScript
- **Features**: Caching, pagination, search/filters

## Key Features

### Standard Page Structure
- Page header with title and primary action
- White card container for content
- Search/filter forms
- Data tables with stripe and border
- Pagination controls
- Dialogs for create/edit operations

### Store Pattern
- Centralized state management
- API call wrapping
- Loading and error states
- Pagination and filter state
- Optional caching for performance

### Common Patterns
- Status tags with color mapping
- Date formatting
- Dropdown menus for actions
- Confirmation dialogs
- Form validation
- Tree tables for hierarchical data
- Multiple tags display
- Conditional rendering

## Examples

### Simple CRUD View
See [examples/simple-crud-view.md](examples/simple-crud-view.md) for a complete template including:
- TypeScript imports and types
- Store integration with storeToRefs
- CRUD operations with error handling
- Form dialog with validation
- Pagination and search
- Standard styles

### Store Template
See [examples/store-template.md](examples/store-template.md) for:
- Complete store structure with caching
- Simpler version without caching
- State, computed, and actions
- Cache management
- Pagination helpers

### Common Patterns
See [examples/common-patterns.md](examples/common-patterns.md) for:
- Status tag patterns
- Date formatting utilities
- Dropdown menu implementation
- Search form layouts
- Confirmation dialog handling
- Form dialog patterns
- And many more...

## Design Principles

1. **Consistency**: Follow existing patterns in users.vue, roles.vue, menus.vue
2. **Simplicity**: Clean, functional UI without unnecessary decoration
3. **Element Plus**: Use standard components and styles
4. **TypeScript**: Full type safety throughout
5. **Error Handling**: User-friendly error messages
6. **Loading States**: Visual feedback during async operations
7. **Caching**: Performance optimization for list data
8. **Responsive**: Works well on different screen sizes

## Generation Checklist

When generating a new admin page:
- ✅ Uses `<script setup lang="ts">` with TypeScript
- ✅ Imports and uses Pinia store with storeToRefs
- ✅ Follows standard page structure
- ✅ Includes search/filter form (if needed)
- ✅ Implements table with loading state
- ✅ Includes pagination
- ✅ Has CRUD operations with confirmations
- ✅ Shows success/error messages
- ✅ Uses proper TypeScript types
- ✅ Includes standard scoped styles

## Related Skills

- **vue-store-architecture**: Refactor existing views to use stores
- **fastapi-backend-codegen**: Generate matching backend API

## Notes

This skill prioritizes **consistency** and **functionality** over creativity. The goal is to create pages that seamlessly integrate with the existing codebase while maintaining high code quality and user experience.
