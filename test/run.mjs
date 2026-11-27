/**
 * Test entry point.
 *
 *   npm test                 # offline suites
 *   CNB_TOKEN=… npm test     # also exercises the live CNB OpenAPI
 *
 * The QR decode assertion needs the `jsqr` dev dependency; the live suites need
 * CNB_TOKEN and are skipped when it is absent.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  ['scopes', 'scopes.test.mjs', false],
  ['login-state', 'login-state.test.mjs', false],
  ['login-bind', 'login-bind.test.mjs', false],
  ['doctor', 'doctor.test.mjs', false],
  ['stop-fallback', 'stop-fallback.test.mjs', false],
  ['grants', 'grants.test.mjs', false],
  ['mint-verify', 'mint-verify.test.mjs', false],
  ['session-remint', 'session-remint.test.mjs', false],
  ['workspace-open', 'workspace-open.test.mjs', false],
  ['start-links', 'start-links.test.mjs', false],
  ['environment-links', 'environment-links.test.mjs', false],
  ['address-cache', 'address-cache.test.mjs', false],
  ['client-links', 'client-links.test.mjs', false],
  ['login-days', 'login-days.test.mjs', false],
  ['logout', 'logout.test.mjs', false],
  ['accounts', 'accounts.test.mjs', false],
  ['account-panel', 'account-panel.test.mjs', false],
  ['account-render', 'account-render.test.mjs', false],
  ['login-panel', 'login-panel.test.mjs', false],
  ['session-only', 'session-only.test.mjs', false],
  ['token-name', 'token-name.test.mjs', false],
  ['new-repo-start', 'new-repo-start.test.mjs', false],
  ['delete-root-group', 'delete-root-group.test.mjs', false],
  ['cleanup', 'cleanup.test.mjs', false],
  ['cleanup-wire', 'cleanup-wire.test.mjs', false],
  ['cleanup-script', 'cleanup-script.test.mjs', false],
  ['cleanup-cronfile', 'cleanup-cronfile.test.mjs', false],
  ['cleanup-panel', 'cleanup-panel.test.mjs', false],
  ['env-panel', 'env-panel.test.mjs', false],
  ['session-fallback', 'session-fallback.test.mjs', false],
  ['session-capability', 'session-capability.test.mjs', false],
  ['mini-yaml', 'mini-yaml.test.mjs', false],
  ['qr', 'qr.test.mjs', false],
  ['gateway-overlay', 'gateway-overlay.test.mjs', false],
  ['gateway-autopick', 'gateway-autopick.test.mjs', false],
  ['client-identifiers', 'client-identifiers.test.mjs', false],
  ['gateway-token', 'gateway-token.test.mjs', false],
  ['neutralize', 'neutralize.test.mjs', false],
  ['image-guard', 'image-guard.test.mjs', false],
  ['scaffold-imports', 'scaffold-imports.test.mjs', false],
  ['provider-input', 'provider-input.test.mjs', false],
  ['onboarding', 'onboarding.test.mjs', false],
  ['ambient-token', 'ambient-token.test.mjs', false],
  ['usage-live', 'usage-live.test.mjs', false],
  ['provider-wiring', 'provider-wiring.test.mjs', false],
  ['model-catalog', 'model-catalog.test.mjs', false],
  ['model-coverage', 'model-coverage.test.mjs', false],
  ['issue-base', 'issue-base.test.mjs', false],
  ['issue-relay', 'issue-relay.test.mjs', false],
  ['cloud-gateway', 'cloud-gateway.test.mjs', false],
  ['cloud-provision', 'cloud-provision.test.mjs', false],
  ['cloud-hot-wire', 'cloud-hot-wire.test.mjs', false],
  ['model-discovery', 'model-discovery.test.mjs', false],
  ['session-adopt', 'session-adopt.test.mjs', false],
  ['provider-route', 'provider-route.test.mjs', false],
  ['keepalive', 'keepalive.test.mjs', false],
  ['autokeep', 'autokeep.test.mjs', false],
  ['immortal', 'immortal.test.mjs', false],
  ['host-smoke', 'host-smoke.mjs', true],
]

let failures = 0
for (const [name, file, needsToken] of suites) {
  if (needsToken && (process.env.CNB_TOKEN ?? '') === '') {
    console.log(`skip  ${name} (CNB_TOKEN unset)`)
    continue
  }
  const result = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' })
  if (result.status === 0) {
    console.log(`pass  ${name}`)
  } else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}
if (failures > 0) {
  console.error(`${failures} suite(s) failed`)
  process.exit(1)
}
