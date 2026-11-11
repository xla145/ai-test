# Advanced Form Patterns

## Dynamic Forms

### Conditional Form Items

Show/hide fields based on other field values.

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'

const form = ref({
  task_type: 'cron',
  cron_expression: '',
  interval_seconds: undefined
})

// Clear irrelevant fields when type changes
watch(() => form.value.task_type, (newType) => {
  if (newType === 'cron') {
    form.value.interval_seconds = undefined
  } else {
    form.value.cron_expression = ''
  }
})
</script>

<template>
  <el-form :model="form" label-width="120px">
    <el-form-item label="任务类型" prop="task_type">
      <el-radio-group v-model="form.task_type">
        <el-radio value="cron">Cron</el-radio>
        <el-radio value="interval">Interval</el-radio>
      </el-radio-group>
    </el-form-item>

    <!-- Conditional field 1 -->
    <el-form-item
      v-if="form.task_type === 'cron'"
      label="Cron表达式"
      prop="cron_expression"
    >
      <el-input v-model="form.cron_expression" placeholder="0 0 * * *" />
      <div class="form-item-tip">
        格式: 分 时 日 月 周 (例: 0 0 * * * 表示每天0点)
      </div>
    </el-form-item>

    <!-- Conditional field 2 -->
    <el-form-item
      v-if="form.task_type === 'interval'"
      label="间隔秒数"
      prop="interval_seconds"
    >
      <el-input-number v-model="form.interval_seconds" :min="1" />
    </el-form-item>
  </el-form>
</template>

