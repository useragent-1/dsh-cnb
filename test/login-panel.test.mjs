/**
 * The sign-in surface must look deliberate and never render blank-white buttons.
 *
 * Two concrete complaints: the QR area was not centred, and buttons read as plain
 * white because the fill was `--dsw-alias-bg-layer-2`, which is literally #fff in the
 * light theme. A button that looks like empty space is a real defect, not a taste
 * question.
 *
 * These cases read the stylesheet the client ships: every rule is asserted against
 * the source, because jsdom does not resolve CSS custom properties.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// --- case 1: buttons are tinted, not white ----------------------------------
{
  const base = source.match(/\.dcnb-btn\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(base.length > 0, 'the base button rule must exist')
  assert.ok(!/background:var\(--dsw-alias-bg-layer-[12]\)/.test(base),
    'bg-layer-2 resolves to #fff in the light theme, which is why buttons looked blank')
  assert.match(base, /background:var\(--dsw-alias-interactive-bg-hover\)/,
    'the resting fill must be a tinted surface')
  // A tone variant must exist for both a primary and a destructive action.
  assert.match(source, /\.dcnb-btn\[data-tone=primary\]\{[^}]*button-info-fill/, 'primary uses the brand fill')
  assert.match(source, /\.dcnb-btn\[data-tone=danger\]\{[^}]*state-error-primary/, 'danger is tinted, not outlined white')
}

// --- case 2: hover, active and focus are all defined ------------------------
{
  assert.match(source, /\.dcnb-btn:hover\{[^}]*interactive-bg-hover-accent/)
  assert.match(source, /\.dcnb-btn:active\{[^}]*interactive-bg-active/)
  assert.match(source, /\.dcnb-btn:focus-visible\{[^}]*outline/, 'a keyboard user needs a visible focus ring')
}

// --- case 3: the login surface is centred ----------------------------------
{
  const rule = source.match(/\.dcnb-login\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(rule.length > 0, 'the login container must have its own rule')
  assert.match(rule, /align-items:center/, 'children must be centred on the cross axis')
  assert.match(rule, /text-align:center/)
  assert.match(rule, /margin:0 auto/, 'the column itself must be centred in the card')
  assert.match(rule, /max-width:\d+px/, 'a measured width, not the full card')
}

// --- case 4: the QR sits on white regardless of theme ----------------------
{
  const rule = source.match(/\.dcnb-qr\{([^}]*)\}/)?.[1] ?? ''
  assert.match(rule, /background:#fff/, 'a QR drawn on a dark panel cannot be scanned')
  assert.match(rule, /margin:0 auto/)
}

// --- case 5: the panel is one surface, not a pile of cards ------------------
{
  assert.match(source, /function LoginPanel\(/, 'the signed-out state is its own component')
  assert.match(source, /className: 'dcnb-login-head'/)
  assert.match(source, /className: 'dcnb-login-actions'/)
  assert.match(source, /className: 'dcnb-login-notes'/)
  // The old duplicate QR card was removed; only the panel renders a code now.
  assert.equal((source.match(/h\(QrCode,/g) ?? []).length, 1, 'exactly one place renders the QR')
}

// --- case 6: the primary action is emphasised ------------------------------
{
  assert.match(source, /dcnb-btn dcnb-btn-lg/, 'the main action carries the larger size')
  const large = source.match(/\.dcnb-btn-lg\{([^}]*)\}/)?.[1] ?? ''
  assert.match(large, /min-width:\d+px/)
  assert.match(large, /padding:9px 26px/)
}

console.log('login-panel OK · tinted buttons, centred column, white QR tile, one code surface')
