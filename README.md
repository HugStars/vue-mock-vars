# vue-mock-vars

<p align="center">
    <a href="https://www.npmjs.com/package/vue-mock-vars"><img src="https://img.shields.io/npm/v/vue-mock-vars" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/vue-mock-vars"><img src="https://img.shields.io/npm/dt/vue-mock-vars" alt="npm total downloads"></a>
    <br>
    <a href="./LICENSE"><img src="https://img.shields.io/npm/l/vue-mock-vars" alt="license"></a>
    <a href="./package.json"><img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="dependencies"></a>
    <br>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&amp;logoColor=white" alt="Node 18+"></a>
    <a href="https://vite.dev"><img src="https://img.shields.io/badge/Vite-4--8-646cff?logo=vite&amp;logoColor=white" alt="Vite 4-8"></a>
    <a href="https://vuejs.org"><img src="https://img.shields.io/badge/Vue-3-42b883?logo=vue.js&amp;logoColor=white" alt="Vue 3"></a>
    <a href="https://developer.mozilla.org/docs/Web/JavaScript/Guide/Modules"><img src="https://img.shields.io/badge/module-ESM-f7df1e?logo=javascript&amp;logoColor=black" alt="ESM"></a>
</p>

一个 Vite 插件，用于在 **开发/构建时** 将 Vue 组件中 `ref` / `reactive` 的初始值**自动替换为动态生成的 Mock 数据**。

数据在 Node 端生成、直接注入 Vue 源码，浏览器零打包体积、零运行时开销。

---

## 特性

- ⚡ **零运行时开销** — Mock 数据在 Vite `transform` 阶段生成并注入源码，浏览器端不打包任何数据
- 🎲 **动态随机** — 运行时按需生成，单次会话内保持稳定，重启后重新生成
- 🗂️ **自动路径映射** — mock 数据目录镜像 `srcDir` 结构，插件自动匹配，无需配置映射表
- 🪶 **零外部依赖** — 不依赖 mockjs / faker / chance 等第三方库
- 🔄 **支持 ref 和 reactive** — 两种声明方式均可处理
- ⏱️ **支持异步生成** — 生成函数可以返回 Promise
- 🔧 **完全可配置** — mockDir、srcDir、enable、logger 全部可选

---

## 为什么选择 vue-mock-vars？

与其他 Mock 方案的对比：

| 方案                 | 原理           | 运行时开销      | 适用场景                       |
| -------------------- | -------------- | --------------- | ------------------------------ |
| **vite-plugin-mock** | 拦截 HTTP 请求 | 需注册拦截器    | 需要模拟后端 API 响应          |
| **手写 ref 初始值**  | 硬编码在组件里 | 零              | 数据固定，不能随机             |
| **mockjs/faker**     | 运行时生成     | 需打包进 bundle | 需要在浏览器端生成数据         |
| **vue-mock-vars**    | 编译期注入     | **零**          | 页面开发期需要假数据、演示数据 |

**典型场景**：前端独立开发，需要假数据来渲染表格、表单、卡片等 UI，但不想把 mock 数据打包进最终产物。

---

## 安装

```bash
# pnpm（推荐）
pnpm add -D vue-mock-vars

# npm
npm install -D vue-mock-vars

# yarn
yarn add -D vue-mock-vars
```

> 该包应作为 **devDependency** 安装，仅在开发时使用。

---

## 快速开始

### 1. 配置插件

在 `vite.config.js` 中启用：

```js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueMockVars from 'vue-mock-vars'

export default defineConfig(({ mode }) => ({
    plugins: [
        vue(),
        VueMockVars({
            // mock 数据根目录，文件层级根据 srcDir 来
            // 文件夹位置可自定义
            mockDir: 'plugin/mock_vars',
            // Vue 源码根目录，mock 文件的目录结构对应这里
            srcDir: 'src',
            // 布尔值  仅在开发环境使用
            enable: mode === 'development'
        }) 
    ]
}))
```

> 只有开发环境注册插件时，生产构建完全不会包含此插件代码。

### 2. 创建 Mock 数据文件

在 `plugin/mock_vars/` 目录下，**按 `srcDir` 的镜像结构**创建 `.js` 文件。

**完整目录结构示例：**

```
your-project/
├── plugin/
│   └── mock_vars/              # ← mockDir 指向这里
│       ├── utils.js            # 可选：随机工具库
│       └── views/
│           └── TaskManagement/
│               ├── index.js    # 导出 tableData、tableTotal 生成函数
│               └── Add.js     # 导出 powerUsers 等生成函数
└── src/
    └── views/
        └── TaskManagement/
            ├── index.vue       # 包含 const tableData = ref([])
            └── Add.vue         # 包含 const powerUsers = ref([])
```

