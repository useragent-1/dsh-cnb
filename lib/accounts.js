/**
 * The account vault behind the CNB panel.
 *
 * One CNB sign-in used to occupy the single credential record `dsh-cnb/cnb-token`:
 * scanning a second QR replaced the first account, and getting it back meant scanning
 * again. This module is the storage half of the fix — a small index of accounts plus
 * one payload record each — deliberately kept free of cordis, fetch, and the
 * credential service so its rules can be tested on their own.
 *
 * Two properties decide the shape:
 *
 *  - **The active record stays authoritative.** `dsh-cnb/cnb-token` keeps holding the
 *    live token exactly as before, so every existing code path (the API client, the
 *    gateway, the doctor, ambient fallback) is untouched. Switching copies a vault
 *    payload into that record; nothing has to learn a new address.
 *  - **The index holds no secrets.** It carries names, timestamps, an identity string
 *    and two booleans saying whether the payload still has a token and a session.
 *    Everything the panel lists is therefore safe to hand to the browser, and only the
 *    payload record — read on demand, never enumerated — can answer with a credential.
 *
 * Identity is the CNB username when the account answered with one, because that is
 * what makes "scan again as the same person" refresh an entry instead of adding a
 * second copy of it. The id is a hash of that identity, so two processes looking at the
 * same stored account agree on its id without reading a counter.
 *
 * @module dsh-cnb/accounts
 */
import { createHash } from 'node:crypto'

/** Layout version of the index payload; a future shape change bumps it. */
export const INDEX_VERSION = 1

/** Derived account ids: `acc-` plus 8–16 lowercase hex digits. */
export const ACCOUNT_ID_PATTERN = /^acc-[0-9a-f]{8,16}$/

/** Credential-key segment an account payload lives under, inside `dsh-cnb/`. */
export const ACCOUNT_KEY_PREFIX = 'account-'

/** How long a user-chosen label may be, so a pasted paragraph cannot wreck the list. */
export const LABEL_MAX = 48

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * What makes two stored accounts the same person.
 *
 * The username is the stable one: CNB hands it back on `/user`, and it survives a
 * display-name change. Nickname is the fallback (a session-only record may only have
 * answered with that), then the token's own description. An account nobody can name
 * gets `anon:` and is never merged with another, because merging two unknown people
 * would make switching hand out the wrong credential.
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function accountIdentity(payload) {
  const user = payload?.user
  const username = text(user?.username)?.toLowerCase()
  if (username !== undefined) return `user:${username}`
  const nickname = text(user?.nickname)?.toLowerCase()
  if (nickname !== undefined) return `nick:${nickname}`
  const description = text(payload?.tokenName) ?? text(payload?.description)
  if (description !== undefined) return `token:${description}`
  return `anon:${String(payload?.loginAt ?? '')}:${String(payload?.expiredAt ?? '')}`
}

/**
 * The id an identity maps to.
 *
 * Eight hex digits is plenty for a handful of accounts, but a collision would silently
 * merge two people, so the digest is lengthened until the id is free.
 * @param {string} identity @param {string[]} [taken]
 * @returns {string}
 */
export function accountIdFor(identity, taken = []) {
  const digest = createHash('sha256').update(identity).digest('hex')
  for (const length of [8, 10, 12, 16]) {
    const candidate = `acc-${digest.slice(0, length)}`
    if (!taken.includes(candidate)) return candidate
  }
  return `acc-${digest.slice(0, 16)}`
}

/** @param {unknown} value */
export function isAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)
}

/** @param {string} id */
export function accountKeySegment(id) {
  return `${ACCOUNT_KEY_PREFIX}${id}`
}

/** An index with no accounts, which is also the shape an absent record reads as. */
export function emptyIndex() {
  return { version: INDEX_VERSION, activeId: null, updatedAt: null, accounts: [] }
}

/**
 * Read a stored index without trusting it.
 *
 * A vault is long-lived state; a hand edit, an older build, or a half-written entry
 * must degrade to "that account is not listed" rather than throw inside `status()` and
 * blank the whole panel.
 * @param {unknown} raw a stored record, or the index payload itself
 */
