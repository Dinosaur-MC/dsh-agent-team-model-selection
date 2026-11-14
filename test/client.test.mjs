import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')

test('client mounts the official ModelSelect directly in the right slot', () => {
  assert.match(source, /id: "dsh-agent-team-model-selection"/)
  assert.match(source, /conversation\.input\.right/)
  assert.doesNotMatch(source, /conversation\.input\.left/)
  assert.match(source, /function TeammateSeat/)
  assert.match(source, /react\.createElement\(ModelSelect/)
  assert.match(source, /id: "teammate-model-selection"/)
})

test('anchoring degrades gracefully when the host drops useAnchoredPosition', () => {
  assert.match(source, /function useLocalAnchoredPosition/)
  assert.match(source, /typeof _deepseek_ai_dsh_client_ui_primitives\.useAnchoredPosition === "function"/)
  assert.match(source, /const menuPos = useAnchoredPositionCompat\(\{/)
})

test('official directory is re-aimed at the teammate/subagent host route', () => {
  assert.match(source, /directory\.available = \(\) => true/)
  assert.match(source, /dsh-teammate-model\/select/)
  assert.match(source, /directory\.select = async/)
})

test('no single-slot takeover or z-index hacks remain', () => {
  assert.doesNotMatch(source, /function OfficialSeat/)
  assert.doesNotMatch(source, /querySelectorAll/)
  assert.doesNotMatch(source, /visibility = "hidden"/)
  assert.doesNotMatch(source, /2147483647/)
  assert.doesNotMatch(source, /showPopover/)
})
