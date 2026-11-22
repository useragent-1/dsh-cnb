/** The subset parser must read what CNB's own settings files contain. */
import assert from 'node:assert/strict'
import { parseMiniYaml, readWorkspaceConfig } from '../lib/mini-yaml.js'

const sample = `# Repo UI customisation
workspace:
  launch:
    button:
      name: 启动云原生开发
      description: "一键进入在线编码环境"
      hoverImage: .cnb/launch-hover.gif
    cpus: 8
    disabled: false
    autoOpenWebIDE: true

npc:
  roles:
    - name: reviewer
      prompt: |
        review it
`

const parsed = parseMiniYaml(sample)
assert.deepEqual(parsed.workspace.launch.button, {
  name: '启动云原生开发',
  description: '一键进入在线编码环境',
  hoverImage: '.cnb/launch-hover.gif',
})
assert.equal(parsed.workspace.launch.cpus, 8)
assert.equal(parsed.workspace.launch.disabled, false)
assert.equal(parsed.workspace.launch.autoOpenWebIDE, true)

assert.deepEqual(readWorkspaceConfig(parsed), {
  button: { name: '启动云原生开发', description: '一键进入在线编码环境', hoverImage: '.cnb/launch-hover.gif' },
  cpus: 8,
  disabled: false,
  autoOpenWebIDE: true,
})

// Absent or partial blocks answer nulls rather than throwing.
assert.equal(readWorkspaceConfig(parseMiniYaml('other: 1')), null)
assert.deepEqual(readWorkspaceConfig(parseMiniYaml('workspace:\n  launch:\n    cpus: 4\n')), {
  button: { name: null, description: null, hoverImage: null },
  cpus: 4,
  disabled: null,
  autoOpenWebIDE: null,
})

// A trailing comment that contains a colon must not split the value.
assert.equal(parseMiniYaml('a: 1 # note: keep').a, 1)
// A quoted value keeps its colon and hash.
assert.equal(parseMiniYaml('a: "x: y # z"').a, 'x: y # z')

console.log('mini-yaml OK')
