import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, name, inject, ROUTE_PREFIX } from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

test('package declares the DSH bundle, client and version contract', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-agent-team-model-selection')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.engines.dsh, 'engines.dsh must be declared')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('host entry exports a name, inject list and apply', () => {
  assert.equal(name, 'dsh-agent-team-model-selection')
  assert.deepEqual(inject, ['agents', 'llm'])
  assert.equal(typeof apply, 'function')
  assert.equal(ROUTE_PREFIX, '/dsh-teammate-model')
})
