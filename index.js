/**
 * vue-mock-vars
 * @author HugStars
 * 一个 Vite 插件，用于在构建/开发时用动态生成的 mock 数据
 * 替换 Vue 组件中 ref/reactive 的初始值。
 *
 * 工作原理：
 * 1. 扫描 mockDir 下的 .js 文件，按文件夹结构映射到 src/ 下的 .vue 文件
 *    例：plugin/mock_vars/views/TaskManagement/Add.js → src/views/TaskManagement/Add.vue
 *    其中 plugin/mock_vars 就是 配置的 mockDir 
 * 2. 每个 mock 文件导出的函数，函数名必须与 Vue 中 ref 变量名一致
 *    例：export function tableData() { return [...] } → 替换 const tableData = ref(...)
 * 3. transform 时，用生成函数的返回值 JSON 序列化后注入 ref()
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 递归收集目录下所有 .js / .mjs 文件 */
function collectMockFiles(dir) {
    const results = []
    try {
        const entries = readdirSync(dir)
        for (const entry of entries) {
            const full = join(dir, entry)
            const s = statSync(full)
            if (s.isDirectory()) {
                results.push(...collectMockFiles(full))
            } else if (/\.(m?js|ts)$/.test(entry)) {
                results.push(full)
            }
        }
    } catch {
        // 目录不存在时静默返回空数组
    }
    return results
}

/**
 * 构建 mock 索引：从 mockDir 路径相对起点到文件导出函数的映射
 *
 * @param {string} mockDir 绝对路径，如 plugin/mock_vars
 * @returns {Promise<Map<string, Object>>}
 *   key: 'views/TaskManagement/Add' (不含扩展名)
 *   value: { tableData: fn, tableTotal: fn, ... }
 */
async function buildMockIndex(mockDir) {
    const index = new Map()
    const files = collectMockFiles(mockDir)

    for (const filePath of files) {
        // 转为相对 mockDir 的路径
        const relPath = relative(mockDir, filePath).replace(/\\/g, '/')
        const withoutExt = relPath.replace(/\.(m?js|ts)$/i, '')

        try {
            // 转换为 file:// URL 进行 ESM 动态导入
            const fileUrl = pathToFileURL(filePath).href
            const mod = await import(fileUrl)

            // 只收集命名导出的函数（排除默认导出）
            const generators = {}
            for (const key of Object.keys(mod)) {
                if (key === 'default') continue
                const val = mod[key]
                if (typeof val === 'function') {
                    generators[key] = val
                }
            }

            if (Object.keys(generators).length > 0) {
                index.set(withoutExt, generators)
            }
        } catch (err) {
            console.warn(`[vue-mock-vars] Failed to load ${relPath}:`, err.message)
        }
    }

    return index
}

/**
 * 找到与起始括号配对的结束括号位置
 * @param {string} code
 * @param {number} openPos 起始括号 '(' 的位置
 * @returns {number} 结束括号 ')' 的位置，或 -1
 */
