/**
 * Reproduce the client-modules Host-side scan (packages/client/modules/src/index.ts
 * resolveMeta → locatePkgJson → nearestPackage → parseDshClient → clientExportOf)
 * against the live profile and this bundle, using the same resolution the Host
 * falls back to (createRequire from the profile base URL). Diagnostic only:
 * run with the profile-linked Node; never contacts NVIDIA.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const PROFILE_ROOT = `${process.env.HOME}/.dsh/profiles/web`
const SPECIFIER = '@local/dsh-llm-nvidia-router'

function exactPackageSpecifier(specifier) {
	if (specifier.startsWith('@')) {
		const parts = specifier.split('/')
		return parts.length === 2 && parts.every(Boolean) ? specifier : undefined
	}
	return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
}

function nearestPackage(moduleUrl, expectedPackageName) {
	if (!moduleUrl.startsWith('file:')) return undefined
	let dir = dirname(fileURLToPath(moduleUrl))
	while (true) {
		const candidate = join(dir, 'package.json')
		if (existsSync(candidate)) {
			try {
				const name = JSON.parse(readFileSync(candidate, 'utf8')).name
				if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
					return { path: candidate, packageName: name }
				}
			} catch { /* unreadable intermediate manifest: keep walking */ }
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return undefined
}

function parseDshClient(pkgName, value) {
	if (value === undefined) return undefined
	if (typeof value !== 'object' || value === null) throw new Error(`non-object dsh.client: ${pkgName}`)
	if (typeof value.platform !== 'string') throw new Error(`platform must be string: ${pkgName}`)
	for (const field of ['inject', 'external']) {
		const v = value[field]
		if (v !== undefined && (!Array.isArray(v) || v.some(i => typeof i !== 'string'))) throw new Error(`${field} must be string[]`)
	}
	if (value.immediately !== undefined && typeof value.immediately !== 'boolean') throw new Error('immediately must be boolean')
	return value
}

function clientExportOf(pkgName, exportsField) {
	if (typeof exportsField !== 'object' || exportsField === null) return undefined
	const client = exportsField['./client']
	if (client === undefined) return undefined
	if (typeof client === 'string') return client
	if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default
	throw new Error(`${pkgName} exports["./client"] must be a string or object with string default`)
}

// locatePkgJson: the Host's loader.internal branch resolves the bare specifier
// itself (createRequire(`${pkg}/package.json`) would hit ERR_PACKAGE_PATH_NOT_EXPORTED
// for an exports map without a './package.json' entry); nearestPackage then walks up.
const require = createRequire(pathToFileURL(`${PROFILE_ROOT}/`).href)
let located
try {
	const resolvedPath = require.resolve(SPECIFIER)
	located = nearestPackage(pathToFileURL(resolvedPath).href, SPECIFIER)
} catch (error) {
	console.log('bare-specifier resolve FAILED:', error.code, error.message.split('\n')[0])
	process.exit(1)
}
console.log('manifest:', located.path)
console.log('packageName matches:', located.packageName === SPECIFIER)

const pkg = JSON.parse(readFileSync(located.path, 'utf8'))
const decl = parseDshClient(located.packageName, pkg.dsh?.client)
console.log('dsh.client:', JSON.stringify(decl))
if (decl === undefined || decl.platform !== 'web') {
	console.log('VERDICT: not a client row (negative verdict, cached until restart)')
	process.exit(1)
}
const clientRel = clientExportOf(located.packageName, pkg.exports)
if (clientRel === undefined) throw new Error('declares dsh.client but exports no "./client"')
const clientPath = join(dirname(located.path), clientRel)
const stats = statSync(clientPath)
const bundle = readFileSync(clientPath)
console.log('clientPath:', clientPath)
console.log('bundle bytes:', bundle.length, 'mtimeMs:', stats.mtimeMs)
console.log('registers via __ModuleLoader__.load with id:', /window\.__ModuleLoader__\.load\(\{\s*\n?\s*id:\s*"([^"]+)"/.exec(bundle)?.[1])
console.log('VERDICT: scan succeeds → graph row id =', located.packageName)
