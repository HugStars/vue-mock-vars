/**
 * vue-mock-vars
 * @author HugStars
 * 一个 Vite 插件，用于在构建/开发时用动态生成的 mock 数据
 * 替换 Vue 组件中 ref/reactive 的初始值。
 *
 * 工作原理：
 * 1. 扫描 mockDir 下的 .js / .mjs / .ts 文件，按目录结构映射到 srcDir 下的 .vue 文件
 *    例：plugin/mock_vars/views/TaskManagement/Add.js → src/views/TaskManagement/Add.vue
 * 2. 每个 mock 文件导出的函数，函数名必须与 Vue 中 ref 变量名一致
 *    例：export function tableData() { return [...] } → 替换 const tableData = ref(...)
 * 3. transform 时，只在 <script> 块内定位 ref/reactive 声明，
 *    用生成函数的返回值 JSON 序列化后注入
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve, relative, join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const MOCK_FILE_RE = /\.(m?js|ts)$/i
const PAIRS = { '(': ')', '[': ']', '{': '}' }
const REGEX_FLAGS_RE = /[dgimsuvy]/
const IMPORT_BATCH_SIZE = 8

let importVersion = 0

/**
 * 提取错误信息，兼容 throw 非 Error 的情况
 * @param {unknown} err 捕获到的异常
 * @returns {string} 可读的错误信息
 */
function formatError(err) {
    return err instanceof Error ? err.message : String(err)
}

/**
 * 输出警告，警告不受 logger 选项控制
 * @param {string} msg 警告内容
 */
function warn(msg) {
    console.warn(`\x1b[33m[vue-mock-vars]\x1b[0m ${msg}`)
}

/**
 * 判断文件名是否为 mock 文件
 * @param {string} name 文件名或路径
 * @returns {boolean} 是否为 .js / .mjs / .ts
 */
function isMockFile(name) {
    // - 类型声明文件不可执行，不参与 mock 扫描
    if (/\.d\.ts$/i.test(name)) return false
    return MOCK_FILE_RE.test(name)
}

/**
 * 递归收集目录下的 mock 文件
 * @param {string} dir 目录绝对路径
 * @param {(msg: string) => void} onWarn 警告回调
 * @returns {string[]} mock 文件绝对路径列表
 */
function collectMockFiles(dir, onWarn) {
    const results = []
    let entries
    try {
        entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
        // - 目录不存在时静默，交给 configResolved 统一提示
        if (err?.code !== 'ENOENT') {
            onWarn(`无法读取目录 ${dir}：${formatError(err)}`)
        }
        return results
    }

    for (const entry of entries) {
        const full = join(dir, entry.name)
        // ! 不跟随符号链接目录，避免循环引用
        if (entry.isDirectory()) {
            // - 跳过依赖目录，避免扫描无关文件
            if (entry.name === 'node_modules') continue
            results.push(...collectMockFiles(full, onWarn))
        } else if (entry.isFile() && isMockFile(entry.name)) {
            results.push(full)
        }
    }
    return results
}

/**
 * 动态导入 mock 模块
 * 每次加载附加递增版本号，绕开 Node ESM 的模块缓存，
 * 否则修改 mock 文件后重新 import 拿到的仍是旧模块
 * @param {string} filePath mock 文件绝对路径
 * @returns {Promise<Object>} 模块命名空间对象
 */
function loadMockModule(filePath) {
    const url = `${pathToFileURL(filePath).href}?v=${++importVersion}`
    return import(url)
}

/**
 * 提示默认导出不会被使用
 * @param {Object} mod 模块命名空间对象
 * @param {string} relPath mock 文件相对路径
 * @param {(msg: string) => void} onWarn 警告回调
 * @returns {void}
 */
function warnDefaultExport(mod, relPath, onWarn) {
    const value = mod.default
    if (value === undefined) return

    const hasFunction = typeof value === 'function' ||
        (typeof value === 'object' && value !== null &&
            Object.values(value).some(item => typeof item === 'function'))
    if (hasFunction) {
        onWarn(`${relPath} 的默认导出不会被使用，请改为具名导出`)
    }
}

