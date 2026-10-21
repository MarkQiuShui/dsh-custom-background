/**
 * Host half of dsh-custom-background.
 *
 * The Loader row (`id: custom-background`, `name: dsh-custom-background`)
 * resolves this module on the Node side, which is also what lets the
 * client-module scan pick up the package's `dsh.client` declaration.
 *
 * Host-side jobs:
 *  1. Serve background images over HTTP so the browser half can reference one
 *     as `/dsh-custom-background/image/<file>` (the dsh web server otherwise
 *     only serves /api and /plugins/<id>/client.js, never plugin-owned assets).
 *  2. Accept local background image uploads: `POST /dsh-custom-background/upload`
 *     saves the raw body into `$DSH_HOME/custom-background/image` and answers
 *     the public URL. Uploads live outside the installed package on purpose: a
 *     desktop profile installs this plugin from a tarball into `node_modules`,
 *     so anything written next to this file is destroyed by the next
 *     `pnpm install` or plugin update.
 *  3. Declare the plugin's live Config so the Loader row becomes the
 *     `custom-background` settings namespace the browser half edits through
 *     `ctx.configForms.get('custom-background')`.
 *
 * The settings namespace of a plugin IS its Loader entry id, and the settings
 * service only projects fields marked `volatile` (`docs/subsystems/settings`);
 * there is no `ctx.settings.register()` API and a non-volatile Config field
 * never reaches a form or accepts a write. Writes land in the active profile's
 * patch document via the config editor, so the background survives a restart.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-custom-background'

/** Required services: the web route registry provided by dsh-web-app. */
export const inject = ['webServer']

/**
 * Live Config of the `custom-background` Loader row — the persisted settings
 * the browser half reads and writes. Every field is `volatile`, which is the
 * harness's requirement for a field to appear in and accept edits from a
 * settings form.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  image: Schema.string().default('').volatile(),
  color: Schema.string().default('#0e1116').volatile(),
  overlayAlpha: Schema.number().min(0).max(1).default(0.45).volatile(),
  panelAlpha: Schema.number().min(0).max(1).default(0.8).volatile(),
})

/** URL prefix the browser half uses for background images. */
const ROUTE_PREFIX = '/dsh-custom-background'

/** Exact route accepting local image uploads (POST). */
const UPLOAD_PATH = ROUTE_PREFIX + '/upload'

/** Path segments of the writable image directory below the Harness home. */
const IMAGE_SUBDIR = ['custom-background', 'image']

/** Absolute path of the package's own `image/` directory (read-only fallback). */
const PLUGIN_IMAGE_DIR = normalize(fileURLToPath(new URL('./image/', import.meta.url)))

/**
 * Absolute path of the writable image directory: `$DSH_HOME/custom-background/image`.
 *
 * Resolution order matches the harness's own `resolveDshHome()`: the Loader's
 * `dshHomePath` resolver (which honours a configured home), then `$DSH_HOME`,
 * then `~/.dsh`. Resolved per call rather than once at load so a test — or a
 * profile that changes its home mid-process — sees the current value.
 */
function imageDir(ctx) {
  let resolver
  try {
    resolver = ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function'
      ? ctx.get('dshHomePath')
      : undefined
  } catch {
    resolver = undefined
  }
  if (typeof resolver === 'function') return normalize(resolver(...IMAGE_SUBDIR))
  const configured = process.env.DSH_HOME
  const home = configured !== undefined && configured.trim() !== ''
    ? configured.trim()
    : join(homedir(), '.dsh')
  return normalize(join(home, ...IMAGE_SUBDIR))
}

/**
 * Image roots in lookup order: the writable home directory first, then the
 * package's bundled `image/`. The package root keeps wallpapers shipped with
 * the repo and every upload made by versions that still wrote into the package
 * readable after the move, so nothing has to be re-uploaded.
 */
function imageRoots(ctx) {
  const dir = imageDir(ctx)
  return dir === PLUGIN_IMAGE_DIR ? [dir] : [dir, PLUGIN_IMAGE_DIR]
}

