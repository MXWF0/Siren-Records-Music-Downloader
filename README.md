<div align="center">

# 🎵 Siren Records Music Downloader

**更方便的塞壬唱片无损音乐下载器**

[![最新版本](https://img.shields.io/github/v/release/MXWF0/Siren-Records-Music-Downloader?label=Latest)](https://github.com/MXWF0/Siren-Records-Music-Downloader/releases/latest)
[![License](https://img.shields.io/github/license/MXWF0/Siren-Records-Music-Downloader)](./LICENSE)
[![Web版](https://img.shields.io/badge/Web-在线体验-3ddc84)](https://mxwf0.github.io/Siren-Records-Music-Downloader/)

*一键下载塞壬唱片官网无损音质音乐，支持单曲、专辑及全量下载*

</div>

## 📖 简介

本项目是一款专为《明日方舟》塞壬唱片（Siren Records）开发的第三方音乐下载工具。可解析官网接口，批量获取并下载官方发布的无损音质（WAV）音乐资源，并自动匹配歌词与专辑封面。

## ✨ 核心特性

- **🎵 无损音质获取**：直接下载官网提供的 WAV 无损音源，并支持自定义输出格式（仅 WAV / WAV + FLAC / 仅 FLAC）。
- **📥 灵活下载模式**：支持单曲下载、整张专辑下载、以及 ALL一键打包下载。
- **🔍 智能搜索与分类**：支持关键词搜索，自带歌词与封面抓取；自动识别本地已下载歌曲，可按「已下载 / 未下载」智能分组折叠显示。
- **⚡ 强大的队列管理**：可视化下载队列面板，支持查看进度、取消单项任务、重试失败任务。
- **🖥️ 跨平台 Web 版**：提供基于浏览器运行的网页版本，免去安装，支持 Windows、macOS、Linux 甚至手机端访问。
- **⚙️ 稳定性优化**：自动处理网络代理兼容、请求超时回退、Windows 保留文件名冲突等边缘场景。

## 📸 软件截图

<!-- TODO: 请在仓库建立 assets 文件夹，将截图放进去，然后修改下方路径 -->
<div align="center">
  <img src="assets/home.png" width="45%" alt="主页" />
  <img src="assets/queue.png" width="45%" alt="下载队列" />
</div>

## 📦 下载与使用

### 1️⃣ Windows 桌面版（推荐）
Windows 用户建议优先使用当前最稳定的 v5.5 桌面版客户端。
👉 **[点击前往 Releases 下载 v5.5 桌面版](https://github.com/MXWF0/Siren-Records-Music-Downloader/releases/latest)**

### 2️⃣ Web 跨平台版（免安装）
支持 macOS、Linux 以及移动端用户，采用全新现代化 UI。复制下方链接到浏览器直接打开即可使用：
🌐 **[塞壬音乐下载器 Web 版在线体验](https://mxwf0.github.io/Siren-Records-Music-Downloader/)**

> **⚠️ 注意**：Web 版由于受限于浏览器环境，部分功能可能与桌面端有所差异。

## 🛠️ 技术栈
本项目采用以下技术构建：
`Vue` · `TypeScript` · `JavaScript` · `Rust` · `HTML` · `CSS`

---

<details>
<summary><h2>📝 更新日志 (Changelog)</h2></summary>

### v5.5
调整了下载目录、缓存目录和配置文件异常时的回退机制
调整了网络代理兼容性、请求超时处理和本地设置加载逻辑
修复设置并发保存、重复启动、重复队列、Windows 保留文件名等问题
修复了“打开下载目录”未正确处理返回的错误

### v5.4
新增下载队列面板，支持查看当前下载、待下载和失败任务，可取消单项任务及重试失败任务
调整设置页面，重新整理保存位置、音频输出、整理显示和缓存管理区域，新增音频输出格式选择：仅 WAV/ WAV + FLAC/ 仅 FLAC
调整了默认字体，确保不同用户设备上的字体显示一致，统一中英文字体自重
优化搜索区域、标题栏和列表布局
优化下载队列渲染和搜索动画，降低了整体的性能开销
修复了已知问题

### v5.3
修复了搜索已下载的歌曲时高亮显示未能正常显示的问题
修改了下载完成后歌曲插入“已下载”分组的原目录位置，不再追加到末尾

### v5.2
设置中新增“按已下载和未下载分类显示”，关闭后歌曲按接口原始时间顺序连续显示，不再分已下载/未下载组
移除了设置变更后的自动保存提示

### v5.1
清理了运行时不会加载的源码映射、浏览器端 Axios 构建、文档、示例、类型声明、测试依赖与打包开发依赖
修复了专辑下载队列的问题

### v5.0 (里程碑版)
优化了软件下载音乐的速度
软件内音乐按已下载或未下载折叠分类
可自动获取当前目录内已下载音乐
设置内选项可自动保存
调整了软件的UI表现
修复了一些已知问题
优化系统流畅度，提高系统稳定性
</details>

---

## ⚠️ 免责声明

1. 本项目仅供学习交流与技术研究使用，请在下载后 24 小时内删除。
2. 塞壬唱片（Siren Records）及相关音乐资源的版权归原作者及鹰角网络所有。
3. 请勿将本软件用于任何商业用途，因使用本软件引起的任何版权纠纷，本项目概不负责。