/**
 * 加载单个 mock 文件，收集命名导出的函数
 * @param {string} filePath mock 文件绝对路径
 * @param {string} mockDir mock 根目录绝对路径
 * @param {(msg: string) => void} onWarn 警告回调
 * @returns {Promise<{ entry: { filePath: string, key: string, generators: Object } | null, failed: boolean, relPath: string }>}
 *   entry 为 null 时表示加载失败，failed 用于统计
 */
async function loadMockEntry(filePath, mockDir, onWarn) {
    const relPath = relative(mockDir, filePath).replace(/\\/g, '/')
    const key = relPath.replace(MOCK_FILE_RE, '')

    let mod
    try {
        mod = await loadMockModule(filePath)
    } catch (err) {
        if (filePath.endsWith('.ts') && err?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
            onWarn(`无法加载 ${relPath}：当前 Node 版本不支持直接导入 .ts，请改用 .js 或升级 Node`)
        } else {
            onWarn(`加载 ${relPath} 失败：${formatError(err)}`)
        }
        return { entry: null, failed: true, relPath }
    }

    // 用无原型对象，避免 toString 之类的变量名命中 Object.prototype
    const generators = Object.create(null)
    for (const name of Object.keys(mod)) {
        if (name === 'default') continue
        if (typeof mod[name] === 'function') {
            generators[name] = mod[name]
        }
    }

    warnDefaultExport(mod, relPath, onWarn)

    return {
        entry: { filePath, key, generators },
        failed: false,
        relPath
    }
}

/**
 * 构建 mock 索引，按批并发导入文件
 * @param {string} mockDir mock 根目录绝对路径
 * @param {(msg: string) => void} onWarn 警告回调
 * @returns {Promise<{ entries: Array<{ filePath: string, key: string, generators: Object }>, scanned: number, failed: number }>}
 *   entries 保留所有成功加载的文件，冲突处理交给索引重建
 */
async function buildMockIndex(mockDir, onWarn) {
    const files = collectMockFiles(mockDir, onWarn).sort()
    const entries = []
    let failed = 0

    // note 分批并发，兼顾启动速度与事件循环压力
    for (let i = 0; i < files.length; i += IMPORT_BATCH_SIZE) {
        const batch = files.slice(i, i + IMPORT_BATCH_SIZE)
        const results = await Promise.all(
            batch.map(filePath => loadMockEntry(filePath, mockDir, onWarn))
        )
        for (const result of results) {
            if (result.failed) failed++
            if (result.entry) entries.push(result.entry)
        }
    }

    return { entries, scanned: files.length, failed }
}

/**
 * 统计索引中的生成函数总数
 * @param {Map<string, Object>} index mock 索引
 * @returns {number} 生成函数数量
 */
function countGenerators(index) {
    let total = 0
    for (const generators of index.values()) {
        total += Object.keys(generators).length
    }
    return total
}

// section 源码扫描

/**
 * 跳过单双引号字符串
 * @param {string} code 源码
 * @param {number} start 引号所在位置
 * @returns {number} 结束引号位置，未闭合返回 -1
 */
function skipQuoted(code, start) {
    const quote = code[start]
    for (let i = start + 1; i < code.length; i++) {
        if (code[i] === '\\') {
            i++
            continue
        }
        if (code[i] === quote) return i
    }
    return -1
}

/**
 * 粗略判断 / 是正则字面量开始还是除号
 * 依据前一个有效字符或关键字，尽量少误判
 * @param {string} code 源码
 * @param {number} pos / 所在位置
 * @returns {boolean} 是否为正则起始
 */
