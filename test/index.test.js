import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import vueMockVars from '../index.js'

/**
 * 在临时目录中创建项目文件
 * @param {Record<string, string>} files 相对路径到内容的映射
 * @returns {string} 临时项目根目录
 */
function createProject(files) {
    const root = mkdtempSync(join(tmpdir(), 'vue-mock-vars-'))
    // 临时项目按 ESM 处理，Node 18 也能直接导入 .js mock 文件
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    for (const [path, content] of Object.entries(files)) {
        const full = join(root, path)
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, content)
    }
    return root
}

/**
 * 运行一次插件 transform
 * @param {Record<string, string>} files 项目文件
 * @param {string} vuePath 目标 Vue 文件相对路径
 * @param {Object} [options] 插件选项
 * @returns {Promise<string>} 转换后的代码
 */
async function runTransform(files, vuePath, options = {}) {
    const root = createProject(files)
    try {
        const plugin = vueMockVars({ mockDir: 'mock', logger: false, ...options })
        await plugin.configResolved({ root, command: 'serve' })
        const result = await plugin.transform(files[vuePath], join(root, vuePath))
        return result?.code ?? files[vuePath]
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

test('注入同步生成函数的返回值', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function tableData() { return [{ id: 1 }] }',
        'src/views/Add.vue': '<script setup>\nconst tableData = ref([])\n</script>'
    }, 'src/views/Add.vue')

    assert.match(code, /const tableData = ref\(\[\{"id":1\}\]\)/)
})

test('等待异步生成函数', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export async function tableData() { return [{ id: 2 }] }',
        'src/views/Add.vue': '<script setup>\nconst tableData = ref([])\n</script>'
    }, 'src/views/Add.vue')

    assert.match(code, /\[\{"id":2\}\]/)
})

test('不会把字符串里的括号当成 ref 的结束括号', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function text() { return "x" }',
        'src/views/Add.vue': '<script setup>\nconst text = ref(")")\n</script>'
    }, 'src/views/Add.vue')

    assert.match(code, /const text = ref\("x"\)/)
})

test('只替换 script 块内的 ref 声明', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function tableData() { return [{ id: 1 }] }',
        'src/views/Add.vue': [
            '<template>',
            '    <pre>const tableData = ref([])</pre>',
            '</template>',
            '<script setup>',
            'const tableData = ref([])',
            '</script>'
        ].join('\n')
    }, 'src/views/Add.vue')

    assert.match(code, /<pre>const tableData = ref\(\[\]\)<\/pre>/)
    assert.match(code, /const tableData = ref\(\[\{"id":1\}\]\)/)
})

test('支持 ref<T>() 泛型写法', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function tableData() { return [{ id: 1 }] }',
        'src/views/Add.vue': '<script setup lang="ts">\nconst tableData = ref<{ id: number }[]>([])\n</script>'
    }, 'src/views/Add.vue')

    assert.match(code, /ref<\{ id: number \}\[]>\(\[\{"id":1\}\]\)/)
})

test('转义注入内容中的 </script>', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function html() { return "</script><script>alert(1)</script>" }',
        'src/views/Add.vue': '<script setup>\nconst html = ref("")\n</script>'
    }, 'src/views/Add.vue')

    assert.ok(!code.includes('</script><script>'))
    assert.ok(code.includes('\\u003c/script>'))
})

test('生成函数返回 undefined 时保持原样', async () => {
    const source = '<script setup>\nconst nothing = ref([])\n</script>'
    const code = await runTransform({
        'mock/views/Add.js': 'export function nothing() {}',
        'src/views/Add.vue': source
    }, 'src/views/Add.vue')

    assert.equal(code, source)
})

test('支持自定义 srcDir', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function tableData() { return [1] }',
        'app/views/Add.vue': '<script setup>\nconst tableData = ref([])\n</script>'
    }, 'app/views/Add.vue', { srcDir: 'app' })

    assert.match(code, /const tableData = ref\(\[1\]\)/)
})

test('不替换 script 注释中的 ref 声明', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function tableData() { return [1] }',
        'src/views/Add.vue': [
            '<script setup>',
            '// const tableData = ref([])',
            'const tableData = ref([])',
            '</script>'
        ].join('\n')
    }, 'src/views/Add.vue')

    assert.match(code, /\/\/ const tableData = ref\(\[\]\)/)
    assert.match(code, /const tableData = ref\(\[1\]\)/)
})

test('__proto__ 键不会污染原型', async () => {
    const code = await runTransform({
        'mock/views/Add.js': 'export function data() { return JSON.parse(\'{"__proto__":{"polluted":true}}\') }',
        'src/views/Add.vue': '<script setup>\nconst data = ref({})\n</script>'
    }, 'src/views/Add.vue')

    assert.ok(code.includes('{["__proto__"]:{"polluted":true}}'))
})

test('修改 mock 文件后增量重载生效', async () => {
    const root = createProject({
        'mock/views/Add.js': 'export function tableData() { return [1] }',
        'src/views/Add.vue': '<script setup>\nconst tableData = ref([])\n</script>'
    })

    try {
        const plugin = vueMockVars({ mockDir: 'mock', logger: false })
        await plugin.configResolved({ root, command: 'serve' })

        const vuePath = join(root, 'src/views/Add.vue')
        const mockPath = join(root, 'mock/views/Add.js')
        const watcher = new EventEmitter()
        plugin.configureServer({
            watcher,
            ws: { send() {} },
            httpServer: null
        })

        const source = '<script setup>\nconst tableData = ref([])\n</script>'
        const first = await plugin.transform(source, vuePath)
        assert.match(first.code, /\[1\]/)

        writeFileSync(mockPath, 'export function tableData() { return [2] }')
        watcher.emit('change', mockPath)
        await new Promise(resolve => setTimeout(resolve, 300))

        const second = await plugin.transform(source, vuePath)
        assert.match(second.code, /\[2\]/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('批量修改多个 mock 文件时全部生效', async () => {
    const root = createProject({
        'mock/views/Add.js': 'export function tableData() { return [1] }',
        'mock/views/List.js': 'export function tableData() { return [1] }',
        'src/views/Add.vue': '<script setup>\nconst tableData = ref([])\n</script>',
        'src/views/List.vue': '<script setup>\nconst tableData = ref([])\n</script>'
    })

    try {
        const plugin = vueMockVars({ mockDir: 'mock', logger: false })
        await plugin.configResolved({ root, command: 'serve' })

        const watcher = new EventEmitter()
        plugin.configureServer({
            watcher,
            ws: { send() {} },
            httpServer: null
        })

        const addMock = join(root, 'mock/views/Add.js')
        const listMock = join(root, 'mock/views/List.js')
        writeFileSync(addMock, 'export function tableData() { return [2] }')
        writeFileSync(listMock, 'export function tableData() { return [3] }')
        watcher.emit('change', addMock)
        watcher.emit('change', listMock)
        await new Promise(resolve => setTimeout(resolve, 300))

        const source = '<script setup>\nconst tableData = ref([])\n</script>'
        const addCode = await plugin.transform(source, join(root, 'src/views/Add.vue'))
        const listCode = await plugin.transform(source, join(root, 'src/views/List.vue'))

        assert.match(addCode.code, /\[2\]/)
        assert.match(listCode.code, /\[3\]/)
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})