> **路径映射规则很简单**：`plugin/mock_vars/views/TaskManagement/index.js` → `src/views/TaskManagement/index.vue`。
> mockDir 下的目录结构直接镜像 `srcDir` 下的目录结构，去掉 `.js` 改为 `.vue` 即为目标文件。`srcDir` 默认是 `src`，可以按项目结构调整。

**`plugin/mock_vars/views/TaskManagement/index.js`：**

```js
import { pick, randInt, chineseName } from '../../utils.js'

const NAMES = ['张三', '李四', '王五', '赵六']
const STATUSES = ['处理中', '待处理', '已完成']

/** 生成 tableData — 函数名必须与 Vue 中 ref 变量名一致 */
export function tableData() {
    const len = randInt(3, 8)
    return Array.from({ length: len }, (_, i) => ({
        id: i + 1,
        name: pick(NAMES),
        status: pick(STATUSES),
        owner: chineseName()
    }))
}

/** 生成 tableTotal */
export function tableTotal() {
    return randInt(50, 200)
}
```

### 3. Vue 组件中声明 ref

```vue
<template>
    <el-table :data="tableData">
        <el-table-column prop="name" label="姓名" />
        <el-table-column prop="status" label="状态" />
    </el-table>
    <div>共 {{ tableTotal }} 条</div>
</template>

<script setup>
import { ref } from 'vue'

// 插件会自动将 ref([]) 替换为动态生成的数组
const tableData = ref([])

// 插件会自动将 ref(0) 替换为动态生成的数字
const tableTotal = ref(0)
</script>
```

启动 dev server 后，打开浏览器就能看到随机生成的 Mock 数据。

---

## 核心概念

### 路径映射

插件使用以下规则自动匹配 mock 文件和 Vue 组件：

| Mock 文件路径（相对 mockDir）   | 对应 Vue 组件（相对 src）        |
| ------------------------------- | -------------------------------- |
| `views/TaskManagement/index.js` | `views/TaskManagement/index.vue` |
| `views/Home/index.js`           | `views/Home/index.vue`           |
| `components/Header.js`          | `components/Header.vue`          |
| `views/Profile/sub/Bio.js`      | `views/Profile/sub/Bio.vue`      |

**匹配规则：**
1. 取 mock 文件相对 `mockDir` 的路径（如 `views/TaskManagement/index`）
2. 将扩展名 `.js` / `.ts` 替换为 `.vue`
3. 前面加上 `srcDir`（默认 `src/`）即为目标 Vue 组件路径

### 生成函数命名

每个 mock 文件导出的**函数名必须与 Vue 组件中 `ref` / `reactive` 的变量名完全一致**：

```vue
<!-- Vue 组件 -->
<script setup>
const powerUsers = ref([])          <!-- export function powerUsers() -->
const powerCompanies = ref([])      <!-- export function powerCompanies() -->
const config = reactive({})         <!-- export function config() -->
</script>
```

### 生成函数约定

每个生成函数应：
- **接收 0 个参数**
- **返回一个可 JSON 序列化的值**（对象、数组、字符串、数字、布尔值、null）
- **返回值类型与对应 ref 的期望类型一致**

```js
// ✅ 正确：返回数组
export function tableData() {
    return [{ id: 1, name: 'test' }]
}

// ✅ 正确：返回对象
export function userInfo() {
    return { name: '张三', age: 28 }
}

// ✅ 正确：返回基础类型
export function tableTotal() {
    return 128
}

// ❌ 错误：返回不可序列化的值
export function badData() {
    return () => {}  // 函数无法 JSON.stringify
}
```

---

## API

### `VueMockVars(options?)`

| 参数      | 类型      | 默认值               | 说明                                         |
| --------- | --------- | -------------------- | -------------------------------------------- |
| `mockDir` | `string`  | `'plugin/mock_vars'` | Mock 数据生成函数的根目录，相对于项目根目录  |
| `srcDir`  | `string`  | `'src'`              | Vue 源码根目录，mock 文件的目录结构对应这里  |
| `enable`  | `boolean` | `true`               | 是否启用插件。可用于环境判断                 |
| `logger`  | `boolean` | `true`               | 是否输出插件日志，警告信息始终输出           |

### 两种关闭插件的方式

**方式一：条件注册（推荐）**

```js
// 开发环境才注册，生产构建零影响
...(mode === 'development' ? [VueMockVars()] : [])
```

**方式二：enable 选项**

```js
VueMockVars({
    enable: process.env.NODE_ENV !== 'production'
})
```

---

## 工作原理

