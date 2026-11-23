/**
 * Every identifier the client uses must be defined before use.
 *
 * The panel went black from `GATEWAY_BLOCKERS[...]` where the constant was never
 * declared. `node --check` cannot see that — the file parses — and a render test
 * needs react and jsdom, which the harness may not have. So this checks the thing
 * that actually broke: an identifier referenced inside the client factory with no
 * declaration anywhere in it.
 *
 * The check is deliberately narrow: it looks at the identifiers the client spells in
 * UPPER_SNAKE_CASE or calls as `function name(`, because those are the ones this file
 * defines itself. Anything else (globals, React, injected APIs) is out of scope and
 * would only produce noise.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Names declared by this file: const/let/var, function, and function parameters. */
const declared = new Set()
for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
// Function parameters, so `({ doctor })` style destructuring does not read as a use.
for (const match of source.matchAll(/\bfunction\s+[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
  for (const part of match[1].split(',')) {
    const name = part.replace(/[{}[\]:=\s]|\.\.\./g, '').split(/[^A-Za-z0-9_$]/)[0]
    if (name !== '') declared.add(name)
  }
}
// Arrow-function parameters.
for (const match of source.matchAll(/\(([^()]*)\)\s*=>/g)) {
  for (const part of match[1].split(',')) {
    const name = part.replace(/[{}[\]:=\s]|\.\.\./g, '').split(/[^A-Za-z0-9_$]/)[0]
    if (name !== '') declared.add(name)
  }
}

/**
 * The two ways this file references its own definitions:
 *   - `h(ComponentName, …)` for a component
 *   - `SOME_CONSTANT` where a declaration of that exact name exists or should
 *
 * Prose words (CNB, GET, POST) are not code references, so constants are matched only
 * where they appear in an expression position this file actually uses: as a value in a
 * JSX-ish call, a ternary, or a property lookup.
 */
const componentUses = new Set([...source.matchAll(/\bh\(([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]))
const constantUses = new Set(
  [...source.matchAll(/(?:=|\?|:|\{|,|\()\s*([A-Z][A-Z0-9_]{2,})(?=[\s,;}\])?:\[])|\.([A-Z][A-Z0-9_]{2,})\b/g)]
    .flatMap((match) => [match[1], match[2]])
    .filter((name) => typeof name === 'string'),
)

const missingComponents = [...componentUses].filter((name) => !declared.has(name))
const missingConstants = [...constantUses].filter((name) => !declared.has(name))
const unexpected = [...new Set([...missingComponents, ...missingConstants])]

assert.deepEqual(
  unexpected,
  [],
  `these are used but never defined in client.js, which throws at render: ${unexpected.join(', ')}`,
)

// The specific regression, stated as itself.

console.log('client-identifiers OK · no component or constant is used before it is defined')
