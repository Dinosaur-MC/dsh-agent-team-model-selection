import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createApi, apply, normalizeSelection, isLocalRequest, SeatError, ROUTE_PREFIX } from '../lib/index.js'

const tempFile = path.join(process.cwd(), 'test', '.host-state-' + process.pid + '.json')

function makeAgent({ id, model, header, parent }) {
  let current = { ...model }
  return {
    id,
    session: {
      header,
      requestHeader: () => ({ config: { ...current } }),
      append(type, data) { if (type === 'model/selection') current = { ...data } },
    },
    model: {
      current: () => ({ ...current }),
      select(selection) { current = { ...selection } },
    },
    get current() { return current },
  }
}

function makeHost({ live = true } = {}) {
  const lead = makeAgent({ id: 'lead', model: { provider: 'prov1', model: 'm1' }, header: { origin: 'top' } })
  const child = makeAgent({
    id: 's1',
    model: { provider: 'prov1', model: 'm1' },
    header: { origin: 'subagent', parentSession: 'lead' },
    parent: lead,
  })
  const agents = new Map([['lead', lead]])
  if (live) agents.set('s1', child)
  const sessions = new Map([['s1', child.session]])
  const routes = []
  const listeners = new Map()
  const memberships = new Map([
    [lead, { root: lead, role: 'lead', name: 'lead' }],
    [child, { root: lead, role: 'teammate', name: 'w-1' }],
  ])
  const rows = [
    { id: 'lead', name: 'lead', role: 'lead' },
    { id: 's1', name: 'w-1', role: 'teammate' },
  ]
  const ctx = {
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    logger: { info() {}, warn() {} },
    on: (event, handler) => { listeners.set(event, handler); return () => listeners.delete(event) },
    inject: (names, callback) => {
      if (Array.isArray(names) && names.includes('webServer')) {
        callback({
          effect: (fn) => { fn(); return () => {} },
          webServer: { register: (route) => { routes.push(route); return () => {} } },
        })
      }
    },
    get: (name) => {
      if (name === 'agentTeams') return {
        tryMembership: (agent) => memberships.get(agent),
        listMembers: (agent) => agent?.id === 'lead' ? rows : [],
      }
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'sessionController') return { inspect: async (id) => id === 's1' ? { meta: child.session.header } : undefined }
      if (name === 'sessionProjections') return { stateOf: () => ({ next: null, lastUsed: { provider: 'prov1', model: 'm1' } }) }
      if (name === 'llm') return {
        listProviders: () => [{ id: 'prov1' }, { id: 'prov2' }],
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
      }
      if (name === 'subagentModelSelection') return {
        current: () => ({ enabled: true, allowedModels: [{ provider: 'prov1', model: 'm1' }, { provider: 'prov1', model: 'm2' }] }),
      }
      return undefined
    },
  }
  return { ctx, lead, child, agents, sessions, rows, routes, listeners, memberships }
}

test.after(async () => { await fs.rm(tempFile, { force: true }) })

test('normalizeSelection requires provider and model together', () => {
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.deepEqual(normalizeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.throws(() => normalizeSelection({ provider: 'p' }), (error) => error instanceof SeatError && error.code === 'invalid-selection')
})

test('live teammate: select commits through the Agent model facade', async () => {
  const h = makeHost()
  const api = createApi(h.ctx, { dataFile: tempFile })
  const result = await api.select('s1', { provider: 'prov1', model: 'm2' })
  assert.equal(result.applied, 'live')
  assert.equal(h.child.current.model, 'm2')
  const state = await api.state('s1')
  assert.equal(state.teammate, true)
  assert.equal(state.current.model, 'm2')
})

test('dormant teammate: stores preference and applies it on activation', async () => {
  const h = makeHost({ live: false })
  const api = createApi(h.ctx, { dataFile: tempFile })
  const result = await api.select('s1', { provider: 'prov1', model: 'm2' })
  assert.equal(result.applied, 'pending')
  assert.equal(h.child.current.model, 'm1')
  await api.applyCreated(h.child)
  assert.equal(h.child.current.model, 'm2')
  const state = await api.state('s1')
  assert.equal(state.teammate, true)
  assert.equal(state.pending, null)
})

test('rejects top-level sessions but accepts durable subagent evidence', async () => {
  const h = makeHost()
  const api = createApi(h.ctx, { dataFile: tempFile })
  await assert.rejects(api.select('lead', { provider: 'prov1', model: 'm1' }), (error) => error instanceof SeatError && error.code === 'not-a-team-member')
  await assert.rejects(api.select('lead', { parentSessionId: 'lead', provider: 'prov1', model: 'm1' }), (error) => error instanceof SeatError && error.code === 'not-a-team-member')
  h.memberships.delete(h.child)
  h.rows.splice(1, 1)
  const result = await api.select('s1', { provider: 'prov1', model: 'm2' })
  assert.equal(result.applied, 'live')
})

test('rejects unknown routes and allowlist misses', async () => {
  const h = makeHost()
  const api = createApi(h.ctx, { dataFile: tempFile })
  await assert.rejects(api.select('s1', { provider: 'prov2', model: 'm2' }), (error) => error instanceof SeatError && error.code === 'route-not-allowed')
  await assert.rejects(api.select('s1', { provider: 'prov1', model: 'm9' }), (error) => error instanceof SeatError && error.code === 'route-not-allowed')
})

test('HTTP surface: health, state and select are loopback JSON', async () => {
  const h = makeHost()
  const api = createApi(h.ctx, { dataFile: tempFile })
  const calls = []
  const response = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(value) { this.body = value } }
  await api.handleHttp({ method: 'GET', url: ROUTE_PREFIX + '/health', socket: { remoteAddress: '127.0.0.1' } }, response)
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).ok, true)
  calls.push(response.body)
  const stateResponse = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(value) { this.body = value } }
  await api.handleHttp({ method: 'GET', url: ROUTE_PREFIX + '/state?sessionId=s1', socket: { remoteAddress: '127.0.0.1' } }, stateResponse)
  assert.equal(JSON.parse(stateResponse.body).teammate, true)
  const body = JSON.stringify({ sessionId: 's1', provider: 'prov1', model: 'm2' })
  const request = {
    method: 'POST', url: ROUTE_PREFIX + '/select', socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  const selectResponse = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(value) { this.body = value } }
  await api.handleHttp(request, selectResponse)
  assert.equal(JSON.parse(selectResponse.body).applied, 'live')
})

test('apply wires the creation hook and the prefix route', () => {
  const h = makeHost()
  const api = apply(h.ctx, { dataFile: tempFile })
  assert.equal(typeof api.select, 'function')
  assert.equal(h.listeners.has('agent/created'), true)
  assert.equal(h.routes.length, 1)
  assert.equal(h.routes[0].kind, 'prefix')
  assert.equal(h.routes[0].path, ROUTE_PREFIX)
  assert.equal(isLocalRequest({ socket: { remoteAddress: '10.0.0.1' } }), false)
})
