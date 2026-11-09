import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-agent-team-model-selection'
export const inject = ['agents', 'llm']
export const ROUTE_PREFIX = '/dsh-teammate-model'
const PROJECTION = 'modelSelection'
const ALLOWLIST_ENTRY = 'subagent-model-selection-settings'

export class SeatError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'SeatError'
    this.status = status
    this.code = code
  }
}

function service(ctx, name) {
  try {
    const viaGet = ctx.get?.(name)
    if (viaGet !== undefined && viaGet !== null) return viaGet
  } catch { /* probe-safe */ }
  try { return ctx?.[name] } catch { return undefined }
}

function defaultDataFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-agent-team-model-selection.json')
}

export function sameSelection(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

export function normalizeSelection(input) {
  const source = input ?? {}
  const provider = source.provider
  const model = source.model
  const effort = source.reasoningEffort
  for (const [field, value] of [['provider', provider], ['model', model], ['reasoningEffort', effort]]) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new SeatError(400, 'invalid-selection', field + ' must be a non-empty string when supplied')
    }
  }
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new SeatError(400, 'invalid-selection', 'provider and model are required together')
  }
  return {
    provider,
    model,
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
}

export function isLocalRequest(request) {
  const address = request?.socket?.remoteAddress ?? request?.connection?.remoteAddress ?? ''
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function createStore(file) {
  let cache
  async function load() {
    if (cache !== undefined) return cache
    try {
      const text = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      cache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      cache = {}
    }
    return cache
  }
  async function flush(entries) {
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    await fs.writeFile(file, JSON.stringify(entries, null, 2) + '\n', 'utf8')
  }
  return {
    async get(id) {
      const entries = await load()
      const value = entries[id]
      return value !== null && typeof value === 'object' ? { ...value } : null
    },
    async set(id, selection) {
      const entries = await load()
      entries[id] = { ...selection }
      await flush(entries)
    },
    async delete(id) {
      const entries = await load()
      if (Object.hasOwn(entries, id)) {
        delete entries[id]
        await flush(entries)
      }
    },
    async all() {
      const entries = await load()
      return { ...entries }
    },
    file,
  }
}

async function headerOf(ctx, sessionId) {
  const live = ctx.agents?.get?.(sessionId)
  if (live?.session?.header !== undefined) return live.session.header
  const sessions = service(ctx, 'sessions')
  const attached = sessions?.get?.(sessionId)
  if (attached?.header !== undefined) return attached.header
  const controller = service(ctx, 'sessionController')
  try {
    const inspected = await controller?.inspect?.(sessionId)
    if (inspected?.meta !== undefined) return inspected.meta
    if (inspected?.header !== undefined) return inspected.header
  } catch { /* not inspectable */ }
  return undefined
}

async function sessionOf(ctx, sessionId, live) {
  if (live?.session !== undefined) return live.session
  try {
    const sessions = service(ctx, 'sessions')
    return sessions?.get?.(sessionId)
  } catch {
    return undefined
  }
}

async function resolveTeammate(ctx, sessionId, hint) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { ok: false, reason: 'invalid-session' }
  }
  const live = ctx.agents?.get?.(sessionId)
  const session = await sessionOf(ctx, sessionId, live)
  let header = await headerOf(ctx, sessionId)
  // A dormant/attached teammate may not expose its header through the live
  // Session services. The addressed-session client already resolved a durable
  // parent address; accept it as the fallback evidence (loopback API only).
  const hintParent = typeof hint?.parentSessionId === 'string' && hint.parentSessionId.length > 0
    ? hint.parentSessionId
    : undefined
  // Only use the client hint when the durable header is unavailable. An
  // existing non-subagent header must never be re-labelled by the hint.
  if (header === undefined && hintParent !== undefined) {
    header = { origin: 'subagent', parentSession: hintParent }
  }
  if (header === undefined || header.origin !== 'subagent' || typeof header.parentSession !== 'string') {
    return { ok: false, reason: 'not-a-subagent' }
  }
  const teams = service(ctx, 'agentTeams')
  if (teams === undefined || teams === null) return { ok: false, reason: 'agent-teams-unavailable' }
  let membership
  try {
    if (live !== undefined && typeof teams.tryMembership === 'function') membership = teams.tryMembership(live)
  } catch { /* probe */ }
  if (membership === undefined && typeof teams.listMembers === 'function') {
    const parent = ctx.agents?.get?.(header.parentSession)
    if (parent !== undefined) {
      try {
        const rows = teams.listMembers(parent)
        const row = Array.isArray(rows) ? rows.find((entry) => entry?.id === sessionId) : undefined
        if (row !== undefined) membership = { root: parent, name: row.name, role: row.role ?? 'teammate' }
      } catch { /* not a team parent */ }
    }
  }
  // A teammate session can be viewed while both it and its Lead are dormant.
  // In that case there is no live Agent for tryMembership/listMembers; the
  // subagent header is the durable evidence. The client still only exposes the
  // seat for addressed sessions, and select re-validates the session.
  if (membership === undefined) membership = { name: header.title ?? 'teammate', role: 'teammate' }
  return { ok: true, live, session, header, membership }
}

