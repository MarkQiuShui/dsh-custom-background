/**
 * Publish-ready smoke test: syntax + host routes (upload/serve) + host settings
 * contract (volatile Config) + browser half (settings section registration, live
 * stylesheet, upload flow, the URL field showing the uploaded path).
 *
 * Run from the repo root:
 *   npm run check
 *   npm test
 *
 * jsdom + @deepseek-ai/schemastery are the only dependencies; no harness boot.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import Schema from '@deepseek-ai/schemastery'
import { Config, apply as hostApply, inject as hostInject, name as hostName } from '../index.js'

const IMAGE_DIR = join(import.meta.dirname, '..', 'image')

// ══════════ Host half ══════════
if (hostName !== 'dsh-custom-background') throw new Error('bad host plugin name')
if (!hostInject.includes('webServer')) throw new Error('host half must inject webServer')

const exact = new Map()
const prefixes = new Map()
let settingsPolicy = null
const hostFiber = { uid: 1 }
const hostCtx = {
  effect: (fn) => fn(),
  fiber: hostFiber,
  webServer: {
    register: (r) => {
      if (r.kind === 'exact') { exact.set(r.path, r); return () => {} }
      prefixes.set(r.path, r)
      return () => {}
    },
  },
  inject: (services, fn) => {
    if (!services.includes('settings')) return
    fn({
      effect: (fn2) => fn2(),
      // Deliberately NO `register`: the harness settings service has no such
      // method (its surface is configure/describe/update/replace/mutate), and
      // calling one used to be exactly why nothing persisted.
      settings: {
        configure: (presentation, owner) => {
          settingsPolicy = { presentation, owner }
          return () => {}
        },
      },
    })
  },
}
hostApply(hostCtx)

if (!exact.has('/dsh-custom-background/upload')) throw new Error('upload route missing')
if (!prefixes.has('/dsh-custom-background')) throw new Error('image route missing')
if (settingsPolicy === null) throw new Error('settings page policy not configured')
if (settingsPolicy.presentation.auto !== false) throw new Error('the plugin owns its page; auto page must stand down')
if (settingsPolicy.owner !== hostFiber) throw new Error('settings.configure must be owned by the plugin fiber')

// ── host settings contract ───────────────────────────────────────────────
// The settings namespace of a plugin is its Loader entry id and only
// `volatile` Config fields are projected into it. These two helpers are
// copied verbatim from packages/settings/settings/src/schema.ts so the test
// asserts against the harness's real projection rules.
function plainSchema(node) {
  const result = new Schema(node.toJSON())
  const walk = (current) => {
    delete current.meta.volatile
    for (const child of Object.values(current.dict ?? {})) walk(child)
    if (current.inner) walk(current.inner)
  }
  walk(result)
  return result
}
function volatileForm(node) {
  if (node.meta.volatile) return plainSchema(node)
  if (node.type === 'object') {
    const dict = Object.fromEntries(Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
      const field = volatileForm(child)
      return field === undefined ? [] : [[key, field]]
    }))
    return Object.keys(dict).length === 0 ? undefined : Schema.object(dict)
  }
  return undefined
}
function isVolatilePath(node, path) {
  if (node.meta.volatile) return true
  const [key, ...rest] = path
  const child = key === undefined ? undefined : node.dict?.[key]
  return child !== undefined && isVolatilePath(child, rest)
}
function projectForm(node, value) {
  if (node.type === 'object' && value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(node.dict ?? {}).flatMap(([key, child]) => {
      const field = value[key]
      return field === undefined ? [] : [[key, projectForm(child, field)]]
    }))
  }
  return value
}

if (typeof Config !== 'function' || Config.type !== 'object') throw new Error('Config schema not exported')
const FIELDS = ['enabled', 'image', 'color', 'overlayAlpha', 'panelAlpha']
for (const field of FIELDS) {
  const node = Config.dict?.[field]
  if (node === undefined) throw new Error('Config field missing: ' + field)
  if (node.meta?.volatile !== true) throw new Error('Config field must be volatile: ' + field)
  if (!isVolatilePath(Config, [field])) throw new Error('field is not an editable settings path: ' + field)
}
if (isVolatilePath(Config, ['nope'])) throw new Error('unknown field must not be an editable settings path')

const form = volatileForm(Config)
if (form === undefined) throw new Error('volatileForm rejected the Config (no editable field)')
if (Object.keys(form.dict ?? {}).join(',') !== FIELDS.join(',')) {
  throw new Error('projected settings fields mismatch: ' + Object.keys(form.dict ?? {}).join(','))
}
// The wire schema the browser rehydrates must accept a stored section.
const wireSchema = new Schema(form.toJSON())
const defaults = { enabled: true, image: '', color: '#0e1116', overlayAlpha: 0.45, panelAlpha: 0.8 }
wireSchema(defaults)
const projected = projectForm(form, defaults)
if (JSON.stringify(projected) !== JSON.stringify(defaults)) {
  throw new Error('projectForm lost fields: ' + JSON.stringify(projected))
}
wireSchema({ ...defaults, image: '/dsh-custom-background/image/wall.png', overlayAlpha: 0, panelAlpha: 1 })

// The browser half binds ctx.configForms.get(NS); NS must equal the Loader row
// id from cordis.patch.yml or the namespace would never resolve.
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/m.exec(patch)?.[1]
if (rowId === undefined) throw new Error('cordis.patch.yml has no entry id')
if (rowId !== 'custom-background') throw new Error('unexpected Loader row id: ' + rowId)

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

// Minimal hook runtime standing in for React: state survives renders, setters
// mark the pass dirty, and the render is retried until it settles — which is
// how React handles a state update during render.
let hookState = []
let hookIndex = 0
let hookDirty = false
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = initial
    return [hookState[index], (next) => {
      if (hookState[index] !== next) hookDirty = true
      hookState[index] = next
    }]
  },
}

let registration = null
dom.window.__ModuleLoader__ = { load: (r) => { registration = r } }
;(0, eval)(await readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
if (registration.id !== 'dsh-custom-background') throw new Error('bad registration id')

const exportsObj = registration.factory((spec) => {
  if (spec === 'react') return fakeReact
  throw new Error('unexpected require: ' + spec)
})
if (exportsObj.name !== 'custom-background') throw new Error('bad plugin name')
if (!exportsObj.inject.includes('configForms')) throw new Error('client half must inject configForms')

let scopeState = {
  status: 'ready',
  value: { enabled: true, image: '', color: '#0e1116', overlayAlpha: 0.45, panelAlpha: 0.8 },
  revision: 0,
  writable: true,
}
let setAccepts = true
const scopeListeners = new Set()
const writes = []
const scope = {
  getSnapshot: () => scopeState,
  subscribe: (fn) => { scopeListeners.add(fn); return () => scopeListeners.delete(fn) },
  set: async (field, value) => {
    writes.push(['set', field, value])
    if (!setAccepts) return false
    scopeState = { ...scopeState, value: { ...scopeState.value, [field]: value }, revision: scopeState.revision + 1 }
    for (const fn of [...scopeListeners]) fn()
    return true
  },
  unset: async (field) => {
    writes.push(['unset', field])
    if (!setAccepts) return false
    const next = { ...scopeState.value }
    delete next[field]
    scopeState = { ...scopeState, value: next, revision: scopeState.revision + 1 }
    for (const fn of [...scopeListeners]) fn()
    return true
  },
}

const localeRegs = []
const slotInjects = []
const sectionRegs = []
let requestedNamespace = null
const ctx = {
  effect: (fn) => fn(),
  locale: { register: (ns, dicts) => { localeRegs.push([ns, dicts]) }, bind: () => (k) => k },
  configForms: { get: (ns) => { requestedNamespace = ns; return scope } },
  slots: {
    inject: (name, factory) => { slotInjects.push([name, factory]) },
    register: (options, component) => { sectionRegs.push({ options, component }); return () => {} },
  },
}
exportsObj.apply(ctx)

if (requestedNamespace !== rowId) {
  throw new Error('client bound the wrong settings namespace: ' + String(requestedNamespace))
}
if (!localeRegs.some(([ns]) => ns === 'settings.customBackground')) throw new Error('locale not registered')
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

// ── stylesheet policy ────────────────────────────────────────────────────
// Only the two frame walls may be tinted. A translucent menu/modal/card token
// shows the page through floating text, and `--dsw-alias-bg-layer-3` is also
// consumed as an inverted text color, so those must keep the theme's opaque
// value.
const TINTED = [
  '--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) var(--cb-panel), transparent)',
  '--dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) var(--cb-panel), transparent)',
]
const UNTOUCHED = [
  '--dsw-specific-menu',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-module-platform',
]
for (const decl of TINTED) if (!style.textContent.includes(decl)) throw new Error('frame surface not tinted: ' + decl)
for (const token of UNTOUCHED) if (style.textContent.includes(token)) throw new Error('token must stay opaque: ' + token)
if (!style.textContent.includes('--dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) var(--cb-panel), transparent)')) {
  throw new Error('dark frame surface must use the dark palette tone')
}
for (const token of ['--dsw-alias-bg-base', '--dsw-specific-sidebar-fill']) {
  if (!new RegExp(token + ': color-mix\\([^;]+\\) !important;').test(style.textContent)) {
    throw new Error('frame surface override must be important: ' + token)
  }
}
if (style.textContent.includes('rgba(255, 255, 255') || style.textContent.includes('rgba(13, 15, 19')) {
  throw new Error('frame surfaces must derive from the theme palette, not literal near-white/near-black')
}

// Both alphas ride inline custom properties, so a value change must not touch
// the sheet text at all — that is what keeps a slider drag cheap. `inherits:
// false` keeps the change from dirtying the whole app subtree.
const bodyStyle = () => dom.window.document.body.style
if (!style.textContent.includes('@property --cb-overlay { syntax: "<color>"; inherits: false;')) {
  throw new Error('overlay alpha variable must be registered with inherits: false')
}
if (!style.textContent.includes('@property --cb-panel { syntax: "<percentage>"; inherits: false;')) {
  throw new Error('panel alpha variable must be registered with inherits: false')
}
if (!style.textContent.includes('linear-gradient(var(--cb-overlay), var(--cb-overlay))')) {
  throw new Error('overlay must be read from its custom property')
}
await scope.set('panelAlpha', 0.5)
if (bodyStyle().getPropertyValue('--cb-panel') !== '50%') {
  throw new Error('panel alpha not published as a custom property')
}
await scope.set('overlayAlpha', 0.25)
if (bodyStyle().getPropertyValue('--cb-overlay') !== 'rgba(8, 10, 14, 0.25)') {
  throw new Error('overlay alpha not published as a custom property')
}
await scope.set('panelAlpha', 0.8)
await scope.set('overlayAlpha', 0.45)

await scope.set('enabled', false)
if (style.textContent !== '') throw new Error('disabled plugin must emit no stylesheet')
if (dom.window.document.body.getAttribute('style') !== '') {
  throw new Error('disabled plugin must drop the alpha variables')
}
await scope.set('enabled', true)

// ── upload appends the stored URL to the image field and the stylesheet ───
const sectionProps = () => ({
  useBackground: (sel) => sel(face.hooks.background.getSnapshot()),
  setField: face.setField,
  reset: face.reset,
  uploadImage: face.uploadImage,
  previewAlpha: face.previewAlpha,
  flushAlpha: face.flushAlpha,
  t: (k) => k,
})
function renderSection() {
  for (let pass = 0; pass < 5; pass++) {
    hookIndex = 0
    hookDirty = false
    const tree = section.component(sectionProps())
    if (!hookDirty) return tree
  }
  throw new Error('section hooks did not settle')
}
function collect(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out }
  if (typeof node.type === 'string') out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}
const imageInput = () => collect(renderSection()).find((node) => node.type === 'input' && node.props.type === 'text')

let fetchCalled = null
const uploadedUrl = '/dsh-custom-background/image/up-' + tag + '.png'
globalThis.fetch = async (url, opts) => {
  fetchCalled = { url, opts }
  return { ok: true, status: 200, json: async () => ({ ok: true, url: uploadedUrl }) }
}
await face.uploadImage({ name: 'wall.png' })
if (fetchCalled === null || !fetchCalled.url.startsWith('/dsh-custom-background/upload?name=')) throw new Error('upload fetch not called')
if (!writes.some(([op, f, v]) => op === 'set' && f === 'image' && v.includes('up-' + tag))) throw new Error('image not set after upload')
if (!style.textContent.includes('url("' + uploadedUrl + '")')) throw new Error('style did not update')
if (face.hooks.background.getSnapshot().uploadStatus !== 'ok') throw new Error('upload status not ok')
// The URL field must SHOW the stored path (it used to be an uncontrolled
// defaultValue, so the path never appeared).
const shown = imageInput()
if (shown === undefined || shown.props.value !== uploadedUrl) {
  throw new Error('image field does not show the uploaded path: ' + JSON.stringify(shown?.props?.value))
}
// The field is the only writer on blur, and a manual URL commits too.
shown.props.onChange({ target: { value: '  /custom/a b.png  ' } })
const edited = imageInput()
edited.props.onBlur()
if (!writes.some(([op, f, v]) => op === 'set' && f === 'image' && v === '/custom/a b.png')) {
  throw new Error('manual image URL was not committed trimmed')
}

// A Host that refuses the write must not be reported as an applied upload.
setAccepts = false
await face.uploadImage({ name: 'wall2.png' })
setAccepts = true
if (face.hooks.background.getSnapshot().uploadStatus !== 'unsaved') throw new Error('refused settings write must surface as unsaved')

globalThis.fetch = async () => { throw new Error('network down') }
await face.uploadImage({ name: 'fail.png' })
const failure = face.hooks.background.getSnapshot()
if (failure.uploadStatus !== 'error') throw new Error('upload failure status missing')
if (typeof failure.uploadDetail !== 'string' || failure.uploadDetail === '') throw new Error('upload failure detail missing')

const flat = JSON.stringify(renderSection())
for (const key of ['title', 'enabled', 'image', 'upload', 'color', 'overlay', 'panel', 'reset']) {
  if (!flat.includes(key)) throw new Error('section missing label: ' + key)
}
if (!flat.includes('"type":"file"') && !flat.includes("type: 'file'")) throw new Error('file input missing')

// ── the two alpha sliders preview locally and write once per gesture ─────
// A range input fires one event per pointer move. Each of those used to be a
// settings write, and the Host's config editor (file lock + whole-patch
// rewrite + Loader reconcile) could not keep up, so the writes queued up and
// the thumb lagged. A drag must now reach the DOM/CSS immediately and the Host
// at most once.
const ranges = () => collect(renderSection())
  .filter((node) => node.type === 'input' && node.props.type === 'range')
const first = ranges()
if (first.length !== 2) throw new Error('expected two alpha sliders, got ' + first.length)
if (first[0].props.value !== 45 || first[1].props.value !== 80) {
  throw new Error('sliders must start at the persisted alphas: ' + first.map((node) => node.props.value).join(','))
}
for (const node of first) {
  if (typeof node.props.onPointerUp !== 'function' || typeof node.props.onKeyUp !== 'function'
    || typeof node.props.onBlur !== 'function') {
    throw new Error('a slider must commit on release, key-up and blur')
  }
}

writes.length = 0
first[0].props.onChange({ target: { value: '20' } })
const dragged = ranges()[0]
if (dragged.props.value !== 20) throw new Error('slider did not follow the pointer')
if (bodyStyle().getPropertyValue('--cb-overlay') !== 'rgba(8, 10, 14, 0.2)') {
  throw new Error('a drag step must preview through the overlay custom property')
}
if (writes.length !== 0) throw new Error('a drag step must not write to the Host: ' + JSON.stringify(writes))
if (style.textContent.includes('rgba(8, 10, 14, 0.2)')) {
  throw new Error('a drag step must not rewrite the stylesheet')
}

// Releasing writes the settled value exactly once and ends the preview.
dragged.props.onPointerUp()
if (writes.length !== 1) throw new Error('release must write once: ' + JSON.stringify(writes))
if (writes[0][0] !== 'set' || writes[0][1] !== 'overlayAlpha' || writes[0][2] !== 0.2) {
  throw new Error('release wrote the wrong value: ' + JSON.stringify(writes[0]))
}
await new Promise((resolve) => setTimeout(resolve, 0))
if (face.hooks.background.getSnapshot().preview.overlayAlpha !== null) {
  throw new Error('the preview must end once the Host answered')
}
if (bodyStyle().getPropertyValue('--cb-overlay') !== 'rgba(8, 10, 14, 0.2)') {
  throw new Error('the persisted value must keep the alpha after the echo')
}

// A drag that never gets a release still settles on its own.
writes.length = 0
ranges()[1].props.onChange({ target: { value: '30' } })
if (bodyStyle().getPropertyValue('--cb-panel') !== '30%') throw new Error('panel drag must preview')
if (writes.length !== 0) throw new Error('panel drag must not write yet')
await new Promise((resolve) => setTimeout(resolve, 300))
if (writes.length !== 1 || writes[0][1] !== 'panelAlpha' || writes[0][2] !== 0.3) {
  throw new Error('the settle timer must write once: ' + JSON.stringify(writes))
}

writes.length = 0
await face.reset()
if (writes.filter(([op]) => op === 'unset').length !== 5) throw new Error('reset incomplete')

// cleanup uploaded fixtures
for (const name of uploaded) {
  const p = join(IMAGE_DIR, name)
  if (existsSync(p)) rmSync(p)
}

console.log('ALL_SMOKE_CHECKS_OK')
