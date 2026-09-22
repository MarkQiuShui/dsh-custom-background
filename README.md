# dsh-custom-background

DeepSeek Harness Web GUI 自定义背景插件。安装后设置页会出现一个与"通用设置 / 插件"**同级的顶级菜单**：**设置 → 自定义背景**，可配置启用开关、背景图（**支持本地图片上传**或 URL）、底色、覆盖层透明度、面板透明度；改动**实时生效**（写入 Host 设置文档 `$DSH_HOME/settings.yaml`）。

- 纯浏览器侧客户端插件 + 极小的 Node 半侧（图片静态路由 + 本地上传 + 设置命名空间），无需构建步骤（bundle 为手写的 `window.__ModuleLoader__.load` 格式，与内置插件的 `lib/client.js` 产物同格式）。
- 样式通过 `ctx.effect` 注入插件自有的 `<style>`，卸载 / HMR 时自动移除；设置一变即重新生成样式，无需重启。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | `dsh.client`（让 client-modules 发现浏览器 half）+ `dsh.bundle`（让 `dsh plugin add` 安装）+ 发布元信息 |
| `index.js` | Node 半侧：`custom-background` 设置命名空间 + `/dsh-custom-background/image/*` 静态路由 + `POST /upload` 本地上传路由 |
| `client.js` | 浏览器 half：顶级设置菜单（`settings.section` 槽）+ 响应式背景样式 + 上传流程 |
| `cordis.patch.yml` | 安装时插入 `custom-background` 插件行 |
| `test/smoke.mjs` | 冒烟测试（Host 路由 + 浏览器注册/上传/样式），CI 执行 |
| `.github/workflows/ci.yml` | 语法检查 + 冒烟测试 |
| `LICENSE` | MIT 许可 |
| `.gitignore` | 忽略 node_modules 与私人图片 `image/` |

## 安装

### 从 GitHub 安装（推荐）

本插件是纯 JS、无构建步骤，git 安装后无需 `allowBuilds` 授权即可加载：

```sh
dsh plugin --profile web add github:MarkQiuShui/dsh-custom-background
```

### 本地开发安装

在仓库根目录（本文档所在项目）：

```sh
pnpm dsh plugin --profile web add ./dsh-custom-background
```

> 新插件进入组合需要**重启 dsh 进程**（client-modules 的包元数据按名称缓存，插件集合变化在重启后生效）。重启后刷新页面，设置页左侧会出现"自定义背景"菜单（位于 通用设置 与 插件 之间）。

## 使用

### 设置字段

| 字段 | 说明 |
| --- | --- |
| 启用自定义背景 | 关闭后恢复应用默认背景 |
| 背景图 URL | 留空 = 纯色背景 |
| 本地添加图片 | 从本机选择图片上传到插件 `image/` 目录，成功后自动填入 URL |
| 底色 | 页面背景的最底层颜色。未设置图片时它就是背景主体色（被覆盖层压暗后显示）；图片加载失败/加载中/有透明区域时它是兜底色；面板半透明时它决定"透出来的那层"的颜色基调 |
| 覆盖层透明度 | 压在图片之上的深色遮罩（0–100%），保证文字对比度 |
| 面板透明度 | **只影响两块"墙"**：主内容区地基与侧栏。取值越高字迹越清晰（≥90% 时几乎等同实色）；菜单、弹窗、卡片、输入框、代码块等浮动/承载文字的表面始终使用主题原实色，不受该值影响 |

### 本地上传

点击"本地添加图片"选择文件即可（支持 `jpg/jpeg/png/gif/webp/svg`，上限 8 MiB）。上传通过 `POST /dsh-custom-background/upload` 完成，文件名会被净化、冲突时自动加时间戳，不会覆盖已有文件。

也可以手动把图片放进插件的 `image/` 目录，URL 填 `/dsh-custom-background/image/<文件名>`（新增/替换图片无需重启，刷新页面即可）。注意：`image/` 目录已在 `.gitignore` 中忽略，不会随仓库发布（上传功能会在首次上传时自动创建该目录）。

"恢复默认"按钮会把所有字段清回默认值（重新继承 schema 默认）。

## 卸载

```sh
pnpm dsh plugin --profile web remove dsh-custom-background
```

## 说明与限制

- 设置命名空间 `custom-background` 的 schema 是手写的最小实现（callable + `toJSON`），不依赖 `@deepseek-ai/dsh-settings` / `@deepseek-ai/schemastery`——从本插件目录解析不到这些包。客户端绑定 scope 时传入 `decode`，跳过 schema 反序列化。
- 覆盖的是 `body` 背景（图/遮罩/底色）与**两个框架表面** token：`--dsw-alias-bg-base`（主内容区地基）与 `--dsw-specific-sidebar-fill`（侧栏），并只用主题自身的静态色阶（`--dsw-static-neutral-bluish-*`）按面板透明度混合，明暗主题各取各的色调。
- 其余表面 token 一律保持主题原值，这是刻意的可读性边界：`--dsw-specific-menu`（浮层菜单，如「本轮用量」）、`--dsw-alias-bg-layer-2`（模态/浮窗/胶囊）、`--dsw-alias-bg-layer-3`（同时被当作**反白文字颜色**）、`--dsw-alias-bg-module-platform`（设置行/标签/输入行）、`--dsw-alias-bg-overlay`（叠加提亮层）若被改成半透明，会出现"弹层里的文字和下层正文叠在一起"以及"实心色块上的文字发灰发虚"。
- 两个框架表面的声明带 `!important`：主题样式表在同一个元素上声明同名 token，且主题切换时 presenter 会写行内变量，插件不能依赖样式表加载顺序。
- 由此带来一个预期内的取舍：设置抽屉（`--dsw-alias-bg-layer-2`）等模态表面不再透出背景图，换来的是这些面承载的文字保持原对比度。
- 上传校验为扩展名白名单 + 8 MiB 上限 + 文件名净化/防穿越，适合本机个人使用；生产环境如需更严格校验请自行扩展。
- 远程浏览器（非 loopback）下设置只读：控件会禁用，改动仅本次会话内生效（dsh 的设置 RPC 仅限本机）。
- 第三方插件会在你的机器上执行代码：只安装源码可信的插件，并可用 `github:作者/仓库#commit` 锁定版本。