function selectionFromAgent(agent) {
  try {
    const value = agent?.model?.current?.()
    if (value !== null && typeof value === 'object' && typeof value.provider === 'string' && typeof value.model === 'string') {
      return { provider: value.provider, model: value.model, ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort } }
    }
  } catch { /* no model facade */ }
  return undefined
}

function selectionFromProjection(ctx, session) {
  try {
    const projections = service(ctx, 'sessionProjections')
    const state = projections?.stateOf?.(session, PROJECTION)
    const value = state?.next ?? state?.lastUsed
    if (value !== null && typeof value === 'object' && typeof value.provider === 'string' && typeof value.model === 'string') {
      return { provider: value.provider, model: value.model, ...value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort } }
    }
  } catch { /* not projected */ }
  return undefined
}

function selectionFromHeader(session) {
  try {
    const config = session?.requestHeader?.()?.config
    if (config !== null && typeof config === 'object' && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model, ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort } }
    }
  } catch { /* no header */ }
  return undefined
}

function currentSelection(ctx, agent, session, preference) {
  return selectionFromAgent(agent)
    ?? selectionFromProjection(ctx, session)
    ?? selectionFromHeader(session)
    ?? preference
    ?? null
}

async function validateSelection(ctx, raw) {
  const selection = normalizeSelection(raw)
  const llm = service(ctx, 'llm')
  if (llm === undefined || llm === null) {
    throw new SeatError(500, 'llm-unavailable', 'the LLM service is unavailable; cannot validate a model route')
  }
  let providers = []
  try { providers = typeof llm.listProviders === 'function' ? llm.listProviders() : [] } catch { providers = [] }
  if (Array.isArray(providers) && providers.length > 0 && !providers.some((entry) => entry?.id === selection.provider)) {
    throw new SeatError(400, 'unknown-provider', 'LLM provider "' + selection.provider + '" is not registered')
  }
  let info
  try {
    if (typeof llm.resolveModelInfo === 'function') info = await llm.resolveModelInfo(selection.provider, selection.model)
    else if (typeof llm.resolveCallConfig === 'function') await llm.resolveCallConfig({ provider: selection.provider, model: selection.model })
    else throw new Error('neither llm.resolveModelInfo nor llm.resolveCallConfig is available')
  } catch (error) {
    throw new SeatError(400, 'unknown-model', 'LLM route "' + selection.provider + '/' + selection.model + '" could not be resolved: ' + (error instanceof Error ? error.message : String(error)))
  }
  if (selection.reasoningEffort !== undefined) {
    const efforts = info?.reasoning?.efforts
    const available = Array.isArray(efforts) ? efforts.map((entry) => entry?.id).filter(Boolean) : []
    if (!available.includes(selection.reasoningEffort)) {
      throw new SeatError(400, 'unknown-effort', 'reasoning effort "' + selection.reasoningEffort + '" is not advertised by "' + selection.provider + '/' + selection.model + '"; available: ' + (available.join(', ') || '(none)'))
    }
  }
  const policy = service(ctx, 'subagentModelSelection')
  if (policy !== undefined && policy !== null && typeof policy.current === 'function') {
    let current
    try { current = policy.current() } catch (error) {
      throw new SeatError(400, 'policy-invalid', 'the subagent model-selection settings are invalid: ' + (error instanceof Error ? error.message : String(error)))
    }
    if (current?.enabled === true) {
      const allowed = Array.isArray(current.allowedModels) ? current.allowedModels : []
      if (!allowed.some((route) => route?.provider === selection.provider && route?.model === selection.model)) {
        throw new SeatError(403, 'route-not-allowed', 'route "' + selection.provider + '/' + selection.model + '" is not allowed for delegation by this profile; change ' + ALLOWLIST_ENTRY + ' or pick an allowed route')
      }
    }
  }
  return selection
}

