# Siren Records Cloudflare Worker

这是与 Vue/Tauri 应用隔离的最小 Cloudflare Workers API。它只解析塞壬唱片公开元数据；音频接口在校验 CID 和官网 CDN 域名后返回 `307`，不会读取、缓存或转发音频正文。

## 本地验证

在 `cross-platform` 目录执行：

```powershell
npx wrangler dev --config cloudflare-worker/wrangler.toml
```

验证 `http://127.0.0.1:8787/api/health`、`/api/catalog` 和 `/api/audio?id=<有效CID>`。`/api/audio` 应返回 `307` 且无正文。

## 部署

需要先登录 Cloudflare，并确认账号已选择免费 Workers 方案：

```powershell
npx wrangler login
npx wrangler deploy --config cloudflare-worker/wrangler.toml
```

当前已部署的 Worker 地址为 `https://siren-records-api.mxwf.workers.dev`。首次部署只会生成新的 `workers.dev` 地址，不会改变 GitHub Pages。确认路由、CORS、缓存和音频 307 均正常后，再将该地址设置为 GitHub Actions 的 `SIREN_API_BASE_URL`（或静态站点的 `VITE_API_BASE_URL`）并重新构建前端。

生产环境建议在 Cloudflare 控制台将 `ALLOWED_ORIGINS` 收窄为实际 GitHub Pages 域名，并为 Worker 配置平台级 WAF/Rate Limiting。Worker 内置的限流 Map 只在单个隔离实例内生效，免费方案不应把它当作全局限流。

## 数据流

```text
浏览器 → Worker /api/audio?id=CID（官网元数据）
        → 307 Location: 官方 hycdn.cn
浏览器 → 官方 CDN（音频正文，支持 Range）
```

目录和歌曲详情只返回前端使用的字段，并通过 Cloudflare Cache API 缓存；音频最新地址始终 `no-store`。Worker 没有音频流转发代码，也不依赖 Node.js、Buffer、ArrayBuffer 或 Blob。
