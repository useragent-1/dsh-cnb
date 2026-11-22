/**
 * Resolve a package from the running dsh installation.
 *
 * A plugin runs inside a dsh profile whose `node_modules` holds only installed
 * bundles, so a test that wants to validate against a shipped package (the pi-ai
 * Config schema, the YAML loader dialect) must find the dsh installation rather
 * than assume the repo has it as a dependency.
 *
 * Order: an explicit override, then `$DSH_HOME/runtime/node_modules`, then the
 * module paths of the current process.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** @param {string} packageName @param {string} [entry] @returns {Promise<any>} */
export async function importFromDsh(packageName, entry) {
  const segment = entry === undefined ? packageName : `${packageName}/${entry}`
  const overrides = [process.env.DSH_PACKAGE_ROOT, process.env.DSH_HOME && join(process.env.DSH_HOME, 'runtime', 'node_modules')]
  for (const root of overrides) {
    if (typeof root !== 'string' || root === '') continue
    const candidate = join(root, packageName, entry ?? '')
    if (existsSync(candidate)) return import(pathToFileURL(candidate).href)
    const manifest = join(root, packageName, 'package.json')
    if (existsSync(manifest)) {
      const parsed = JSON.parse(await (await import('node:fs/promises')).readFile(manifest, 'utf8'))
      const target = typeof entry === 'string' ? parsed.exports?.[`./${entry}`]?.default : parsed.main
      if (typeof target === 'string') return import(pathToFileURL(join(root, packageName, target)).href)
    }
    void segment
  }
  return import(packageName)
}
