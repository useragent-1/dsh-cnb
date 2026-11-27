/**
 * 票据绑定 cookie 的离线回归测试（本地假 CNB，不碰外网）。
 *
 * 真机现象：扫码面板刚出来就已经是死的，轮询一律
 *
 *   400 {"errcode":3,"errmsg":"state is invalid."}
 *
 * 原因不是 state/uuid 算错，而是 `GET /login/state` 自己会下发一个绑定 cookie
 * （实测 `__Host-cnb_login_bind`，Max-Age 只有 600 秒），服务端把这张票绑在它上面。
 * 只合并 `/login` 的 `csrfkey`/`csrftoken`、漏掉这一个，服务端就认为「你没带票」，
 * 于是答 state is invalid —— 而客户端把它当成结论原样贴到面板上。
 *
 * 这里用一个「不认票就 400」的假服务器把这条钉住：谁再把那次 Set-Cookie 的合并删掉，
 * 这个套件立刻红。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { LoginAttempt } from '../lib/cnb-client.js'

const BIND_COOKIE = '__Host-cnb_login_bind'
const BIND_VALUE = 'bind-9f3c1d'
const STATE = 'STATE-TOKEN-xyz'
const UUID = '11111111-2222-3333-4444-555555555555'

/**
 * @param {(request: http.IncomingMessage, reply: http.ServerResponse) => void} handler
 * @returns {Promise<{ web: string, close: () => Promise<void> }>}
 */
function serve(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
      resolve({
        web: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

const json = (reply, status, body) => {
  reply.statusCode = status
  reply.setHeader('content-type', 'application/json')
  reply.end(JSON.stringify(body))
}

// --- 1. 缺绑定 cookie 就判死；带上了就正常 ---------------------------------
{
  const seen = []
  const site = await serve((request, reply) => {
    const cookie = String(request.headers.cookie ?? '')
    seen.push({ url: request.url, cookie })
    if (request.url === '/login') {
      reply.setHeader('set-cookie', ['csrfkey=k1; Path=/', 'csrftoken=t1; Path=/'])
      reply.setHeader('content-type', 'text/html')
      reply.end('<!doctype html><title>登录 · CNB</title>')
      return
    }
    if (request.url === '/login/state') {
      reply.setHeader('set-cookie', [`${BIND_COOKIE}=${BIND_VALUE}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`])
      json(reply, 200, { state: STATE, uuid: UUID })
      return
    }
    if (request.url === `/login/state/${STATE}?uuid=${UUID}`) {
      // 这一行就是服务端的真实规则：绑定 cookie 不在，票无效。
      if (!cookie.includes(`${BIND_COOKIE}=${BIND_VALUE}`)) {
        json(reply, 400, { errcode: 3, errmsg: 'state is invalid.' })
        return
      }
      json(reply, 200, { nickName: '', avatar: '', confirmed: false, isExpired: false })
      return
    }
    json(reply, 404, { errcode: 404, errmsg: 'not found' })
  })

  const attempt = new LoginAttempt({ web: site.web })
  const view = await attempt.start()
  assert.equal(view.state, STATE)
  assert.equal(view.uuid, UUID)

  // 那一次合并到底有没有发生，直接看 jar。
  assert.equal(attempt.jar.get(BIND_COOKIE), BIND_VALUE, '`/login/state` 的 Set-Cookie 必须并进 jar')
  assert.match(attempt.session, new RegExp(`${BIND_COOKIE}=${BIND_VALUE}`))
  // 票据不是会话：600 秒的 Max-Age 不许被记成会话寿命。
  assert.equal(attempt.sessionExpiry, null, '票据绑定 cookie 不能被当成会话寿命')

  const first = await attempt.poll()
  assert.equal(first.confirmed, false)
  assert.equal(first.expired, false)
  assert.equal(attempt.closed, false)

  // 每次轮询都得原样带着它（轮询本身不会再下发）。
  const polls = seen.filter((entry) => entry.url.startsWith('/login/state/'))
  assert.equal(polls.length, 1)
  assert.ok(polls[0].cookie.includes(`${BIND_COOKIE}=${BIND_VALUE}`), '轮询必须带绑定 cookie')
  assert.ok(polls[0].cookie.includes('csrftoken=t1'), 'CSRF cookie 也要继续带着')

  await site.close()
}

// --- 2. 真的被判死时：就地判死 + 给出可执行的原因，而不是把原文丢给用户 ------
{
  const site = await serve((request, reply) => {
    if (request.url === '/login') {
      reply.setHeader('set-cookie', ['csrfkey=k1; Path=/'])
      reply.end('<!doctype html><title>登录 · CNB</title>')
      return
    }
    if (request.url === '/login/state') {
      reply.setHeader('set-cookie', [`${BIND_COOKIE}=${BIND_VALUE}; Path=/; Max-Age=600`])
      json(reply, 200, { state: STATE, uuid: UUID })
      return
    }
    json(reply, 400, { errcode: 3, errmsg: 'state is invalid.' })
  })

  const attempt = new LoginAttempt({ web: site.web })
  await attempt.start()
  await assert.rejects(() => attempt.poll(), /state is invalid/)
  assert.equal(attempt.closed, true, '被判死的票必须就地关掉，否则会一直拿同一张废票轮询')
  assert.equal(attempt.lastStatus, null, '失败不该写进 lastStatus')

  try {
    await attempt.poll()
    assert.fail('已经关闭的会话不该再发请求')
  } catch (error) {
    assert.match(String(error.message), /扫码会话尚未初始化|state is invalid/)
  }

  await site.close()
}

// --- 3. errcode 3 之外的失败不许被误判成「票失效」 -------------------------
{
  const site = await serve((request, reply) => {
    if (request.url === '/login') {
      reply.end('<!doctype html><title>登录 · CNB</title>')
      return
    }
    if (request.url === '/login/state') {
      reply.setHeader('set-cookie', [`${BIND_COOKIE}=${BIND_VALUE}; Path=/; Max-Age=600`])
      json(reply, 200, { state: STATE, uuid: UUID })
      return
    }
    json(reply, 502, { errcode: 5000, errmsg: 'upstream unavailable' })
  })

  const attempt = new LoginAttempt({ web: site.web })
  await attempt.start()
  await assert.rejects(() => attempt.poll(), /upstream unavailable/)
  assert.equal(attempt.closed, false, '上游故障不等于票失效，不能把会话判死')

  await site.close()
}

console.log('login bind OK · 绑定 cookie 合并、票据≠会话寿命、errcode 3 判死且只判它')