export function indexFrom(raw) {
  const payload = raw && typeof raw === 'object' && 'payload' in raw ? raw.payload : raw
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) return emptyIndex()
  const accounts = []
  for (const entry of payload.accounts) {
    if (!entry || typeof entry !== 'object') continue
    if (!isAccountId(entry.id)) continue
    if (accounts.some((existing) => existing.id === entry.id)) continue
    const identity = text(entry.identity)
    accounts.push({
      id: entry.id,
      identity: identity ?? null,
      label: text(entry.label) ?? '未命名账户',
      labelCustom: entry.labelCustom === true,
      username: text(entry.username) ?? null,
      nickname: text(entry.nickname) ?? null,
      description: text(entry.description) ?? null,
      tokenName: text(entry.tokenName) ?? null,
      loginAt: text(entry.loginAt) ?? null,
      expiredAt: text(entry.expiredAt) ?? null,
      scopeProfile: text(entry.scopeProfile) ?? null,
      tokenStored: entry.tokenStored === true,
      sessionStored: entry.sessionStored === true,
      savedAt: text(entry.savedAt) ?? null,
      lastUsedAt: text(entry.lastUsedAt) ?? null,
    })
  }
  const activeId = isAccountId(payload.activeId) && accounts.some((entry) => entry.id === payload.activeId)
    ? payload.activeId
    : null
  return {
    version: INDEX_VERSION,
    activeId,
    updatedAt: text(payload.updatedAt) ?? null,
    accounts,
  }
}

/** The name the panel shows before anyone renames the entry. */
export function derivedLabel(payload) {
  const user = payload?.user
  return text(user?.nickname)
    ?? text(user?.username)
    ?? text(payload?.tokenName)
    ?? text(payload?.description)
    ?? '未命名账户'
}

/**
 * Insert or refresh one account, returning the new index and the id used.
 *
 * A payload already carrying `accountId` keeps it: that is how switching puts a stored
 * account back into the active record without minting a second entry for it. Otherwise
 * an account with the same identity is refreshed in place — signing in again must not
 * create a duplicate — and only a genuinely new person gets a new id. A user-set label
 * survives every refresh, because signing in should not rename someone's account.
 * @param {ReturnType<typeof emptyIndex>} index
 * @param {Record<string, any>} payload
 * @param {string} [at]
 * @returns {{ index: ReturnType<typeof emptyIndex>, id: string, created: boolean }}
 */
export function upsertAccount(index, payload, at = new Date().toISOString()) {
  const identity = accountIdentity(payload)
  const taken = index.accounts.map((entry) => entry.id)
  const declared = isAccountId(payload?.accountId) ? payload.accountId : undefined
  // An unnamed account has nothing stable to match on, so it is never merged.
  const anonymous = identity.startsWith('anon:')
  const sameIdentity = anonymous ? undefined : index.accounts.find((entry) => entry.identity === identity)
  const id = declared ?? sameIdentity?.id ?? accountIdFor(identity, taken)
  const previous = index.accounts.find((entry) => entry.id === id)
  const user = payload?.user
  const entry = {
    id,
    identity,
    label: previous?.labelCustom === true ? previous.label : derivedLabel(payload),
    labelCustom: previous?.labelCustom === true,
    username: text(user?.username) ?? previous?.username ?? null,
    nickname: text(user?.nickname) ?? previous?.nickname ?? null,
    description: text(payload?.description) ?? previous?.description ?? null,
    tokenName: text(payload?.tokenName) ?? previous?.tokenName ?? null,
    loginAt: text(payload?.loginAt) ?? previous?.loginAt ?? null,
    expiredAt: text(payload?.expiredAt) ?? null,
    scopeProfile: text(payload?.scopeProfile) ?? previous?.scopeProfile ?? null,
    tokenStored: typeof payload?.token === 'string' && payload.token !== '',
    sessionStored: typeof payload?.session === 'string' && payload.session !== '',
    savedAt: previous?.savedAt ?? at,
    lastUsedAt: at,
  }
  return {
    index: {
      ...index,
      version: INDEX_VERSION,
      activeId: index.activeId ?? id,
      updatedAt: at,
      accounts: [...index.accounts.filter((existing) => existing.id !== id), entry],
    },
    id,
    created: previous === undefined,
  }
}

/**
 * Note that one account was just used, without changing what the index says about it.
 * @param {ReturnType<typeof emptyIndex>} index @param {string} id @param {string} [at]
 */
export function touch(index, id, at = new Date().toISOString()) {
  if (!index.accounts.some((entry) => entry.id === id)) return index
  return {
    ...index,
    updatedAt: at,
    accounts: index.accounts.map((entry) => (entry.id === id ? { ...entry, lastUsedAt: at } : entry)),
  }
}

/**
 * Drop one account; the pointer falls back to the most recently used survivor.
 * @param {ReturnType<typeof emptyIndex>} index @param {string} id
 */
