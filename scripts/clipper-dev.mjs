// Runs the built command line against a development client (`pnpm dev`), with its own channel name.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const root = path.resolve(import.meta.dirname, '..')
const result = spawnSync(process.execPath, [path.join(root, 'dist-electron/cli/clipper.mjs'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, CLIPPER_DEV: '1' } })
process.exit(result.status ?? 1)
