/**
 * Host half of dsh-custom-background.
 *
 * The Loader row (`name: dsh-custom-background`) resolves this module on the
 * Node side, which is also what lets the client-module scan pick up the
 * package's `dsh.client` declaration.
 *
 * Host-side jobs:
 *  1. Serve the plugin's `image/` directory over HTTP so the browser half can
 *     reference local background images as `/dsh-custom-background/image/<file>`
 *     (the dsh web server otherwise only serves /api and /plugins/<id>/client.js,
 *     never plugin-owned assets).
 *  2. Accept local background image uploads: `POST /dsh-custom-background/upload`
 *     saves the raw body into `image/` and answers the public URL.
 *  3. Register the `custom-background` settings namespace so the Web Settings
 *     page offers a top-level section (设置 → 自定义背景) and persists its
 *     choices into the Host user-settings document ($DSH_HOME/settings.yaml).
 *
 * The schema is deliberately dependency-free: from this plugin's directory the
 * harness packages (@deepseek-ai/dsh-settings, @deepseek-ai/schemastery) are
 * not resolvable, so a small callable schema with `toJSON` is provided instead
 * of importing them. The client half passes a `decode` when binding the scope,
 * which bypasses client-side schema rehydration entirely.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-custom-background'

/** Required services: the web route registry provided by dsh-web-app. */
export const inject = ['webServer']

/** URL prefix the browser half uses for background images. */
const ROUTE_PREFIX = '/dsh-custom-background'

/** Exact route accepting local image uploads (POST). */
const UPLOAD_PATH = ROUTE_PREFIX + '/upload'

/** Absolute path of the plugin's image directory (this file's sibling). */
const IMAGE_DIR = normalize(fileURLToPath(new URL('./image/', import.meta.url)))

/** Upload size cap: 8 MiB is plenty for a wallpaper. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

/** Settings namespace keyed by the browser section (must match client.js). */
const NS = 'custom-background'

/** Composition-layer defaults the settings schema resolves (mirrors client.js). */
const DEFAULTS = Object.freeze({
  enabled: true,
  image: '',
  color: '#0e1116',
  overlayAlpha: 0.45,
  panelAlpha: 0.8,
})

/** Clamp a number into the 0..1 range. */
function clamp(value) {
  return Math.min(1, Math.max(0, value))
}

/** Coerce any stored section into the plugin's five-field shape with defaults. */
function normalizeSection(value) {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
    image: typeof raw.image === 'string' ? raw.image : DEFAULTS.image,
    color: typeof raw.color === 'string' ? raw.color : DEFAULTS.color,
    overlayAlpha: typeof raw.overlayAlpha === 'number' && Number.isFinite(raw.overlayAlpha)
      ? clamp(raw.overlayAlpha)
      : DEFAULTS.overlayAlpha,
    panelAlpha: typeof raw.panelAlpha === 'number' && Number.isFinite(raw.panelAlpha)
      ? clamp(raw.panelAlpha)
      : DEFAULTS.panelAlpha,
  }
}

/**
 * Minimal settings schema: callable (settings provider resolves sections
 * through it) plus `toJSON` (the describe surface serializes it). The client
 * half binds with a `decode` and never rehydrates this envelope.
 */
const schema = Object.assign(
  (value) => normalizeSection(value),
  { toJSON: () => ({ type: 'object', fields: {} }) },
)

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/**
 * Plugin body: register the image route, the upload route, and the settings
 * namespace. All ride effects on this fiber, so unload / HMR removes them.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: serveImage,
  }), name + ': image route')

  // Exact route wins over the prefix (webserver matches exact first), so
  // /dsh-custom-background/upload never reaches serveImage.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: handleUpload,
  }), name + ': upload route')

  // While a settings provider exists, register the namespace. The scoped
  // proxy rebinds this.ctx to the caller's fiber, so disposal of this plugin
  // releases the registration. Changes apply live (the browser re-renders the
  // background on every committed section).
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NS, schema, { base: {} })
  })
}

/**
 * Serve one plugin-owned image: `/dsh-custom-background/image/<file>`.
 * GET/HEAD only; unknown extensions, path traversal, and missing files answer
 * 404. Directory escape is blocked by both the `..` guard and the resolved
 * prefix containment check.
 */