async function applyToAgent(ctx, agent, selection) {
  let target = agent
  if (target?.model === undefined || typeof target.model?.select !== 'function') {
    await Promise.resolve()
    target = ctx.agents?.get?.(agent?.id) ?? target
  }
  if (target?.model !== undefined && typeof target.model.select === 'function') {
    target.model.select(selection)
    return 'agent-model'
  }
  const controller = service(ctx, 'sessionController')
  const commit = controller?.selectForNextRequest !== undefined
    ? controller
    : controller?.agents?.selectForNextRequest !== undefined ? controller.agents : undefined
  if (commit !== undefined && typeof commit.selectForNextRequest === 'function') {
    commit.selectForNextRequest(target ?? agent, selection)
    return 'session-controller'
  }
  if (target?.session !== undefined && typeof target.session.append === 'function') {
    target.session.append('model/selection', selection)
    return 'session-append'
  }
  if (agent?.session !== undefined && typeof agent.session.append === 'function') {
    agent.session.append('model/selection', selection)
    return 'session-append'
  }
  throw new SeatError(500, 'no-apply-path', 'no Agent model facade, session-controller commit, or writable Session was available')
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  try {
    response.statusCode = status
    response.setHeader('content-type', 'application/json; charset=utf-8')
    response.setHeader('cache-control', 'no-store')
    response.end(body)
  } catch { /* response already closed */ }
}

async function readJson(request) {
  let text = ''
  for await (const chunk of request) {
    text += chunk
    if (text.length > 65536) throw new SeatError(413, 'body-too-large', 'request body is too large')
  }
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new SeatError(400, 'invalid-json', 'request body must be JSON') }
}

