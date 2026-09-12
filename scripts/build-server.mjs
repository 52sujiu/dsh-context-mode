/**
 * Build the vendored context-mode server bundle.
 *
 * The fork under `vendor/context-mode` is this repository's own source, so the
 * server bundle is a local build artifact rather than an installed package.
 * esbuild lives in the vendored tree's own node_modules, which keeps the root
 * package free of a second toolchain.
 *
 * Run `pnpm install --prefix vendor/context-mode --include=dev` once before the
 * first build to populate the vendored toolchain.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vendor = join(root, 'vendor', 'context-mode')
const esbuild = join(vendor, 'node_modules', '.bin', 'esbuild')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

if (!existsSync(join(vendor, 'src', 'server.ts'))) {
  console.error(`vendored sources are missing: ${join(vendor, 'src', 'server.ts')}`)
  process.exit(1)
}
if (!existsSync(esbuild)) {
  console.error(
    `esbuild is missing from the vendored toolchain: ${esbuild}\n` +
    'Run: pnpm install --prefix vendor/context-mode --include=dev',
  )
  process.exit(1)
}

const args = [
  join(vendor, 'src', 'server.ts'),
  '--bundle',
  '--platform=node',
  '--target=node18',
  '--format=esm',
  `--outfile=${join(vendor, 'server.bundle.mjs')}`,
  // Bake the adapter version in so the engine reports the version of the
  // package that actually ships it, instead of hunting for a package.json
  // that a single-file bundle cannot reach.
  '--define:process.env.CONTEXT_MODE_VERSION=' + JSON.stringify(version),
  '--external:better-sqlite3',
  '--external:turndown',
  '--external:turndown-plugin-gfm',
  '--external:@mixmark-io/domino',
  '--minify',
]

try {
  execFileSync(esbuild, args, { cwd: vendor, stdio: 'inherit' })
  console.log(`context-mode server bundle built at vendor/context-mode/server.bundle.mjs (v${version})`)
} catch (error) {
  console.error(`server bundle build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