/** Upload size cap: 8 MiB is plenty for a wallpaper. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

/**
 * Plugin body: register the image route, the upload route, and stand the
 * generic Config page down (the browser half owns 设置 → 自定义背景). Routes
 * ride effects on this fiber, so unload / HMR removes them.
 */
export function apply(ctx) {
  // The roots are resolved per request, not captured here: a profile can point
  // `dshHomePath` at another home while this fiber stays alive.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => serveImage(req, res, ctx),
  }), name + ': image route')

  // Exact route wins over the prefix (webserver matches exact first), so
  // /dsh-custom-background/upload never reaches serveImage.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: (req, res) => handleUpload(req, res, ctx),
  }), name + ': upload route')

  // The plugin ships its own settings section, so the settings provider must
  // not also auto-generate a page for this entry. `configure` is keyed by the
  // OWNER fiber, and a service reads `ctx` as its consumer's fiber — hence the
  // explicit `ctx.fiber`.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      name + ': settings page policy',
    )
  })
}

/**
 * Serve one background image: `/dsh-custom-background/image/<file>`.
 * GET/HEAD only; unknown extensions, path traversal, and missing files answer
 * 404. Directory escape is blocked by both the `..` guard and the resolved
 * prefix containment check. Each root is tried in turn, so an upload in the
 * home directory wins over a same-named file shipped inside the package.
 */
async function serveImage(req, res, ctx) {
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
  // Only files directly under an image root are served:
  // /dsh-custom-background/image/<file> → <file> resolved inside one root.
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
  for (const root of imageRoots(ctx)) {
    const target = resolveInside(root, relative)
    if (target === null) continue
    let body
    try {
      body = await readFile(target)
    } catch {
      // Missing here is the normal case for the fallback root — try the next.
      continue
    }
    res.writeHead(200, {
      'content-type': type,
      // Uploads keep their name across replacements, so a stale wallpaper must
      // not survive a reload behind a long-lived cache entry.
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  res.writeHead(404)
  res.end()
}

/**
 * Resolve `relative` inside `root` and return the absolute path, or null when
 * it escapes the directory. Containment is checked on the resolved path, so
 * both `..` segments and absolute lookalikes are refused.
 */
function resolveInside(root, relative) {
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root
  const target = normalize(join(root, relative))
  if (target === base || !target.startsWith(base + sep)) return null
  return target
}

/**
 * Accept one local background image: `POST /dsh-custom-background/upload?name=<file>`.
 * The body is the raw file bytes; the original filename only supplies the
 * extension — storage names are sanitized and collision-safe, so the client
 * can never write outside the writable image directory or overwrite an
 * existing file. Answers JSON
 * `{ "url": "/dsh-custom-background/image/<stored>" }`.
 */
async function handleUpload(req, res, ctx) {
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

  const dir = imageDir(ctx)
  let target = resolveInside(dir, stored)
  if (target === null) {
    fail(400, 'invalid filename')
    return
  }
  // Collision-safe: never overwrite an existing file. Both roots are checked,
  // because a write to the home directory would otherwise shadow a same-named
  // image that ships inside the package.
  const taken = (name) => imageRoots(ctx).some((root) => {
    const candidate = resolveInside(root, name)
    return candidate !== null && existsSync(candidate)
  })
  if (taken(stored)) {
    stored = Date.now() + '-' + stored
    target = resolveInside(dir, stored)
    if (target === null) {
      fail(400, 'invalid filename')
      return
    }
  }
  try {
    // The home directory is created on demand: a first upload on a fresh
    // install must not fail because $DSH_HOME/custom-background is absent.
    await mkdir(dir, { recursive: true })
    await writeFile(target, body, { flag: 'wx' })
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      // Lost a race with another upload of the same name — retry once with a
      // timestamp prefix instead of failing the caller.
      stored = Date.now() + '-' + stored
      const retry = resolveInside(dir, stored)
      if (retry === null) {
        fail(400, 'invalid filename')
        return
      }
      target = retry
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
