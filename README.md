# GFX 照片库 · Fujifilm GFX100S 本地照片管理器

纯本地运行的照片管理工具：扫描 Mac 本地照片目录 → 提取 EXIF → 生成缩略图与索引 → 在浏览器里按多维度分类管理与快速查找。
**不会修改、移动或删除任何原始照片文件**，标签/评分/收藏全部存在独立的 `data/userdata.json`。

---

## 快速开始

```bash
cd gfx-photo-manager

# 1) 先用内置演示库体验（可选，生成 72 张模拟照片）
npm run demo          # 自动生成演示库 + 启动服务

# 2) 换成你自己的照片
#    编辑 config.json，把 roots 改成你的照片目录：
#    "roots": ["/Users/你的用户名/Pictures/GFX"]
npm run scan          # 扫描并建立索引（增量，重复执行很快）
npm run serve         # 启动服务
```

浏览器打开 **http://127.0.0.1:5173**

> 首次使用需先 `npm install`（依赖 `exifr` + `sharp`，安装约 2 分钟）。

---

## 功能

### 浏览
- 自适应网格 + **虚拟滚动**，上万张照片也不卡（只渲染可视区域）
- 缩略图懒加载，卡片上直接显示 RAW 标识、胶片模拟、拍摄参数、星级
- 灯箱大图预览，支持键盘 `←/→` 翻页、`0–5` 打分、`F` 收藏、`I` 切信息面板
- 底部胶片条快速跳转
- 一键「在 Finder 中显示」「用默认程序打开原图」

### 分类（4 大维度，全部支持多选 + 分面计数）
| 维度 | 说明 |
|---|---|
| **自定义标签** | 任意打标签，支持「任一 / 同时满足」两种匹配模式，有全局标签库与快捷建议 |
| **GFX 专属 EXIF** | 胶片模拟、镜头型号、机身、ISO 区间、光圈区间、动态范围 |
| **收藏 + 星级** | 0–5 星评分、收藏夹，可按「≥N 星」筛选 |
| **时间 / 地点** | 按年月自动分组时间线；GPS 坐标自动匹配到城市（内置 45 个常用城市），无 GPS 也能单独筛选 |

### 查找
- 顶部全局搜索：文件名、标签、镜头、备注、地名全字段匹配
- 多条件叠加，每个筛选条件生成可单独移除的 chip
- 8 种排序：时间、文件名、评分、ISO、焦距

### 批量
- 多选模式下：批量打标签、批量评分、批量加入/取消收藏
- `Cmd/Ctrl+A` 全选当前筛选结果

---

## 关于 GFX100S 的几个细节

- **RAW + JPEG 配对**：同目录同名的 `.RAF` 与 `.JPG` 会自动识别为同一张照片，不会重复计数。
- **缩略图来源**：优先用配套 JPEG；只有 RAW 时，从 RAF 内嵌预览图提取（浏览器无法直接解码 RAF）。
- **灯箱大图**：只加载 JPEG 原图；纯 RAW 照片自动降级到缩略图预览。
- **胶片模拟**：读自 Fujifilm MakerNotes。映射表在 `scripts/lib/config.mjs` 的 `FILM_MODE_MAP`。

### ⚠️ 建议：第一次扫描真实照片前先校准胶片模拟

Fujifilm 的胶片模拟编码没有公开标准，不同固件可能有差异。拿一张你自己的 GFX 照片跑一下：

```bash
npm run probe /path/to/你的照片.RAF
```

如果输出里 `filmMode` 显示为 `未知胶片模拟 (n)`，把 `n` 对应的实际名称补进
`scripts/lib/config.mjs` 的 `FILM_MODE_MAP`，重新 `npm run scan -- --force` 即可。

---

## 命令

| 命令 | 作用 |
|---|---|
| `npm run scan` | 扫描照片目录，增量更新索引和缩略图 |
| `npm run scan -- --force` | 强制重建全部索引和缩略图 |
| `npm run scan -- --limit 50` | 只处理前 50 张（快速试跑） |
| `npm run serve` | 启动本地服务（默认 127.0.0.1:5173） |
| `npm run probe <文件>` | 探测单个文件的 EXIF，用于校准胶片模拟映射 |
| `npm run mock` | 生成演示照片库并把 config 切到演示库 |
| `npm run smoke` | 跑前端冒烟测试（需服务已启动） |

服务端口可用环境变量覆盖：`PORT=8080 npm run serve`

### 常驻运行（推荐）

手动 `npm run serve` 启动的进程会随终端会话结束而退出。项目已附带 launchd 配置，注册后服务会**开机自动拉起、崩溃自动重启**：

```bash
# 首次安装（只需一次）
cp scripts/com.gfx.photo-manager.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.gfx.photo-manager.plist

# 常用管理命令
launchctl list | grep gfx              # 查看状态（第一列为 PID）
launchctl kickstart -k gui/$(id -u)/com.gfx.photo-manager   # 重启
launchctl unload ~/Library/LaunchAgents/com.gfx.photo-manager.plist  # 停止并卸载
```

日志位于 `/tmp/gfx-photo-manager.log` 和 `/tmp/gfx-photo-manager.err.log`。

若端口 5173 被占用导致启动失败，服务会明确报 `EADDRINUSE`，执行 `lsof -ti tcp:5173 | xargs kill` 释放即可。

---

## 目录结构

```
gfx-photo-manager/
├── config.json              # 照片目录等配置
├── data/
│   ├── photos.json          # 照片索引（由 scan 生成）
│   └── userdata.json        # 标签/评分/收藏/备注（由页面写入）
├── public/
│   ├── index.html           # 前端页面
│   ├── app.js               # 前端逻辑（零依赖原生 JS）
│   ├── styles.css           # 样式（支持深浅色）
│   └── thumbs/              # 缩略图缓存
├── scripts/
│   ├── scan.mjs             # 扫描 + EXIF 提取 + 缩略图生成
│   ├── serve.mjs            # 本地服务 + 元数据写回 API
│   ├── mock.mjs             # 演示库生成
│   ├── probe.mjs            # EXIF 探测器
│   ├── smoke.mjs            # 前端冒烟测试
│   └── lib/                 # 配置与 EXIF 解析
└── mock-library/            # 演示照片（npm run mock 生成）
```

---

## 技术说明

- **后端**：Node.js + 原生 `http`，无框架。仅监听 `127.0.0.1`，不对外暴露。
- **EXIF**：`exifr`（纯 JS，无需安装 exiftool）
- **缩略图**：`sharp`（libvips），640px 宽 JPEG
- **前端**：零依赖原生 JS，无构建步骤，改完刷新即生效
- **安全**：
  - 原图读取接口 `/api/file` 只服务索引内已收录的 `.jpg/.jpeg`，路径穿越攻击返回 403
  - 照片 ID 严格校验为 16 位十六进制
  - 用户数据原子写入（临时文件 + rename），不会写坏 JSON
  - 所有用户输入经 HTML 转义，防 XSS

## 已知限制

- 只监听本机回环地址，手机/其他设备无法访问（如需局域网访问，设置 `HOST=0.0.0.0`）
- 浏览器无法直接预览 RAF，纯 RAW 照片只能看缩略图
- 索引是快照式的：照片目录有增删后需重新 `npm run scan` 才会反映到页面
- macOS 系统照片库（`Photos Library.photoslibrary`）默认被排除，如需管理其中照片请先导出
