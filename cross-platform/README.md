# 塞壬唱片下载器跨平台版

这是与原 Electron 版完全隔离的新项目，当前版本为 v1.1。它使用 Vue 3、TypeScript 和 Tauri 2，提供音乐库、官网目录、搜索定位、已下载分类、下载队列、歌曲详情和关于页。

下载队列支持待下载、下载中、失败、完成、单项取消、失败重试、队列去重、实时进度、速度和剩余时间。音乐库底部固定显示当前下载状态，整理与显示选项放在关于页。网页端使用浏览器默认下载目录；桌面端自动使用系统 Downloads 目录，不再显示无效的目录和音频格式设置。

桌面端固定输出标准 WAV。官网的 MP3、WAV、FLAC 源由内置 Rust 音频解码器转换，不依赖系统 FFmpeg，因此 Windows、macOS 和 Linux 使用同一套下载逻辑。歌词会作为同名 `.lrc` 文件保存，异常下载会清理临时文件并支持恢复。

## 环境要求

- Node.js 20 或更高版本
- Rust stable 工具链
- 对应平台的 Tauri 系统依赖

Windows 需要 Microsoft C++ Build Tools 和 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要 WebKitGTK 等发行版依赖。

## 桌面端运行与构建

```powershell
npm install
npm run tauri dev
```

Windows 构建：

```powershell
npm run bundle:windows
```

macOS 和 Linux 应在对应系统上构建，也可以使用 `.github/workflows/desktop-bundles.yml` 通过 GitHub Actions 生成对应分发包。正式发布时请分发 Tauri 生成的安装包或应用文件，不要直接分发 `index.html`。

## 浏览器预览

```powershell
npm run web
```

终端会显示 `http://127.0.0.1:4173`。本地网页服务会将官网目录和音频请求转为同源请求，并在每次下载时刷新官网音频地址；浏览器下载位置由浏览器自身设置决定。直接双击 `dist/index.html` 时，页面会自动探测 `127.0.0.1:4173`；如果本地代理未运行，只能浏览内置目录快照，下载会提示需要代理，而不会跳转到 CDN 错误页。

## 长期网页部署

官网音频 URL 带有短时效签名，浏览器不能直接调用官网接口刷新它。项目内置了可部署的 Serverless 代理，`api/catalog.mjs` 和 `api/audio/[id].mjs` 可直接部署到 Vercel：

仓库根目录现已提供 `.github/workflows/cross-platform-web-pages.yml`。推送到 GitHub 后，在仓库 Settings → Pages 中将 Source 设为 GitHub Actions，工作流会立即发布网页，并每四小时刷新全部官网音频签名。默认网址为：

```text
https://mxwf0.github.io/Siren-Records-Music-Downloader/
```

该网页可以直接分享给其他电脑使用，不需要对方运行代理。定时构建只有在全部歌曲签名刷新成功时才会部署，避免用失败构建覆盖仍可使用的站点。

```powershell
npm install
npm run build
npx vercel deploy --prod
```

Vercel 部署时必须选择 `cross-platform` 项目根目录，不能只上传 `dist` 文件夹；这样 Vercel 才会同时托管 `dist` 静态页面和 `/api` 函数。打开部署后的站点即可长期使用，不需要用户运行 Node 程序。若静态页面部署在其他平台，在构建时设置 `VITE_API_BASE_URL` 为代理站点根地址（例如 `https://your-siren-proxy.example`），页面会通过该地址获取实时目录和音频；也可以直接在生成的 `dist/index.html` 内修改 `window.__SIREN_API_BASE__`，无需重新构建。示例见 `.env.example`。仅分发一个没有代理地址的 `index.html` 无法绕过官网 CORS 和签名机制，因此只能作为离线目录预览。

音频函数使用流式转发，不把整首音频读入代理内存；浏览器端仍会显示下载进度、速度和官网生成的文件名。

部署完成后应先打开 `https://你的域名/api/catalog`。如果返回包含 `albums` 和 `songs` 的 JSON，说明官网代理正常；再打开 `https://你的域名/api/audio?id=779442`，浏览器应开始下载音频。如果这两个地址返回网页正文或 404，说明部署时只上传了 `dist`，需要重新从 `cross-platform` 根目录部署。

也可以在支持 Docker 的服务器上部署完整网页服务：

```powershell
docker build -t siren-records-web .
docker run -d --name siren-records-web -p 4173:4173 siren-records-web
```

其他电脑访问服务器的 `http://服务器地址:4173` 即可使用。不能把单独的 `index.html` 当作完整下载程序分发；纯静态文件没有能力刷新官网签名。

在 Render、Railway 等 Node 托管平台上，将构建命令设为 `npm ci && npm run build`，启动命令设为 `npm start`。服务会自动读取平台提供的 `PORT` 并监听 `0.0.0.0`，部署完成后直接分享站点网址即可。

## 检查

```powershell
npm test
npm run build
```

原版 Electron 目录不在本项目构建范围内，所有跨平台代码和产物都位于 `cross-platform` 文件夹。