function isRegexStart(code, pos) {
    let i = pos - 1
    while (i >= 0 && /\s/.test(code[i])) i--
    if (i < 0) return true

    const ch = code[i]
    if (/[([{,;:=!&|?+\-*%^~<>]/.test(ch)) return true

    let start = i
    while (start >= 0 && /[\w$]/.test(code[start])) start--
    const word = code.slice(start + 1, i + 1)
    return /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(word)
}

/**
 * 跳过一个正则字面量
 * @param {string} code 源码
 * @param {number} start / 所在位置
 * @returns {number} 正则结束位置（含 flags），未闭合返回 -1
 */
function skipRegex(code, start) {
    let inClass = false
    for (let i = start + 1; i < code.length; i++) {
        const ch = code[i]
        if (ch === '\\') {
            i++
            continue
        }
        if (ch === '[') {
            inClass = true
        } else if (ch === ']') {
            inClass = false
        } else if (ch === '/' && !inClass) {
            let end = i + 1
            while (end < code.length && REGEX_FLAGS_RE.test(code[end])) end++
            return end - 1
        } else if (ch === '\n') {
            return -1
        }
    }
    return -1
}

/**
 * 跳过模板字符串，包括 ${} 中的表达式
 * @param {string} code 源码
 * @param {number} start 反引号所在位置
 * @returns {number} 结束反引号位置，未闭合返回 -1
 */
function skipTemplate(code, start) {
    for (let i = start + 1; i < code.length; i++) {
        const ch = code[i]
        if (ch === '\\') {
            i++
            continue
        }
        if (ch === '`') return i
        if (ch === '$' && code[i + 1] === '{') {
            const end = findMatching(code, i + 1)
            if (end === -1) return -1
            i = end
        }
    }
    return -1
}

/**
 * 找到与起始括号配对的结束括号位置
 * 跳过字符串、模板字符串、注释与正则字面量，避免把内容中的括号计入
 * @param {string} code 源码
 * @param {number} openPos 起始括号位置
 * @returns {number} 结束括号位置，未找到返回 -1
 */
function findMatching(code, openPos) {
    const open = code[openPos]
    const close = PAIRS[open]
    if (!close) return -1

    let depth = 0
    for (let i = openPos; i < code.length; i++) {
        const ch = code[i]
        const next = code[i + 1]

        if (ch === "'" || ch === '"') {
            const end = skipQuoted(code, i)
            if (end === -1) return -1
            i = end
            continue
        }
        if (ch === '`') {
            const end = skipTemplate(code, i)
            if (end === -1) return -1
            i = end
            continue
        }
        if (ch === '/' && next === '/') {
            const end = code.indexOf('\n', i + 2)
            if (end === -1) return -1
            i = end
            continue
        }
        if (ch === '/' && next === '*') {
            const end = code.indexOf('*/', i + 2)
            if (end === -1) return -1
            i = end + 1
            continue
        }
        if (ch === '/' && isRegexStart(code, i)) {
            const end = skipRegex(code, i)
            if (end === -1) return -1
            i = end
            continue
        }

        if (ch === open) {
            depth++
        } else if (ch === close) {
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

/**
 * 跳过 TS 泛型参数，返回匹配的 > 位置
 * @param {string} code 源码
 * @param {number} start < 所在位置
 * @returns {number} 匹配的 > 位置，未找到返回 -1
 */
function skipTypeArgs(code, start) {
    let depth = 0
    for (let i = start; i < code.length; i++) {
        const ch = code[i]

        if (ch === "'" || ch === '"') {
            const end = skipQuoted(code, i)
            if (end === -1) return -1
            i = end
            continue
        }
        if (ch === '`') {
            const end = skipTemplate(code, i)
            if (end === -1) return -1
            i = end
            continue
        }
        if (ch === '<') {
            depth++
        } else if (ch === '>') {
            // - 箭头函数类型的 => 不参与泛型计数
            if (code[i - 1] === '=') continue
            depth--
            if (depth === 0) return i
        }
    }
    return -1
}

/**
 * 跳过空白字符
 * @param {string} code 源码
 * @param {number} start 起始位置
 * @returns {number} 第一个非空白字符位置
 */
function skipSpace(code, start) {
    let i = start
    while (i < code.length && /\s/.test(code[i])) i++
    return i
}

/**
 * 判断指定位置是否位于代码区（不在字符串、模板字符串或注释中）
 * @param {string} code 源码
 * @param {number} target 待判断的位置
 * @returns {boolean} 是否位于可执行代码中
 */
function isCodePosition(code, target) {
    let i = 0
    while (i < target) {
        const ch = code[i]
        const next = code[i + 1]

        if (ch === "'" || ch === '"') {
            const end = skipQuoted(code, i)
            if (end === -1) return false
            i = end + 1
            continue
        }
        if (ch === '`') {
            const end = skipTemplate(code, i)
            if (end === -1) return false
            i = end + 1
            continue
        }
        if (ch === '/' && next === '/') {
            const end = code.indexOf('\n', i + 2)
            i = end === -1 ? code.length : end
            continue
        }
        if (ch === '/' && next === '*') {
            const end = code.indexOf('*/', i + 2)
            if (end === -1) return false
            i = end + 2
            continue
        }
        i++
    }
    return i === target
}

/**
 * 在 script 片段中查找 ref/reactive 声明
 * @param {string} segment script 块内容
 * @returns {Array<{ varName: string, openParenPos: number, closeParenPos: number }>}
 */
function findDeclarations(segment) {
    const result = []
    const declRegex = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(ref|reactive)\b/g

    for (const match of segment.matchAll(declRegex)) {
        if (!isCodePosition(segment, match.index)) continue

        const varName = match[1]
        let pos = skipSpace(segment, match.index + match[0].length)

        // - TypeScript 泛型：ref<T>() / reactive<T>()
        if (segment[pos] === '<') {
            const end = skipTypeArgs(segment, pos)
            if (end === -1) continue
            pos = skipSpace(segment, end + 1)
        }

        if (segment[pos] !== '(') continue

        const closeParenPos = findMatching(segment, pos)
        if (closeParenPos === -1) continue

        result.push({ varName, openParenPos: pos, closeParenPos })
    }

    return result
}

/**
 * 收集 SFC 中 <script> / <script setup> 块的内容范围
 * @param {string} code SFC 源码
 * @returns {Array<{ start: number, end: number }>} 内容区间列表
 */
function collectScriptRanges(code) {
    const ranges = []
    const tagRegex = /<script\b([^>]*)>/gi
    let match

    while ((match = tagRegex.exec(code)) !== null) {
        const attrs = match[1]
        const tag = match[0]
        const start = match.index + tag.length

        // - 自闭合标签没有内容，直接跳过
        if (tag.endsWith('/>')) continue

        const close = code.indexOf('</script>', start)
        if (close === -1) break

        // - <script src="..."> 引入外部脚本，不处理
        if (!/\bsrc\s*=/.test(attrs)) {
            ranges.push({ start, end: close })
        }
        tagRegex.lastIndex = close + '</script>'.length
    }

    return ranges
}

/**
 * 将 mock 值序列化为可安全注入 SFC 的 JS 表达式
 * @param {any} value 生成函数返回值
 * @returns {string | undefined} 序列化结果，无法序列化时返回 undefined
 */
function serializeValue(value) {
    let json = JSON.stringify(value)
    if (json === undefined) return undefined

    // - 对象字面量中的 "__proto__" 键会改原型，转成计算属性保留普通键语义
    if (json.includes('__proto__')) {
        json = json.replace(/([{,]\s*)"__proto__"(\s*:)/g, '$1["__proto__"]$2')
    }

    // note 只有出现特殊字符时才做一次整体转义，避免无谓的字符串复制
    if (json.includes('<') || json.includes('\u2028') || json.includes('\u2029')) {
        json = json.replace(/[<\u2028\u2029]/g, ch => {
            if (ch === '<') return '\\u003c'
            return ch === '\u2028' ? '\\u2028' : '\\u2029'
        })
    }

    return json
}

// section 插件入口

/**
 * 主插件函数
 *
 * @param {Object} options 插件选项
 * @param {string} [options.mockDir] mock 数据生成函数的根目录
 *   相对于项目根目录的路径，默认 'plugin/mock_vars'
 * @param {string} [options.srcDir] Vue 源码根目录，默认 'src'
 * @param {boolean} [options.enable] 是否启用插件，默认 true
 * @param {boolean} [options.logger] 是否打印普通日志，默认 true
 * @returns {import('vite').Plugin} Vite 插件对象
 */
export default function vueMockVars(options = {}) {
    const {
        mockDir = 'plugin/mock_vars',
        srcDir = 'src',
        enable = true,
        logger = true
    } = options

    let resolvedSrcDir = null
    let resolvedMockDir = null
    let mockIndex = null
    let isSetup = false
    let warnedConflicts = new Set()
    const valueCache = new Map()
    const mockFileCache = new Map()

    /**
     * 输出普通日志
     * @param {string} msg 日志内容
     * @returns {void}
     */
    function log(msg) {
        if (logger) {
            console.log(`\x1b[36m[vue-mock-vars]\x1b[0m ${msg}`)
        }
    }

    /**
     * 获取并缓存生成函数的返回值
     * 同一组件变量在单次会话内复用，mock 文件变化后由 reload 清空缓存
     * @param {string} key 缓存键
     * @param {() => any} generator 生成函数
     * @returns {Promise<any>} 生成结果
     */
    async function getMockValue(key, generator) {
        if (valueCache.has(key)) {
            return valueCache.get(key)
        }

        const pending = (async () => generator())()
        valueCache.set(key, pending)
        try {
            return await pending
        } catch (err) {
            // - 失败不缓存，下次 transform 重新尝试
            valueCache.delete(key)
            throw err
        }
    }

    /**
     * 根据文件缓存重建索引
     * 只做 Map 操作，不重新 import，增量重载时成本很低
     * @returns {void}
     */
    function rebuildIndex() {
        const index = new Map()
        const conflicts = new Set()
        const files = [...mockFileCache.keys()].sort()

        for (const filePath of files) {
            const entry = mockFileCache.get(filePath)
            if (!entry || Object.keys(entry.generators).length === 0) continue
            if (index.has(entry.key)) {
                conflicts.add(entry.key)
                continue
            }
            index.set(entry.key, entry.generators)
        }

        for (const key of conflicts) {
            if (!warnedConflicts.has(key)) {
                warn(`多个 mock 文件映射到 ${key}，已按路径排序使用第一个`)
            }
        }

        warnedConflicts = conflicts
        mockIndex = index
    }

    /**
     * 用全量构建结果重置文件缓存和索引
     * @param {Array<{ filePath: string, key: string, generators: Object }>} entries 文件条目
     * @returns {void}
     */
    function applyEntries(entries) {
        mockFileCache.clear()
        for (const entry of entries) {
            mockFileCache.set(entry.filePath, entry)
        }
        rebuildIndex()
    }

    /**
     * 生成索引统计文案
     * @param {number} scanned 扫描文件数
     * @param {number} failed 失败文件数
     * @returns {string} 统计文案
     */
    function formatSummary(scanned, failed) {
        const failedText = failed > 0 ? `，失败 ${failed} 个` : ''
        return `${mockIndex.size} 个 mock 文件（扫描 ${scanned} 个${failedText}），共 ${countGenerators(mockIndex)} 个生成函数`
    }

    /**
     * 执行单个 ref 注入任务
     * @param {{ start: number, end: number, varName: string, originalInner: string, cacheKey: string }} task 任务
     * @param {Object} generators 生成函数集合
     * @param {string} vueRelPath 组件相对路径
     * @returns {Promise<Object | null>} 替换项或 null
     */
    async function runInjection(task, generators, vueRelPath) {
        try {
            const value = await getMockValue(task.cacheKey, generators[task.varName])
            const serialized = serializeValue(value)

            if (serialized === undefined) {
                warn(`${vueRelPath} 的 ${task.varName}() 返回了无法序列化的值，已跳过`)
                return null
            }
            if (serialized === task.originalInner.trim()) return null

            return {
                start: task.start,
                end: task.end,
                serialized,
                varName: task.varName
            }
        } catch (err) {
            warn(`${vueRelPath} 的 ${task.varName}() 执行失败：${formatError(err)}`)
            return null
        }
    }

    return {
        name: 'vue-mock-vars',
        enforce: 'pre',

        async configResolved(config) {
            if (!enable) return

            resolvedSrcDir = resolve(config.root, srcDir)
            resolvedMockDir = resolve(config.root, mockDir)

            if (config.command === 'build') {
                warn('当前为 build 模式，mock 数据会写入产物；如非预期请设置 enable: false')
            }

            if (!existsSync(resolvedMockDir)) {
                warn(`mockDir 不存在：${resolvedMockDir}`)
                mockIndex = new Map()
                mockFileCache.clear()
                isSetup = true
                return
            }

            const result = await buildMockIndex(resolvedMockDir, warn)
            applyEntries(result.entries)
            isSetup = true
            log(`已加载 ${formatSummary(result.scanned, result.failed)}`)
        },

        configureServer(server) {
            if (!enable || !resolvedMockDir) return

            let timer = null
            let queue = Promise.resolve()

            /**
             * 判断文件是否位于 mockDir 下
             * @param {string} filePath 文件绝对路径
             * @returns {boolean}
             */
            const isMockPath = (rawPath) => {
                const filePath = resolve(rawPath)
                if (!isMockFile(filePath)) return false
                const relPath = relative(resolvedMockDir, filePath).replace(/\\/g, '/')
                return relPath !== '' &&
                    relPath !== '..' &&
                    !relPath.startsWith('../') &&
                    !isAbsolute(relPath)
            }

            /**
             * 处理单个变更文件，文件被删除时返回 removed 标记
             * @param {string} filePath 文件绝对路径
             * @returns {Promise<{ filePath: string, entry: Object | null, removed: boolean }>}
             */
            const resolveChange = async (filePath) => {
                if (!existsSync(filePath)) {
                    return { filePath, entry: null, removed: true }
                }
                const result = await loadMockEntry(filePath, resolvedMockDir, warn)
                return {
                    filePath,
                    entry: result.failed ? null : result.entry,
                    removed: false
                }
            }

            /**
             * 增量重载变更文件，只重新导入变化的模块
             * @param {string[]} filePaths 变更文件绝对路径
             * @returns {Promise<void>}
             */
            const reloadFiles = async (filePaths) => {
                const changes = await Promise.all(filePaths.map(resolveChange))
                let changed = false

                for (const change of changes) {
                    if (change.removed) {
                        if (mockFileCache.delete(change.filePath)) changed = true
                    } else if (change.entry) {
                        mockFileCache.set(change.entry.filePath, change.entry)
                        changed = true
                    }
                }

                if (!changed) return

                rebuildIndex()
                valueCache.clear()
                const summary = `${mockIndex.size} 个映射、${countGenerators(mockIndex)} 个生成函数`
                log(`已更新 ${filePaths.length} 个 mock 文件，当前 ${summary}`)
                server.ws.send({ type: 'full-reload' })
            }

            // note 防抖 + 串行，避免批量改动时并发重建导致旧结果覆盖新结果
            const pendingFiles = new Set()
            const schedule = (filePath) => {
                const fullPath = resolve(filePath)
                if (!isMockPath(fullPath)) return
                pendingFiles.add(fullPath)
                if (timer) clearTimeout(timer)
                timer = setTimeout(() => {
                    timer = null
                    const files = [...pendingFiles]
                    pendingFiles.clear()
                    queue = queue.then(() => reloadFiles(files)).catch(err => {
                        warn(`重新加载 mock 失败：${formatError(err)}`)
                    })
                }, 150)
            }

            server.watcher.on('change', schedule)
            server.watcher.on('add', schedule)
            server.watcher.on('unlink', schedule)

            server.httpServer?.once('close', () => {
                if (timer) clearTimeout(timer)
            })
        },

        async transform(code, id) {
            if (!enable || !isSetup || !mockIndex || mockIndex.size === 0) return null

            const cleanId = id.split('?')[0]
            if (cleanId.includes('\0') || !cleanId.endsWith('.vue')) return null

            const vueRelPath = relative(resolvedSrcDir, cleanId).replace(/\\/g, '/')
            if (!vueRelPath ||
                vueRelPath === '..' ||
                vueRelPath.startsWith('../') ||
                isAbsolute(vueRelPath)) {
                return null
            }

            const generators = mockIndex.get(vueRelPath.replace(/\.vue$/i, ''))
            if (!generators) return null

            const tasks = []
            for (const range of collectScriptRanges(code)) {
                const segment = code.slice(range.start, range.end)
                for (const decl of findDeclarations(segment)) {
                    if (!Object.hasOwn(generators, decl.varName)) continue

                    const start = range.start + decl.openParenPos + 1
                    const end = range.start + decl.closeParenPos
                    tasks.push({
                        start,
                        end,
                        varName: decl.varName,
                        originalInner: code.slice(start, end),
                        cacheKey: `${vueRelPath}:${decl.varName}`
                    })
                }
            }

            if (tasks.length === 0) return null

            // note 多个异步生成函数并行执行，避免串行累加等待时间
            const results = await Promise.all(
                tasks.map(task => runInjection(task, generators, vueRelPath))
            )
            const replacements = results.filter(item => item !== null)

            if (replacements.length === 0) return null

            // 从后往前替换，避免位置偏移
            replacements.sort((a, b) => b.start - a.start)
            let result = code
            for (const item of replacements) {
                result = result.slice(0, item.start) + item.serialized + result.slice(item.end)
            }

            const injected = replacements
                .slice()
                .sort((a, b) => a.start - b.start)
                .map(item => item.varName)
            log(`${vueRelPath}：注入 ${injected.join(', ')}`)

            return { code: result, map: null }
        }
    }
}
