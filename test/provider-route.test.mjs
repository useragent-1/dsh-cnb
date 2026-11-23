/**
 * provider 路由名不合法 → 供应商**静默消失**。
 *
 * 这是本仓库踩过的最难查的一类故障：配置写进去了、`--dump-config` 里看得见、
 * 文件也是合法的 YAML，但模型选择器里空空如也。
 *
 * 原因是 pi-ai 处理每个 provider 前会先跑
 * `isCredentialKeySegment(providerId)`，规则是 `/^[a-z][a-z0-9-]*$/`；
 * 不通过就**直接 skip**，不报错也不警告。所以一个以数字开头的 route（例如把
 * 一串数字当成 route 传进来，得到 `668383`）会让人以为「配置没生效」，
 * 而真正的原因是一个字母大小写级别的门槛。
 *
 * 这些测试钉住两件事：归一函数本身的行为，以及每个 route 入口都经过它。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PROVIDER_ROUTE_PATTERN, normalizeProviderRoute } from '../lib/provision.js'

// --- 1. 合法值原样通过 ---------------------------------------------
{
  for (const route of ['cnb-gateway', 'cnb', 'a', 'my-route-2', 'x9']) {
    const result = normalizeProviderRoute(route)
    assert.equal(result.route, route)
    assert.equal(result.normalized, false, `${route} needs no normalisation`)
  }
}

// --- 2. 以数字开头的必须被修好，而不是继续静默失败 -----------------
{
  // 实测踩到的那个值。
  const result = normalizeProviderRoute('668383')
  assert.equal(result.route, 'cnb-668383')
  assert.equal(result.normalized, true)
  assert.match(result.route, PROVIDER_ROUTE_PATTERN, 'the result satisfies the pi-ai provider-id rule')
  assert.notEqual(result.route, '668383', 'and it is not the value that made the provider vanish')
}

// --- 3. 大写、空格、下划线都能归一 --------------------------------
{
  assert.equal(normalizeProviderRoute('CNB-Gateway').route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute('  cnb-gateway  ').route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute('my route').route, 'my-route')
  assert.equal(normalizeProviderRoute('my_route').route, 'my-route')
  assert.equal(normalizeProviderRoute('CNB  Gateway').route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute('cnb---gateway').route, 'cnb-gateway')
}

// --- 4. 空值退回默认，而不是产出空路由 ----------------------------
{
  assert.equal(normalizeProviderRoute('').route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute(undefined).route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute(null).route, 'cnb-gateway')
  assert.equal(normalizeProviderRoute(123).route, 'cnb-gateway', 'a non-string is not a route')
  // 调用方可以指定别的默认值。
  assert.equal(normalizeProviderRoute('', { fallback: 'other' }).route, 'other')
}

// --- 5. 结果永远是合法的 --------------------------------------------
{
  const inputs = ['668383', '9abc', '2024-11-23', '---', 'a', 'A1', '中文', '\u0000', 'x'.repeat(300)]
  for (const input of inputs) {
    const { route } = normalizeProviderRoute(input)
    assert.match(route, PROVIDER_ROUTE_PATTERN, `${JSON.stringify(input)} -> ${route} must be legal`)
  }
}

// --- 6. 每个 route 入口都必须经过归一 ------------------------------
//
// 只在面板那一路做校验是不够的：`cloud.wire` 与 `gateway.configure` 都能被 agent
// 直接调用，绕过面板。任何一个漏掉，症状都会再来一次。
{
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 所有从 input 取 route 的地方都不该直接 asString 了事。
  const rawRouteUses = [...source.matchAll(/asString\(input\??\.route\)/g)]
  assert.equal(rawRouteUses.length, 0, 'no site may take the route straight from input')
  const normalized = [...source.matchAll(/normalizeProviderRoute\(/g)]
  assert.ok(normalized.length >= 4, `every route entry point normalises (found ${normalized.length})`)
}