<style scoped>
.form-item-tip {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
</style>
```

### Dynamic Field Array

Add/remove form items dynamically (e.g., contact list, parameter list).

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'

interface Contact {
  name: string
  phone: string
}

const formRef = ref<FormInstance>()
const form = ref({
  contacts: [
    { name: '', phone: '' }
  ] as Contact[]
})

const rules: FormRules = {
  contacts: [
    {
      type: 'array',
      required: true,
      message: '至少添加一个联系人',
      trigger: 'change'
    }
  ]
}

function addContact() {
  form.value.contacts.push({ name: '', phone: '' })
}

function removeContact(index: number) {
  if (form.value.contacts.length > 1) {
    form.value.contacts.splice(index, 1)
  }
}
</script>

<template>
  <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
    <div
      v-for="(contact, index) in form.contacts"
      :key="index"
      class="dynamic-item"
    >
      <div class="dynamic-item-header">
        <span>联系人 {{ index + 1 }}</span>
        <el-button
          v-if="form.contacts.length > 1"
          link
          type="danger"
          size="small"
          @click="removeContact(index)"
        >
          删除
        </el-button>
      </div>

      <el-form-item
        :label="`姓名`"
        :prop="`contacts.${index}.name`"
        :rules="{ required: true, message: '请输入姓名', trigger: 'blur' }"
      >
        <el-input v-model="contact.name" placeholder="请输入姓名" />
      </el-form-item>

      <el-form-item
        :label="`电话`"
        :prop="`contacts.${index}.phone`"
        :rules="{ required: true, message: '请输入电话', trigger: 'blur' }"
      >
        <el-input v-model="contact.phone" placeholder="请输入电话" />
      </el-form-item>
    </div>

    <el-form-item>
      <el-button type="primary" plain @click="addContact">
        <el-icon><Plus /></el-icon>
        添加联系人
      </el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped>
.dynamic-item {
  border: 1px solid var(--el-border-color-light);
  border-radius: 4px;
  padding: 16px;
  margin-bottom: 16px;
}

.dynamic-item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-weight: 500;
}
</style>
```

---

## Custom Validators

### Async Validation

Check uniqueness or validate against API.

```vue
<script setup lang="ts">
import type { FormRules } from 'element-plus'
import { checkUsernameExists } from '@/api/users'

const validateUsername = async (rule: any, value: string, callback: any) => {
  if (!value) {
    return callback(new Error('请输入用户名'))
  }

  try {
    const exists = await checkUsernameExists(value)
    if (exists) {
      callback(new Error('用户名已存在'))
    } else {
      callback()
    }
  } catch (error) {
    callback(new Error('验证失败，请稍后重试'))
  }
}

const rules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { validator: validateUsername, trigger: 'blur' }
  ]
}
</script>
```

### Complex Validation

Multiple conditions or cross-field validation.

```vue
<script setup lang="ts">
const form = ref({
  password: '',
  confirmPassword: ''
})

const validatePassword = (rule: any, value: string, callback: any) => {
  if (!value) {
    return callback(new Error('请输入密码'))
  }
  if (value.length < 8) {
    return callback(new Error('密码长度至少8位'))
  }
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(value)) {
    return callback(new Error('密码必须包含大小写字母和数字'))
  }
  callback()
}

const validateConfirmPassword = (rule: any, value: string, callback: any) => {
  if (!value) {
    return callback(new Error('请再次输入密码'))
  }
  if (value !== form.value.password) {
    return callback(new Error('两次输入的密码不一致'))
  }
  callback()
}

const rules: FormRules = {
  password: [
    { validator: validatePassword, trigger: 'blur' }
  ],
  confirmPassword: [
    { validator: validateConfirmPassword, trigger: 'blur' }
  ]
}
</script>
```

### JSON Validation

```vue
<script setup lang="ts">
const validateJSON = (rule: any, value: string, callback: any) => {
  if (!value) {
    return callback()  // Optional field
  }

  try {
    const parsed = JSON.parse(value)
    // Additional validation on parsed object
    if (typeof parsed !== 'object') {
      return callback(new Error('必须是JSON对象'))
    }
    callback()
  } catch (error) {
    callback(new Error('请输入有效的JSON格式'))
  }
}

const rules: FormRules = {
  config: [
    { validator: validateJSON, trigger: 'blur' }
  ]
}
</script>

<template>
  <el-form-item label="配置" prop="config">
    <el-input
      v-model="form.config"
      type="textarea"
      :rows="5"
      placeholder='{"key": "value"}'
    />
  </el-form-item>
</template>
```

---

## Multi-Step Forms (Wizard)

### Step-by-Step Form

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { FormInstance } from 'element-plus'

const activeStep = ref(0)
const form1Ref = ref<FormInstance>()
const form2Ref = ref<FormInstance>()
const form3Ref = ref<FormInstance>()

const form = ref({
  // Step 1
  name: '',
  email: '',
  // Step 2
  address: '',
  city: '',
  // Step 3
  preferences: []
})

async function nextStep() {
  let valid = false

  if (activeStep.value === 0) {
    valid = await form1Ref.value!.validate()
  } else if (activeStep.value === 1) {
    valid = await form2Ref.value!.validate()
  }

  if (valid) {
    activeStep.value++
  }
}

function prevStep() {
  activeStep.value--
}

async function submit() {
  const valid = await form3Ref.value!.validate()
  if (valid) {
    // Submit all form data
    console.log('Submit:', form.value)
  }
}
</script>

<template>
  <div class="page">
    <div class="page-card">
      <!-- Steps Indicator -->
      <el-steps :active="activeStep" finish-status="success" align-center>
        <el-step title="基本信息" />
        <el-step title="地址信息" />
        <el-step title="偏好设置" />
      </el-steps>

      <!-- Step 1: Basic Info -->
      <div v-show="activeStep === 0" class="step-content">
        <el-form ref="form1Ref" :model="form" label-width="100px">
          <el-form-item
            label="姓名"
            prop="name"
            :rules="{ required: true, message: '请输入姓名', trigger: 'blur' }"
          >
            <el-input v-model="form.name" />
          </el-form-item>
          <el-form-item
            label="邮箱"
            prop="email"
            :rules="[
              { required: true, message: '请输入邮箱', trigger: 'blur' },
              { type: 'email', message: '请输入正确的邮箱', trigger: 'blur' }
            ]"
          >
            <el-input v-model="form.email" />
          </el-form-item>
        </el-form>
      </div>

      <!-- Step 2: Address Info -->
      <div v-show="activeStep === 1" class="step-content">
        <el-form ref="form2Ref" :model="form" label-width="100px">
          <el-form-item
            label="地址"
            prop="address"
            :rules="{ required: true, message: '请输入地址', trigger: 'blur' }"
          >
            <el-input v-model="form.address" />
          </el-form-item>
          <el-form-item
            label="城市"
            prop="city"
            :rules="{ required: true, message: '请选择城市', trigger: 'change' }"
          >
            <el-select v-model="form.city" placeholder="请选择">
              <el-option label="北京" value="beijing" />
              <el-option label="上海" value="shanghai" />
            </el-select>
          </el-form-item>
        </el-form>
      </div>

      <!-- Step 3: Preferences -->
      <div v-show="activeStep === 2" class="step-content">
        <el-form ref="form3Ref" :model="form" label-width="100px">
          <el-form-item label="偏好" prop="preferences">
            <el-checkbox-group v-model="form.preferences">
              <el-checkbox value="email">接收邮件通知</el-checkbox>
              <el-checkbox value="sms">接收短信通知</el-checkbox>
              <el-checkbox value="newsletter">订阅新闻</el-checkbox>
            </el-checkbox-group>
          </el-form-item>
        </el-form>
      </div>

      <!-- Actions -->
      <div class="step-actions">
        <el-button v-if="activeStep > 0" @click="prevStep">
          上一步
        </el-button>
        <el-button v-if="activeStep < 2" type="primary" @click="nextStep">
          下一步
        </el-button>
        <el-button v-else type="primary" @click="submit">
          提交
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.step-content {
  margin: 40px 0;
  min-height: 200px;
}

