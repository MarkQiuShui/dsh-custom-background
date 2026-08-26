/**
 * Publish-ready smoke test: syntax + host routes (upload/serve) + browser
 * half (settings section registration, live stylesheet, upload flow).
 *
 * Run from the repo root:
 *   npm run check
 *   npm test
 *
 * No network, no harness dependencies — jsdom is the only devDependency.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { apply as hostApply } from '../index.js'

const IMAGE_DIR = join(import.meta.dirname, '..', 'image')

// ══════════ Host half ══════════
const exact = new Map()
const prefixes = new Map()
let settingsReg = null
const hostCtx = {
  effect: (fn) => fn(),
  webServer: {
    register: (r) => {
      if (r.kind === 'exact') { exact.set(r.path, r); return () => {} }
      prefixes.set(r.path, r)
      return () => {}
    },
  },
  inject: (services, fn) => {
    if (services.includes('settings')) {
      fn({ settings: { register: (ns, schema, opts) => { settingsReg = { ns, schema, opts } } } })
    }
  },
}
hostApply(hostCtx)

if (!exact.has('/dsh-custom-background/upload')) throw new Error('upload route missing')
if (!prefixes.has('/dsh-custom-background')) throw new Error('image route missing')
if (settingsReg === null || settingsReg.ns !== 'custom-background') throw new Error('settings ns wrong')
const defaults = settingsReg.schema({})
const clamped = settingsReg.schema({ enabled: false, overlayAlpha: 5, panelAlpha: -2 })
if (defaults.enabled !== true || defaults.overlayAlpha !== 0.45 || defaults.panelAlpha !== 0.8) throw new Error('schema defaults wrong')
if (clamped.overlayAlpha !== 1 || clamped.panelAlpha !== 0) throw new Error('schema clamp wrong')

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const exactRoute = exact.get(pathname)
  if (exactRoute !== undefined) return await exactRoute.handler(req, res)
  let best = null
  for (const [prefix, route] of prefixes) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
    if (best === null || prefix.length > best[0].length) best = [prefix, route]
  }
  if (best !== null) return await best[1].handler(req, res)
  res.writeHead(404)
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + server.address().port
const tag = 'smoke-' + Date.now()
const uploaded = []

try {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3])
  const up = await fetch(base + '/dsh-custom-background/upload?name=' + encodeURIComponent(tag + '.png'), {
    method: 'POST',
    body: png,
    headers: { 'content-type': 'image/png' },
  })
  const upJson = await up.json()
  if (up.status !== 200 || !upJson.url || !upJson.url.endsWith(tag + '.png')) {
    throw new Error('upload failed: ' + JSON.stringify(upJson))
  }
  uploaded.push(tag + '.png')
  const fetched = await fetch(base + upJson.url)
  if (fetched.status !== 200 || fetched.headers.get('content-type') !== 'image/png') {
    throw new Error('uploaded file not served')
  }

  const up2 = await fetch(base + '/dsh-custom-background/upload?name=' + encodeURIComponent(tag + '.png'), {
    method: 'POST',
    body: png,
    headers: { 'content-type': 'image/png' },
  })
  const up2Json = await up2.json()
  if (up2.status !== 200 || up2Json.url === upJson.url || !up2Json.url.includes('-')) {
    throw new Error('collision handling failed')
  }
  uploaded.push(up2Json.url.split('/').pop())

  const bad = await fetch(base + '/dsh-custom-background/upload?name=x.exe', { method: 'POST', body: png })
  if (bad.status !== 400) throw new Error('expected 400 for bad ext')
  const noext = await fetch(base + '/dsh-custom-background/upload?name=' + tag, { method: 'POST', body: png })
  if (noext.status !== 400) throw new Error('expected 400 for no ext')
  const big = await fetch(base + '/dsh-custom-background/upload?name=' + tag + '-big.png', { method: 'POST', body: Buffer.alloc(9 * 1024 * 1024) })
  if (big.status !== 413) throw new Error('expected 413, got ' + big.status)
  const getUpload = await fetch(base + '/dsh-custom-background/upload')
  if (getUpload.status !== 405) throw new Error('expected 405 on GET upload')
} finally {
  server.close()
}

// ══════════ Browser half ══════════
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost:3080/' })
globalThis.window = dom.window
globalThis.document = dom.window.document

const fakeReact = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }) }
let registration = null
dom.window.__ModuleLoader__ = { load: (r) => { registration = r } }
;(0, eval)(await readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
if (registration.id !== 'dsh-custom-background') throw new Error('bad registration id')

const exportsObj = registration.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected require: ' + spec)
})
if (exportsObj.name !== 'custom-background') throw new Error('bad plugin name')

let scopeState = { status: 'ready', value: { enabled: true, image: '', color: '#0e1116', overlayAlpha: 0.45, panelAlpha: 0.8 }, revision: 0, writable: true }
const scopeListeners = new Set()
const writes = []
const scope = {
  getSnapshot: () => scopeState,
  subscribe: (fn) => { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
  set: async (field, value) => {
    writes.push(['set', field, value])
    scopeState = { ...scopeState, value: { ...scopeState.value, [field]: value }, revision: scopeState.revision + 1 }
    for (const fn of [...scopeListeners]) fn()
  },
  unset: async (field) => {
    writes.push(['unset', field])
    const next = { ...scopeState.value }
    delete next[field]
    scopeState = { ...scopeState, value: next, revision: scopeState.revision + 1 }
    for (const fn of [...scopeListeners]) fn()
  },
}

const localeRegs = []
const slotInjects = []
const sectionRegs = []
let bindSpec = null
const ctx = {
  effect: (fn) => fn(),
  locale: { register: (ns, dicts) => { localeRegs.push([ns, dicts]) }, bind: () => (k) => k },
  settingsScope: { bind: (spec) => { bindSpec = spec; return scope } },
  slots: {
    inject: (name, factory) => { slotInjects.push([name, factory]) },
    register: (options, component) => { sectionRegs.push({ options, component }); return () => {} },
  },
}
exportsObj.apply(ctx)

if (!localeRegs.some(([ns]) => ns === 'settings.customBackground')) throw new Error('locale not registered')
if (bindSpec === null || bindSpec.namespace !== 'custom-background') throw new Error('scope not bound')
if (!slotInjects.some(([name]) => name === 'settings.section')) throw new Error('top-level section slot missing')
if (slotInjects.some(([name]) => name === 'settings.plugin.item')) throw new Error('old plugin.item card still present')

slotInjects.find(([name]) => name === 'settings.section')[1]()
const section = sectionRegs[0]
if (section.options.name !== 'settings.section' || section.options.id !== 'custom-background' || section.options.order !== 5) {
  throw new Error('bad section registration')
}
if (typeof section.options.label() !== 'string') throw new Error('section label thunk broken')

const face = section.options.inject()
if (typeof face.hooks.background.getSnapshot !== 'function') throw new Error('hooks seat missing')
if (typeof face.setField !== 'function' || typeof face.reset !== 'function' || typeof face.uploadImage !== 'function') {
  throw new Error('actions missing')
}

const style = dom.window.document.head.querySelector('style[data-plugin="dsh-custom-background"]')
if (!style) throw new Error('style missing')

let fetchCalled = null
globalThis.fetch = async (url, opts) => {
  fetchCalled = { url, opts }
  return { ok: true, status: 200, json: async () => ({ ok: true, url: '/dsh-custom-background/image/up-' + tag + '.png' }) }
}
await face.uploadImage({ name: 'wall.png' })
if (fetchCalled === null || !fetchCalled.url.startsWith('/dsh-custom-background/upload?name=')) throw new Error('upload fetch not called')
if (!writes.some(([op, f, v]) => op === 'set' && f === 'image' && v.includes('up-' + tag))) throw new Error('image not set after upload')
if (!style.textContent.includes('url("/dsh-custom-background/image/up-' + tag + '.png")')) throw new Error('style did not update')
if (face.hooks.background.getSnapshot().uploadStatus !== 'ok') throw new Error('upload status not ok')

globalThis.fetch = async () => { throw new Error('network down') }
await face.uploadImage({ name: 'fail.png' })
if (face.hooks.background.getSnapshot().uploadStatus !== 'error') throw new Error('upload failure status missing')

const tree = section.component({
  useBackground: (sel) => sel(face.hooks.background.getSnapshot()),
  setField: face.setField,
  reset: face.reset,
  uploadImage: face.uploadImage,
  t: (k) => k,
  close: () => {},
})
const flat = JSON.stringify(tree)
for (const key of ['title', 'enabled', 'image', 'upload', 'color', 'overlay', 'panel', 'reset']) {
  if (!flat.includes(key)) throw new Error('section missing label: ' + key)
}
if (!flat.includes('"type":"file"') && !flat.includes("type: 'file'")) throw new Error('file input missing')

writes.length = 0
await face.reset()
if (writes.filter(([op]) => op === 'unset').length !== 5) throw new Error('reset incomplete')

// cleanup uploaded fixtures
for (const name of uploaded) {
  const p = join(IMAGE_DIR, name)
  if (existsSync(p)) rmSync(p)
}

console.log('ALL_SMOKE_CHECKS_OK')