async function serveImage(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (!pathname.startsWith(ROUTE_PREFIX + '/')) {
    res.writeHead(404)
    res.end()
    return
  }
  const underImage = pathname.slice(ROUTE_PREFIX.length + 1)
  // Only files directly under the plugin's image/ directory are served:
  // /dsh-custom-background/image/<file> → <file> resolved inside IMAGE_DIR.
  if (!underImage.startsWith('image/')) {
    res.writeHead(404)
    res.end()
    return
  }
  const relative = underImage.slice('image/'.length)
  const type = MIME[extname(relative).toLowerCase()]
  if (type === undefined || relative.includes('..')) {
    res.writeHead(404)
    res.end()
    return
  }
  const base = IMAGE_DIR.endsWith(sep) ? IMAGE_DIR.slice(0, -sep.length) : IMAGE_DIR
  const target = normalize(join(IMAGE_DIR, relative))
  if (target !== base && !target.startsWith(base + sep)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  } catch {
    res.writeHead(404)
    res.end()
  }
}

/**
 * Accept one local background image: `POST /dsh-custom-background/upload?name=<file>`.
 * The body is the raw file bytes; the original filename only supplies the
 * extension — storage names are sanitized and collision-safe, so the client
 * can never write outside `image/` or overwrite an existing file.
 * Answers JSON `{ "url": "/dsh-custom-background/image/<stored>" }`.
 */
async function handleUpload(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  const fail = (status, error) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error }))
  }

  let name
  try {
    name = new URL(req.url ?? '/', 'http://x').searchParams.get('name')
  } catch {
    fail(400, 'bad request url')
    return
  }

  const body = await collectBody(req, MAX_UPLOAD_BYTES)
  if (body === null) {
    fail(413, 'image exceeds the 8 MiB upload limit')
    return
  }
  if (body.length === 0) {
    fail(400, 'empty upload')
    return
  }

  // Original filename → extension allowlist; the stored basename is rebuilt
  // from safe characters only.
  const original = String(name ?? 'upload').replace(/\\/g, '/').split('/').pop() ?? 'upload'
  const ext = extname(original).toLowerCase()
  if (MIME[ext] === undefined) {
    fail(400, 'unsupported image type (jpg/jpeg/png/gif/webp/svg only)')
    return
  }
  let stored = original.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80)
  if (stored === '' || stored === '.' || stored === '..' || !stored.includes('.')) {
    fail(400, 'invalid filename')
    return
  }

  const base = IMAGE_DIR.endsWith(sep) ? IMAGE_DIR.slice(0, -sep.length) : IMAGE_DIR
  let target = normalize(join(IMAGE_DIR, stored))
  if (!target.startsWith(base + sep) || target === base) {
    fail(400, 'invalid filename')
    return
  }
  // Collision-safe: never overwrite an existing file.
  if (existsSync(target)) {
    stored = Date.now() + '-' + stored
    target = normalize(join(IMAGE_DIR, stored))
  }
  try {
    // Ensure the image directory exists (a fresh clone may not carry it).
    await mkdir(IMAGE_DIR, { recursive: true })
    await writeFile(target, body, { flag: 'wx' })
  } catch (error) {
    if ((error && error.code === 'EEXIST')) {
      // Lost a race with another upload of the same name — retry once with a
      // timestamp prefix instead of failing the caller.
      stored = Date.now() + '-' + stored
      target = normalize(join(IMAGE_DIR, stored))
      try {
        await writeFile(target, body, { flag: 'wx' })
      } catch {
        fail(500, 'failed to store upload')
        return
      }
    } else {
      fail(500, 'failed to store upload')
      return
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, url: ROUTE_PREFIX + '/image/' + stored }))
}

/**
 * Collect the request body with a hard size cap.
 * @returns the body buffer, or null when the cap is exceeded.
 */
function collectBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        // Stop buffering; keep the socket alive long enough for the 413
        // response (the settled flag ignores the remaining body).
        done(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', () => done(null))
  })
}
