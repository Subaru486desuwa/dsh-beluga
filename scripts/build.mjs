import { build } from 'esbuild'
import { WorkspaceAnalyzer, WorkspaceCaches, FaceModelEmitter, writeWorkspaceArtifacts } from '@deepseek-ai/dsh-typert-generator'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = join(root, 'packages/plugin')
const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
await mkdir(join(pkg, 'lib'), { recursive: true })
// rc.3 recognizes Remote decorators only in registered protocol packages. Register
// the installed, pinned SDK declarations in the analyzer's public inventory; no
// copied declarations, permissive codecs, or runtime Harness patches are used.
const caches = new WorkspaceCaches()
const analyzer = new WorkspaceAnalyzer({ root, faces: ['host'], packages: [manifest.name], caches })
analyzer.discoverPackages()
const require = createRequire(join(pkg, 'package.json'))
for (const name of ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-brand']) {
  const manifestPath = require.resolve(name + '/package.json')
  const dependency = JSON.parse(await readFile(manifestPath, 'utf8'))
  dependency.exports = Object.fromEntries(Object.entries(dependency.exports).map(([subpath, target]) => [subpath, typeof target === 'object' && target.types ? { types: join(dirname(manifestPath), target.types) } : target]))
  for (const inventory of caches.registrations.values()) inventory.push({
    face: 'host', name, root: dirname(manifestPath), manifest: dependency,
    config: caches.config(join(pkg, 'tsconfig.host.json')),
  })
}
const generated = analyzer.analyze().faces.map(face => ({
  ...new FaceModelEmitter(face).emit(manifest.name), packageRoot: 'packages/plugin',
}))
if (!generated[0]?.remote) throw new Error('Personal Chat Remote codecs were not generated')
writeWorkspaceArtifacts(root, generated)
const typecheck = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'tsconfig.host.json', 'tsconfig.client.json'], { cwd: root, stdio: 'inherit' })
if (typecheck.status !== 0) process.exit(typecheck.status ?? 1)
await build({ entryPoints: [join(pkg, 'lib/types/index.js')], outfile: join(pkg, 'lib/index.js'), platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external', tsconfig: join(pkg, 'tsconfig.host.json'), sourcemap: false })
const result = await build({
  entryPoints: [join(pkg, 'src/client/index.ts')], outfile: join(pkg, 'lib/client.js'), platform: 'browser', format: 'cjs',
  target: 'es2022', bundle: true, write: false, sourcemap: false, jsx: 'automatic', tsconfig: join(pkg, 'tsconfig.client.json'),
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-slots'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text
if (!js) throw new Error('Client JavaScript was not emitted')
const css = result.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n')
const artifact = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(manifest.name) + ', factory: (require) => {\nconst module = { exports: {} }; const exports = module.exports;\n' + js + '\nconst plugin = module.exports; return { ...plugin, async apply(ctx, ...args) { ctx.effect(() => { const style = document.createElement("style"); style.dataset.pluginCss = ' + JSON.stringify(manifest.name) + '; style.textContent = ' + JSON.stringify(css) + '; document.head.appendChild(style); return () => style.remove(); }, "personal-chat: styles"); try { return await plugin.apply(ctx, ...args); } catch (error) { console.error("Personal Chat initialization failed:", error instanceof Error ? error.message : "unknown error"); throw error; } } };\n} });\n'
await writeFile(join(pkg, 'lib/client.js'), artifact)
console.log('Built Host, generated Remote codecs, declarations and lazy-CJS Client.')

const officeTypecheck = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'packages/office/tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (officeTypecheck.status !== 0) process.exit(officeTypecheck.status ?? 1)
await build({ entryPoints: [join(root, 'packages/office/lib/types/index.js')], outfile: join(root, 'packages/office/lib/index.js'), platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external' })

const githubTypecheck = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-b', 'packages/github/tsconfig.json'], { cwd: root, stdio: 'inherit' })
if (githubTypecheck.status !== 0) process.exit(githubTypecheck.status ?? 1)
await build({ entryPoints: [join(root, 'packages/github/lib/types/index.js')], outfile: join(root, 'packages/github/lib/index.js'), platform: 'node', format: 'esm', target: 'node24', bundle: true, packages: 'external' })