export function removeAccount(index, id) {
  const accounts = index.accounts.filter((entry) => entry.id !== id)
  if (accounts.length === index.accounts.length) return index
  const activeId = index.activeId === id
    ? (byRecency(accounts)[0]?.id ?? null)
    : index.activeId
  return { ...index, activeId, updatedAt: new Date().toISOString(), accounts }
}

/**
 * Point the vault at one stored account.
 * @param {ReturnType<typeof emptyIndex>} index @param {string} id
 */
export function activate(index, id) {
  if (!index.accounts.some((entry) => entry.id === id)) return index
  return { ...index, activeId: id, updatedAt: new Date().toISOString() }
}

/**
 * Give one account a name, or clear it back to the derived one.
 * @param {ReturnType<typeof emptyIndex>} index @param {string} id @param {string | undefined} label
 * @returns {{ ok: boolean, index: ReturnType<typeof emptyIndex> }}
 */
export function relabel(index, id, label) {
  const entry = index.accounts.find((candidate) => candidate.id === id)
  if (entry === undefined) return { ok: false, index }
  const wanted = text(label)
  const next = wanted === undefined
    ? { ...entry, label: entry.nickname ?? entry.username ?? '未命名账户', labelCustom: false }
    : { ...entry, label: wanted.slice(0, LABEL_MAX), labelCustom: true }
  return {
    ok: true,
    index: {
      ...index,
      updatedAt: new Date().toISOString(),
      accounts: index.accounts.map((row) => (row.id === id ? next : row)),
    },
  }
}

/** @param {Array<{ lastUsedAt?: string | null, savedAt?: string | null }>} accounts */
function byRecency(accounts) {
  const stamp = (entry) => {
    for (const value of [entry.lastUsedAt, entry.savedAt]) {
      if (value === null || value === undefined) continue
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
    return 0
  }
  return [...accounts].sort((a, b) => stamp(b) - stamp(a))
}

/**
 * What one account can currently do, from the metadata alone.
 *
 * The distinction the panel needs is the one the single-account view already draws: a
 * working token, a session without a minted token, and a credential CNB has expired.
 * Nothing here claims health it cannot see — a token with no recorded expiry is `ok`
 * because CNB issues long-lived tokens, not because it was verified just now.
 * @param {{ tokenStored: boolean, sessionStored: boolean, scopeProfile: string | null, expiredAt: string | null }} entry
 * @param {number} [now]
 */
export function healthOf(entry, now = Date.now()) {
  const expired = entry.expiredAt === null ? null : Date.parse(entry.expiredAt)
  const dead = expired !== null && !Number.isNaN(expired) && expired <= now
  if (entry.scopeProfile === 'session-only') {
    // A session-only record can heal itself into a token while the session lasts, so a
    // lapsed session is the only thing that makes it useless.
    return entry.sessionStored ? 'session-only' : 'expired'
  }
  if (!entry.tokenStored) return entry.sessionStored ? 'session-only' : 'unknown'
  if (dead) return entry.sessionStored ? 'expired-session' : 'expired'
  return 'ok'
}

/**
 * The browser-safe view of one account: no token, no session, no cookie value.
 * @param {ReturnType<typeof emptyIndex>['accounts'][number]} entry @param {string | null} activeId @param {number} [now]
 */
export function publicAccount(entry, activeId, now = Date.now()) {
  const expiry = entry.expiredAt === null ? null : Date.parse(entry.expiredAt)
  const expiresInMs = expiry === null || Number.isNaN(expiry) ? null : expiry - now
  return {
    id: entry.id,
    label: entry.label,
    username: entry.username,
    nickname: entry.nickname,
    description: entry.description,
    tokenName: entry.tokenName,
    scopeProfile: entry.scopeProfile,
    active: entry.id === activeId,
    health: healthOf(entry, now),
    tokenStored: entry.tokenStored,
    sessionStored: entry.sessionStored,
    loginAt: entry.loginAt,
    expiredAt: entry.expiredAt,
    expiresInMs,
    savedAt: entry.savedAt,
    lastUsedAt: entry.lastUsedAt,
  }
}

/**
 * The whole vault as the panel sees it: active first, then by recency.
 * @param {ReturnType<typeof emptyIndex>} index @param {number} [now]
 */
export function describeVault(index, now = Date.now()) {
  const ordered = byRecency(index.accounts)
  const active = ordered.filter((entry) => entry.id === index.activeId)
  const rest = ordered.filter((entry) => entry.id !== index.activeId)
  return {
    activeId: index.activeId,
    updatedAt: index.updatedAt,
    count: index.accounts.length,
    accounts: [...active, ...rest].map((entry) => publicAccount(entry, index.activeId, now)),
  }
}
