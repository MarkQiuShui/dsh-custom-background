/**
 * Browser half of dsh-custom-background.
 *
 * Hand-written bundle in the exact format the client module system expects
 * (see packages/client/ui-theme/lib/client.js for the same shape):
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The factory runs once at materialization and returns the plugin exports
 * (name + inject + apply). apply():
 *  1. binds the `custom-background` settings scope,
 *  2. registers a TOP-LEVEL Settings section (设置 → 自定义背景, same nav
 *     level as 通用设置 / 插件) into the `settings.section` list slot,
 *  3. injects a plugin-owned <style> that re-renders whenever the settings
 *     change (live, no restart needed for value changes),
 *  4. uploads local images through `POST /dsh-custom-background/upload` and
 *     stores the returned URL in the `image` field.
 *
 * Only seed modules are required (react); no cross-plugin value imports, which
 * keeps the bundle inside the purity gate.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-background',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const { createElement: h } = require('react')

    const PLUGIN_ID = 'dsh-custom-background'
    const NS = 'custom-background'
    const LOCALE_NS = 'settings.customBackground'
    const UPLOAD_URL = '/dsh-custom-background/upload'

    /** Defaults mirroring the Host schema (used until the scope is ready). */
    const DEFAULTS = Object.freeze({
      enabled: true,
      image: '',
      color: '#0e1116',
      overlayAlpha: 0.45,
      panelAlpha: 0.8,
    })

    const clamp = (value) => Math.min(1, Math.max(0, value))

    /** Coerce any section into the five-field shape (same rules as the Host). */
    function normalize(value) {
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

    const DICTS = {
      zh: {
        nav: '自定义背景',
        title: '自定义背景',
        enabled: '启用自定义背景',
        image: '背景图 URL（留空 = 纯色）',
        upload: '本地添加图片',
        uploading: '上传中…',
        uploadOk: '已上传',
        uploadError: '上传失败，请重试',
        color: '底色',
        overlay: '覆盖层透明度',
        panel: '面板透明度',
        reset: '恢复默认',
        hint: '也可以把图片放入插件 image/ 目录，URL 填 /dsh-custom-background/image/文件名',
        readOnly: '当前连接为只读，改动仅在本次会话内生效',
      },
      en: {
        nav: 'Custom Background',
        title: 'Custom Background',
        enabled: 'Enable custom background',
        image: 'Background image URL (empty = solid color)',
        upload: 'Upload a local image',
        uploading: 'Uploading…',
        uploadOk: 'Uploaded',
        uploadError: 'Upload failed, please retry',
        color: 'Base color',
        overlay: 'Overlay opacity',
        panel: 'Panel opacity',
        reset: 'Reset to defaults',
        hint: 'Alternatively drop images into the plugin image/ folder and use /dsh-custom-background/image/<file>',
        readOnly: 'This connection is read-only; changes apply for this session only',
      },
    }

    exports.name = 'custom-background'

    /** Required services (same set ui-theme uses for settings rows). */
    exports.inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

    exports.apply = (ctx) => {
      if (typeof document === 'undefined') return

      ctx.effect(() => ctx.locale.register(LOCALE_NS, DICTS), PLUGIN_ID + ': settings dictionaries')
      const t = ctx.locale.bind(LOCALE_NS)

      const scope = ctx.settingsScope.bind({ namespace: NS, decode: (value) => value })

      // ── observable over the resolved background settings + upload status ──
      // The section (hooks seat), the stylesheet, and the upload flow all
      // share this snapshot.
      let uploadStatus = 'idle' // 'idle' | 'uploading' | 'ok' | 'error'
      let snapshot = Object.freeze({
        value: Object.freeze({ ...DEFAULTS }),
        revision: -1,
        writable: false,
        uploadStatus,
      })
      const listeners = new Set()
      const observable = {
        getSnapshot: () => snapshot,
        subscribe: (fn) => {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
      const emit = () => {
        for (const fn of [...listeners]) fn()
      }
      const publishStatus = () => {
        // Rebuild the snapshot so uploadStatus changes reach subscribers
        // without waiting for the next scope round trip.
        snapshot = Object.freeze({
          value: snapshot.value,
          revision: snapshot.revision,
          writable: snapshot.writable,
          uploadStatus,
        })
        emit()
      }
      const derive = () => {
        const s = scope.getSnapshot()
        const status = uploadStatus
        if (s.status === 'ready' && s.value !== undefined && s.value !== null) {
          snapshot = Object.freeze({
            value: Object.freeze(normalize(s.value)),
            revision: s.revision ?? -1,
            writable: s.writable === true,
            uploadStatus: status,
          })
        } else {
          snapshot = Object.freeze({
            value: Object.freeze({ ...DEFAULTS }),
            revision: -1,
            writable: s.writable === true,
            uploadStatus: status,
          })
        }
        emit()
      }
      ctx.effect(() => scope.subscribe(derive), PLUGIN_ID + ': settings subscription')
      derive()

      // ── live background stylesheet ───────────────────────────────────
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.dataset.pluginCss = PLUGIN_ID + '/background.css'
        document.head.appendChild(style)
        const update = () => { style.textContent = buildCss(snapshot.value) }
        const off = observable.subscribe(update)
        update()
        return () => {
          off()
          style.remove()
        }
      }, PLUGIN_ID + ': background stylesheet')

      // ── settings actions ─────────────────────────────────────────────
      const setField = (field, value) => { void scope.set(field, value) }
      const reset = () => {
        void scope.unset('enabled')
        void scope.unset('image')
        void scope.unset('color')
        void scope.unset('overlayAlpha')
        void scope.unset('panelAlpha')
      }
      const uploadImage = async (file) => {
        if (!file) return
        uploadStatus = 'uploading'
        publishStatus()
        try {
          const response = await fetch(UPLOAD_URL + '?name=' + encodeURIComponent(file.name), {
            method: 'POST',
            body: file,
            headers: { 'content-type': file.type || 'application/octet-stream' },
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || typeof data.url !== 'string') {
            throw new Error(data.error || 'HTTP ' + response.status)
          }
          uploadStatus = 'ok'
          publishStatus()
          await scope.set('image', data.url)
        } catch (_uploadFailure) {
          uploadStatus = 'error'
          publishStatus()
        }
      }

      // ── top-level settings section (设置 → 自定义背景) ─────────────────
      // Same nav level as 通用设置 (order 0) and 插件 (order 15).
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'custom-background',
        order: 5,
        label: () => t('nav'),
        locale: LOCALE_NS,
        inject: () => ({ hooks: { background: observable }, setField, reset, uploadImage }),
      }, BackgroundSection))
    }

    /**
     * The settings section page. Everything arrives through props: the
     * renderer binds `useBackground` from the hooks seat, plus the injected
     * actions and the locale `t` seat. Plain React.createElement — no JSX,
     * no CSS modules.
     */
    function BackgroundSection(props) {
      const { useBackground, setField, reset, uploadImage, t } = props
      const state = useBackground((s) => s)
      const cfg = state.value
      const readOnly = !state.writable
      const status = state.uploadStatus
      const statusText = status === 'uploading' ? t('uploading')
        : status === 'ok' ? t('uploadOk')
          : status === 'error' ? t('uploadError')
            : ''

      return h('div', { style: s.card },
        h('div', { style: s.title }, t('title')),
        h('label', { style: s.row },
          h('input', {
            type: 'checkbox',
            checked: cfg.enabled,
            disabled: readOnly,
            onChange: (e) => { setField('enabled', e.target.checked) },
          }),
          ' ',
          t('enabled'),
        ),
        h('label', { style: s.row },
          t('image'),
          h('input', {
            type: 'text',
            style: s.input,
            defaultValue: cfg.image,
            disabled: readOnly,
            onBlur: (e) => { setField('image', e.target.value.trim()) },
          }),
        ),
        h('label', { style: s.row },
          t('upload'),
          h('input', {
            type: 'file',
            accept: 'image/jpeg,image/png,image/gif,image/webp,image/svg+xml',
            disabled: readOnly || status === 'uploading',
            onChange: (e) => {
              const file = e.target.files && e.target.files[0]
              e.target.value = '' // allow re-selecting the same file
              if (file) void uploadImage(file)
            },
          }),
          statusText === '' ? null : h('span', { style: s.status }, statusText),
        ),
        h('label', { style: s.row },
          t('color'),
          h('input', {
            type: 'color',
            defaultValue: cfg.color,
            disabled: readOnly,
            onBlur: (e) => { setField('color', e.target.value) },
          }),
        ),
        h('label', { style: s.row },
          t('overlay'),
          h('input', {
            type: 'range',
            min: 0,
            max: 100,
            value: Math.round(cfg.overlayAlpha * 100),
            disabled: readOnly,
            onChange: (e) => { setField('overlayAlpha', Number(e.target.value) / 100) },
          }),
          ' ',
          Math.round(cfg.overlayAlpha * 100) + '%',
        ),
        h('label', { style: s.row },
          t('panel'),
          h('input', {
            type: 'range',
            min: 0,
            max: 100,
            value: Math.round(cfg.panelAlpha * 100),
            disabled: readOnly,
            onChange: (e) => { setField('panelAlpha', Number(e.target.value) / 100) },
          }),
          ' ',
          Math.round(cfg.panelAlpha * 100) + '%',
        ),
        h('div', { style: s.row },
          h('button', {
            type: 'button',
            disabled: readOnly,
            onClick: reset,
          }, t('reset')),
        ),
        h('div', { style: s.hint }, readOnly ? t('readOnly') : t('hint')),
      )
    }

    /** Inline section styles (kept minimal; the host app theme applies around it). */
    const s = {
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px 0' },
      title: { fontSize: '14px', fontWeight: 600 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', flexWrap: 'wrap' },
      input: { flex: 1, minWidth: 0, padding: '4px 6px', fontSize: '13px' },
      status: { fontSize: '12px', opacity: 0.8 },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
    }

    /** Escape a value for use inside a quoted CSS string (url("...")). */
    function cssString(value) {
      return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\a ')
    }

    /**
     * The frame surfaces this plugin is allowed to tint, as
     * [token, light-palette tone, dark-palette tone].
     *
     * Deliberately only these two: they are the two "walls" (the conversation
     * floor and the sidebar) and no text is painted on them directly.
     * Every other surface token keeps the theme's opaque value, because those
     * tokens also back floating menus, popovers, modals, dock panels, cards,
     * inputs and code-block banners — and `--dsw-alias-bg-layer-3` is even
     * consumed as an inverted *text* color — so tinting them either shows the
     * page through a floating surface (two texts stacked on each other, e.g.
     * the 本轮用量 popover) or washes out solid-tone labels.
     */
    const FRAME_SURFACES = Object.freeze([
      ['--dsw-alias-bg-base', 'bluish-00', 'bluish-950'],
      ['--dsw-specific-sidebar-fill', 'bluish-50', 'bluish-900'],
    ])

    /**
     * One frame surface at `percent` alpha, mixed from the theme's own static
     * palette so each scheme keeps its real tone instead of a literal
     * near-white / near-black guess (which also flattened the surface ladder).
     * `!important` because the theme sheets declare the same tokens on the same
     * element (and the theme presenter writes them inline): the plugin's two
     * walls must not depend on stylesheet arrival order.
     */
    const surfaceDecl = (surface, mode, percent) => {
      const [token, light, dark] = surface
      const tone = mode === 'dark' ? dark : light
      return '  ' + token + ': color-mix(in srgb, var(--dsw-static-neutral-'
        + tone + ') ' + percent + '%, transparent) !important;'
    }

    /**
     * Compose the background stylesheet from the resolved settings:
     *  - body: the background image (optional) plus the readability overlay
     *    and the base color;
     *  - body / body[data-ds-dark-theme]: the two frame surfaces at the panel
     *    alpha, declared where ui-theme's design-platform.css declares its
     *    tokens, so the image shows through the walls while every floating
     *    surface and text-bearing card stays opaque and legible.
     * Disabled → empty stylesheet (the host app's own background wins).
     */
    function buildCss(cfg) {
      if (!cfg.enabled) return ''
      const overlay = 'rgba(8, 10, 14, ' + cfg.overlayAlpha + ')'
      const percent = Math.round(clamp(cfg.panelAlpha) * 100)
      const imageLayer = cfg.image
        ? 'linear-gradient(' + overlay + ', ' + overlay + '), url("' + cssString(cfg.image) + '")'
        : 'linear-gradient(' + overlay + ', ' + overlay + ')'
      const surfaces = (mode) => FRAME_SURFACES
        .map((surface) => surfaceDecl(surface, mode, percent))
        .join('\n')
      return [
        'body {',
        '  background-color: ' + cfg.color + ' !important;',
        '  background-image: ' + imageLayer + ' !important;',
        '  background-size: cover !important;',
        '  background-position: center !important;',
        '  background-repeat: no-repeat !important;',
        '  background-attachment: fixed !important;',
        surfaces('light'),
        '}',
        'body[data-ds-dark-theme] {',
        surfaces('dark'),
        '}',
      ].join('\n')
    }

    return module.exports
  },
})
