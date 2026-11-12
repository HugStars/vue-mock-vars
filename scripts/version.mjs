import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkgPath = join(root, 'package.json')
const LEVELS = ['patch', 'minor', 'major']
const level = process.argv[2] || 'patch'

function Fail(message) {
    console.error(message)
    process.exit(1)
}

if (!LEVELS.includes(level)) Fail(`版本级别必须是 ${LEVELS.join(' / ')}`)

const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
if (status) Fail('工作区有未提交改动，先提交或清理后再发版')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const parts = String(pkg.version).split('.').map(Number)
if (parts.length !== 3 || parts.some(Number.isNaN)) Fail(`无法解析版本号：${pkg.version}`)

const [major, minor, patch] = parts
const next = level === 'major'
    ? `${major + 1}.0.0`
    : level === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`
const tag = `v${next}`

const exists = execFileSync('git', ['tag', '-l', tag], { cwd: root, encoding: 'utf8' }).trim()
if (exists) Fail(`tag ${tag} 已存在，先确认版本号`)

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf8')

execFileSync('git', ['add', 'package.json'], { cwd: root })
execFileSync('git', ['commit', '-m', `🔧 chore(package): 发布 ${next}`], { cwd: root })
execFileSync('git', ['tag', '-a', tag, '-m', `vue-mock-vars ${next}`], { cwd: root })

console.log(`版本已更新到 ${next}，已提交并创建 tag ${tag}`)