1. Vite 启动时，`configResolved` 钩子扫描 `mockDir` 下所有 `.js` / `.mjs` / `.ts` 文件
2. 使用 ESM `import()` 动态导入每个文件，收集所有**命名导出的函数**
3. 缓存每个文件的导出函数，再汇总成 `相对路径 → { 函数名: 函数 }` 的索引 Map
4. 每当 Vite transform 一个 `.vue` 文件时，只扫描 `<script>` / `<script setup>` 块，定位 `const|let X = ref|reactive(...)` 声明（支持 `ref<T>()` 泛型）
5. 如果变量名 `X` 在索引中有对应生成函数，**调用该函数**（支持返回 Promise），将返回值 `JSON.stringify` 后注入 ref 初始值
6. 替换在**源码层面**完成，浏览器端拿到的是已含数据的 ref，无任何运行时开销

> mock 文件变化时只重新导入变更的文件，再基于文件缓存重建索引，不会重新加载整个 `mockDir`。同一组件内的多个异步生成函数会并行执行，生成函数之间应保持相互独立。

---

## 常见问题

### Q: 这个插件只能在 Vite 环境使用吗？

**是的**。插件核心依赖 Vite Plugin API（`configResolved` + `transform`）。底层的扫描、导入、匹配逻辑是纯 Node 代码，理论上可以提取适配 Rollup/Webpack/Rspack，但目前是 Vite 专用。

### Q: mock 数据文件的位置和名字可以改吗？

**完全可以**。通过 `mockDir` 参数自由配置。例如：

```js
// 放在 src 内部
VueMockVars({ mockDir: 'src/mock' })

// 放在项目根
VueMockVars({ mockDir: 'test-data' })

// 放在任意位置
VueMockVars({ mockDir: 'packages/shared/mock' })
```

只要 mockDir 下的内部结构镜像 `srcDir` 即可。

### Q: 生成函数可以是异步的吗？

**可以**。生成函数可以返回 Promise，插件内部会 await：

```js
export async function tableData() {
    const data = await fetchFromSomewhere()
    return data
}
```

注意：返回值必须是可 `JSON.stringify` 的。

### Q: 如何只给某些组件启用 Mock？

只需在 mockDir 下创建对应路径的文件。**有文件的组件会被注入，没有的不会被影响**。

### Q: 支持 TypeScript 吗？

分两部分：

- **Vue 组件里**的 `ref<T>()`、`reactive<T>()` 泛型写法支持。
- **mock 文件**可以写成 `.ts`，但依赖 Node 原生导入 `.ts` 的能力：需要 Node 23.6+，或 Node 22.6+ 并开启 `--experimental-strip-types`。Node 18/20 请把 mock 文件写成 `.js` / `.mjs`，否则控制台会给出明确警告。

### Q: ref 的初始值必须是空数组吗？

不是。插件会完全替换括号内的内容，初始值写什么都行：

```js
const data = ref([])         // ✅ 可以
const data = ref(null)        // ✅ 可以
const data = ref({ list: [] }) // ✅ 可以
```

### Q: 一个组件里有多个 ref 怎么处理？

只要每个 ref 的变量名在 mock 文件中有对应的生成函数，就会被分别替换。一个 mock 文件可以导出任意数量的生成函数。

### Q: 使用 reactive 可以吗？

可以。`const obj = reactive({})` 会被替换为 `const obj = reactive({ key: 'value', ... })`。

### Q: 修改 mock 文件后需要重启 dev server 吗？

不需要。插件监听 `mockDir`，文件变化后只重新加载变更的文件并刷新页面。生成结果按组件变量缓存，同一会话内保持稳定，修改 mock 文件或重启 dev server 后重新生成。

如果修改的是被多个 mock 文件共享的工具模块（例如 `mock/utils.js`），受 Node ESM 缓存影响，建议重启 dev server。

### Q: 控制台没有看到加载日志？

检查：
1. `mockDir` 路径是否正确（相对于项目根目录）
2. mock 数据文件的内部结构是否镜像 `srcDir`
3. 开发服务器是否已重启（修改配置后需重启）

### Q: 看到 `无法加载 xxx.js` 警告？

通常是 import 路径错误。mock 文件使用相对路径导入工具库时，需要从文件位置回溯到 mockDir 根目录。检查 `../../utils.js` 的层级是否正确。如果是 `.ts` 文件，还要确认当前 Node 版本支持直接导入 TypeScript。

### Q: 页面上还是空数据，没有被注入？

检查：
1. Vue 组件中 ref 的变量名与 mock 导出的函数名**完全一致**
2. 组件文件路径与 mock 文件路径**镜像对应**（不含扩展名）
3. `srcDir` 是否指向 Vue 源码根目录
4. ref 使用的是 `ref()` 还是 `reactive()`（插件都支持）

---

## 开发与贡献

```bash
# 克隆项目
git clone https://github.com/HugStars/vue-mock-vars.git
cd vue-mock-vars

# 安装依赖
npm install

# 运行测试
npm test
```

## License

MIT © 2026 HugStars
