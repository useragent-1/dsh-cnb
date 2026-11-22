/**
 * A deliberately small YAML reader for `.cnb/settings.yml`.
 *
 * The plugin only needs the `workspace.launch` block (button name, description,
 * hover image, cpu count, disabled, autoOpenWebIDE). Pulling a full YAML parser
 * into the profile would buy nothing here, so this reads the block-structured
 * subset that CNB's own settings file uses: indentation-nested mappings,
 * `- ` sequences, quoted and plain scalars, booleans, and numbers.
 */

/** @typedef {string | number | boolean | null | MiniYamlNode} MiniYamlNode */
/** @typedef {{ [key: string]: MiniYamlNode }} MiniYamlMap */

/** Strip a trailing comment that is not inside quotes. */
function stripComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== '') {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index)
  }
  return line
}

/** @param {string} raw */
function scalar(raw) {
  const text = raw.trim()
  if (text === '') return null
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  if (text === 'true' || text === 'True' || text === 'yes') return true
  if (text === 'false' || text === 'False' || text === 'no') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

/** Split `key: value` at the first colon that is followed by space or end. */
function splitEntry(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ':') continue
    const next = text[index + 1]
    if (next !== undefined && next !== ' ' && next !== '\t') continue
    return [text.slice(0, index), text.slice(index + 1)]
  }
  return null
}

/**
 * Parse the subset described above.
 * @param {string} text
 * @returns {MiniYamlMap}
 */
export function parseMiniYaml(text) {
  /** @type {Array<{ indent: number, node: MiniYamlMap | unknown[] }>} */
  const stack = [{ indent: -1, node: {} }]
  const lines = String(text).split(/\r?\n/)

  for (const rawLine of lines) {
    const withoutComment = stripComment(rawLine)
    if (withoutComment.trim() === '') continue
    const indent = withoutComment.length - withoutComment.trimStart().length
    const content = withoutComment.trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node

    if (content.startsWith('- ') || content === '-') {
      const itemText = content === '-' ? '' : content.slice(2)
      if (!Array.isArray(parent)) {
        // A sequence under a mapping needs a key to live under; ignore strays.
        continue
      }
      const entry = splitEntry(itemText)
      if (entry === null) {
        parent.push(scalar(itemText))
      } else {
        const [key, value] = entry
        const child = {}
        parent.push(child)
        if (value.trim() !== '') child[key.trim()] = scalar(value)
        stack.push({ indent, node: child })
      }
      continue
    }

    const entry = splitEntry(content)
    if (entry === null) continue
    const [key, value] = entry
    const name = key.trim()
    if (!Array.isArray(parent)) {
      if (value.trim() === '') {
        const child = {}
        parent[name] = child
        stack.push({ indent, node: child })
      } else {
        parent[name] = scalar(value)
      }
    }
  }
  return /** @type {MiniYamlMap} */ (stack[0].node)
}

/**
 * Read the workspace launch button configuration out of a parsed settings file.
 * @param {MiniYamlMap} settings
 */
export function readWorkspaceConfig(settings) {
  const workspace = settings?.workspace
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null
  const launch = workspace.launch
  const button = launch && typeof launch === 'object' && !Array.isArray(launch) ? launch.button : undefined
  /** @param {unknown} value */
  const text = (value) => (typeof value === 'string' ? value : undefined)
  const record = button && typeof button === 'object' && !Array.isArray(button) ? button : {}
  return {
    button: {
      name: text(record.name) ?? null,
      description: text(record.description) ?? null,
      hoverImage: text(record.hoverImage) ?? null,
    },
    cpus: typeof launch?.cpus === 'number' ? launch.cpus : null,
    disabled: typeof launch?.disabled === 'boolean' ? launch.disabled : null,
    autoOpenWebIDE: typeof launch?.autoOpenWebIDE === 'boolean' ? launch.autoOpenWebIDE : null,
  }
}