export function createApi(ctx, config = {}) {
  const store = createStore(config.dataFile ?? defaultDataFile())
  const log = {
    info: (message) => ctx.logger?.info?.(name + ': ' + message),
    warn: (message) => ctx.logger?.warn?.(name + ': ' + message),
  }

  async function state(sessionId, hint) {
    const resolved = await resolveTeammate(ctx, sessionId, hint)
    if (!resolved.ok) {
      return { ok: true, sessionId, teammate: false, current: null, source: 'none', reason: resolved.reason }
    }
    const preference = await store.get(sessionId)
    const live = selectionFromAgent(resolved.live)
    const projected = selectionFromProjection(ctx, resolved.session)
    const header = selectionFromHeader(resolved.session)
    // A dormant teammate has no Agent model facade. The stored preference is the
    // intended route; a stale projection/header from its previous turn must not
    // hide it. A live Agent's own selection wins.
    const current = resolved.live !== undefined
      ? (live ?? projected ?? header ?? preference)
      : (preference ?? projected ?? header ?? live)
    const source = resolved.live !== undefined && live !== undefined ? 'agent'
      : resolved.live === undefined && preference !== null ? 'preference'
        : projected !== undefined ? 'session'
          : header !== undefined ? 'request'
            : preference !== null ? 'preference' : 'none'
    return {
      ok: true,
      sessionId,
      teammate: true,
      name: resolved.membership.name,
      current,
      pending: preference !== null && !sameSelection(preference, current) ? preference : null,
      source,
    }
  }

  async function select(sessionId, raw) {
    const resolved = await resolveTeammate(ctx, sessionId, raw)
    if (!resolved.ok) {
      throw new SeatError(400, 'not-a-team-member', 'session "' + sessionId + '" is not an Agent Teams teammate (' + resolved.reason + ')')
    }
    const selection = await validateSelection(ctx, raw)
    await store.set(sessionId, selection)
    if (resolved.live !== undefined) {
      const via = await applyToAgent(ctx, resolved.live, selection)
      log.info('applied ' + selection.provider + '/' + selection.model + ' to ' + sessionId + ' via ' + via)
      return { ok: true, sessionId, applied: 'live', via, current: selection }
    }
    log.info('queued ' + selection.provider + '/' + selection.model + ' for ' + sessionId)
    return { ok: true, sessionId, applied: 'pending', current: selection }
  }

  async function applyCreated(agent) {
    if (typeof agent?.id !== 'string') return
    const preference = await store.get(agent.id)
    if (preference === null) return
    const resolved = await resolveTeammate(ctx, agent.id)
    if (!resolved.ok) return
    const current = currentSelection(ctx, agent, agent.session, null)
    if (sameSelection(current, preference)) return
    try {
      const via = await applyToAgent(ctx, agent, preference)
      log.info('re-applied ' + preference.provider + '/' + preference.model + ' on activation of ' + agent.id + ' via ' + via)
    } catch (error) {
      log.warn('could not re-apply ' + preference.provider + '/' + preference.model + ' on ' + agent.id + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  async function handleHttp(request, response) {
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { ok: false, code: 'forbidden', error: 'this endpoint is loopback-only' })
      return
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'GET' && url.pathname === ROUTE_PREFIX + '/health') {
        sendJson(response, 200, { ok: true, name })
        return
      }
      if (request.method === 'GET' && url.pathname === ROUTE_PREFIX + '/state') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') throw new SeatError(400, 'invalid-session', 'sessionId is required')
        sendJson(response, 200, await state(sessionId, { parentSessionId: url.searchParams.get('parentSessionId') ?? undefined }))
        return
      }
      if (request.method === 'POST' && url.pathname === ROUTE_PREFIX + '/select') {
        const body = await readJson(request)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') throw new SeatError(400, 'invalid-session', 'sessionId is required')
        sendJson(response, 200, await select(sessionId, body))
        return
      }
      sendJson(response, 404, { ok: false, code: 'not-found', error: 'unknown route' })
    } catch (error) {
      const status = error instanceof SeatError ? error.status : 500
      const code = error instanceof SeatError ? error.code : 'internal'
      sendJson(response, status, { ok: false, code, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return { state, select, applyCreated, handleHttp, store }
}

export function apply(ctx, config = {}) {
  const api = createApi(ctx, config)
  try {
    ctx.on?.('agent/created', ({ agent }) => {
      void api.applyCreated(agent).catch((error) => ctx.logger?.warn?.(name + ': apply-on-created failed: ' + (error instanceof Error ? error.message : String(error))))
    })
  } catch (error) {
    ctx.logger?.warn?.(name + ': could not subscribe to agent/created: ' + (error instanceof Error ? error.message : String(error)))
  }
  try {
    ctx.inject?.(['webServer'], (scope) => {
      try {
        const register = () => scope.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (request, response) => { void api.handleHttp(request, response) },
        })
        if (typeof scope.effect === 'function') scope.effect(register, name + ': routes')
        else register()
      } catch (error) {
        ctx.logger?.warn?.(name + ': could not register routes: ' + (error instanceof Error ? error.message : String(error)))
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(name + ': webServer unavailable: ' + (error instanceof Error ? error.message : String(error)))
  }
  return api
}