function findMatchingParen(code, openPos) {
    let depth = 0
    for (let i = openPos; i < code.length; i++) {
        const ch = code[i]
        if (ch === '(') depth++
        else if (ch === ')') {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

/**
 * 主插件函数
 *
 * @param {Object} options
 * @param {string} [options.mockDir] mock 数据生成函数的根目录
 *   相对于项目根目录的路径，默认 'plugin/mock_vars'
 * @param {boolean} [options.enable] 是否启用插件，默认 true
 * @param {boolean} [options.logger] 是否打印日志，默认 true
 * @returns {import('vite').Plugin}
 */
export default function vueMockVars(options = {}) {
    const {
        mockDir = 'plugin/mock_vars',
        enable = true,
        logger = true
    } = options

    let resolvedRoot = null
    let resolvedMockDir = null
    let mockIndex = null
    let isSetup = false

    function log(msg) {
        if (logger) {
            console.log(`\x1b[36m[vue-mock-vars]\x1b[0m ${msg}`)
        }
    }

    return {
        name: 'vue-mock-vars',
        enforce: 'pre',

        async configResolved(config) {
            if (!enable) return
            resolvedRoot = config.root
            resolvedMockDir = resolve(resolvedRoot, mockDir)
            mockIndex = await buildMockIndex(resolvedMockDir)
            isSetup = true

            const totalFiles = mockIndex.size
            const totalFns = Array.from(mockIndex.values())
                .reduce((s, g) => s + Object.keys(g).length, 0)
            log(`Loaded ${totalFiles} mock file(s), ${totalFns} generator function(s)`)
        },

        configureServer(server) {
            if (!enable) return

            const watchDir = resolvedMockDir.replace(/\\/g, '/')

            const reload = async (filePath) => {
                if (!resolvedMockDir) return
                const normPath = filePath.replace(/\\/g, '/')
                if (!normPath.startsWith(watchDir)) return
                if (!/\.(m?js|ts)$/.test(filePath)) return

                mockIndex = await buildMockIndex(resolvedMockDir)
                const totalFiles = mockIndex.size
                const totalFns = Array.from(mockIndex.values())
                    .reduce((s, g) => s + Object.keys(g).length, 0)
                log(`Reloaded ${totalFiles} mock file(s), ${totalFns} generator function(s)`)
                server.ws.send({ type: 'full-reload' })
            }

            server.watcher.on('change', reload)
            server.watcher.on('add', reload)
            server.watcher.on('unlink', reload)
        },

        async transform(code, id) {
            if (!enable || !isSetup) return null
            if (!id.endsWith('.vue')) return null

            // 计算 .vue 文件相对于 src/ 的路径（不含扩展名）
            const normId = id.replace(/\\/g, '/').replace(/^file:\/\//i, '')
            const srcIdx = normId.indexOf('/src/')
            if (srcIdx < 0) return null

            const vueRelPath = normId.slice(srcIdx + 5).replace(/\.vue$/, '')

            // 查找对应的 mock 生成函数集合
            const generators = mockIndex.get(vueRelPath)
            if (!generators || Object.keys(generators).length === 0) return null

            const keys = Object.keys(generators)
            let result = code

            // 查找所有 const/let X = ref(...) 声明
            // 需要手动遍历匹配位置，因为要对匹配位置做替换
            const replacements = []

            const regex = /(const|let)\s+(\w+)\s*=\s*(ref|reactive)\s*\(/g
            let match
            while ((match = regex.exec(code)) !== null) {
                const varName = match[2]
                if (!keys.includes(varName)) continue

                const openParenPos = match.index + match[0].length - 1
                const closeParenPos = findMatchingParen(code, openParenPos)
                if (closeParenPos === -1) continue

                // 调用生成函数
                const generator = generators[varName]
                let mockValue
                try {
                    mockValue = generator()
                } catch (err) {
                    log(`Error calling ${vueRelPath}/${varName}(): ${err.message}`)
                    continue
                }

                // JSON 序列化为 JS 字符串
                const serialized = JSON.stringify(mockValue)
                const originalInner = code.slice(openParenPos + 1, closeParenPos)

                if (serialized === originalInner.trim()) continue

                replacements.push({
                    start: openParenPos + 1,
                    end: closeParenPos,
                    replacement: serialized
                })
            }

            if (replacements.length === 0) return null

            // 从后向前替换，避免位置偏移
            replacements.sort((a, b) => b.start - a.start)
            for (const r of replacements) {
                result = result.slice(0, r.start) + r.replacement + result.slice(r.end)
            }

            if (logger) {
                const replaced = replacements.map(r => {
                    // 找到对应变量名
                    const before = code.slice(0, r.start)
                    const varMatch = before.match(/(\w+)\s*=\s*(ref|reactive)\s*\($/)
                    return varMatch ? varMatch[1] : '?'
                }).join(', ')
                log(`${vueRelPath}: injected [${replaced}]`)
            }

            return result
        }
    }
}