.step-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  margin-top: 40px;
}
</style>
```

---

## Form with Auto-Save

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { ElMessage } from 'element-plus'

const form = ref({
  title: '',
  content: ''
})

const saving = ref(false)
const lastSaved = ref<Date | null>(null)

const autoSave = useDebounceFn(async () => {
  saving.value = true
  try {
    // await saveForm(form.value)
    lastSaved.value = new Date()
  } catch (error) {
    ElMessage.error('自动保存失败')
  } finally {
    saving.value = false
  }
}, 2000)  // Debounce 2 seconds

watch(form, () => {
  autoSave()
}, { deep: true })
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="page-title">编辑文章</h1>
      <div class="auto-save-status">
        <el-icon v-if="saving"><Loading /></el-icon>
        <span v-else-if="lastSaved" class="text-muted">
          最后保存: {{ lastSaved.toLocaleTimeString() }}
        </span>
      </div>
    </div>

    <div class="page-card">
      <el-form :model="form" label-width="80px">
        <el-form-item label="标题">
          <el-input v-model="form.title" />
        </el-form-item>
        <el-form-item label="内容">
          <el-input v-model="form.content" type="textarea" :rows="10" />
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<style scoped>
.auto-save-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #909399;
  font-size: 14px;
}
</style>
```

---

## Inline Form Layout

For compact forms in toolbars or search bars.

```vue
<template>
  <el-form :inline="true" :model="searchForm" class="search-form">
    <el-form-item label="名称">
      <el-input
        v-model="searchForm.name"
        placeholder="请输入"
        clearable
        @keyup.enter="handleSearch"
      />
    </el-form-item>

    <el-form-item label="状态" style="min-width: clamp(100px, 16vw, 160px)">
      <el-select v-model="searchForm.status" placeholder="请选择" clearable>
        <el-option label="全部" value="" />
        <el-option label="启用" value="enabled" />
        <el-option label="禁用" value="disabled" />
      </el-select>
    </el-form-item>

    <el-form-item label="日期">
      <el-date-picker
        v-model="searchForm.date"
        type="daterange"
        range-separator="至"
        start-placeholder="开始日期"
        end-placeholder="结束日期"
      />
    </el-form-item>

    <el-form-item>
      <el-button type="primary" @click="handleSearch">搜索</el-button>
      <el-button @click="handleReset">重置</el-button>
    </el-form-item>
  </el-form>
</template>

<style scoped>
.search-form {
  margin-bottom: 20px;
  flex-wrap: wrap
}
</style>
```

---

## Form Pattern Decision Guide

| Need | Pattern |
|------|---------|
| Show/hide fields based on values | Conditional Form Items |
| Variable number of items | Dynamic Field Array |
| Check against API | Async Validation |
| Password strength, pattern matching | Complex Validation |
| Validate JSON/XML input | JSON Validation |
| Multi-page registration | Multi-Step Forms |
| Draft saving | Form with Auto-Save |
| Search/filter toolbar | Inline Form Layout |
