# 文献管理系统（本地 Web）

本地运行的文献管理应用：导入 PDF、文献列表与笔记、基于正文的对话、单篇阅读报告与文献综述生成。数据与文件保存在本机，大模型通过 **OpenAI 兼容接口** 调用（需在设置中配置）。

## 功能概览

| 能力 | 说明 |
|------|------|
| **工作台** | 导入 PDF、选择文献、阅读正文、与单篇文献对话、生成本篇阅读报告（Markdown，保存至项目目录） |
| **报告中心** | 以卡片列出已保存的单篇阅读报告与文献综述，点击可预览；在此发起「生成文献综述」 |
| **设置** | 配置 API Base URL、API Key、模型、温度；可自定义「阅读报告」「文献综述」系统提示词 |

生成文件位置（相对项目根目录）：

- 单篇阅读报告：`reading_reports/*.md`
- 文献综述：`literature_reviews/*.md`
- 上传的 PDF：`backend/uploads/`
- 数据库（文献元数据、对话、设置）：`backend/data/app.db`

## 技术栈

- **前端**：React 18、TypeScript、Vite 6；开发端口 **18001**（固定，`strictPort`）
- **后端**：Python 3、FastAPI、Uvicorn；API 端口 **3001**
- **PDF 文本**：pypdf
- **大模型请求**：httpx 调用兼容 OpenAI 的 `chat/completions`

## 环境要求

- **Node.js** 18+（建议 LTS）
- **Python** 3.10+（需可执行 `python` 或 `py`）
- 可访问的大模型 **OpenAI 兼容 API**（含 Base URL 与 API Key）

## 安装

在项目根目录执行（会安装根目录依赖、前端依赖，并用 pip 安装后端依赖）：

```bash
npm run install:all
```

或分步安装：

```bash
npm install
npm install --prefix client
cd backend && python -m pip install -r requirements.txt
```

### 后端 Python 依赖（`backend/requirements.txt`）

- `fastapi`、`uvicorn[standard]`
- `httpx`、`pypdf`、`python-multipart`

## 启动（开发）

**推荐**：一条命令同时启动 API 与前端（需在**前台**运行以便查看日志）：

```bash
npm run dev
```

等价于并行执行：

- 后端：`python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 3001`（工作目录为 `backend`）
- 前端：`npm run dev`（工作目录为 `client`）

也可分别开两个终端：

```bash
# 终端 1 — 后端
npm run dev:api

# 终端 2 — 前端
npm run dev:client
```

启动成功后：

- 浏览器访问：**http://127.0.0.1:18001**
- API 地址：**http://127.0.0.1:3001**（前端通过 Vite 将 `/api` **代理**到该地址，一般无需单独打开）

若 **18001** 已被占用，Vite 会报错且**不会**自动换端口；请先释放该端口后再启动。后端端口 **3001** 若被占用，需在 `package.json` 的 `dev:api` 中调整，并同步修改 `client/vite.config.ts` 里 `proxy["/api"].target`。

### CORS（跨域）

默认仅允许本机前端地址访问 API：`http://127.0.0.1:18001`、`http://localhost:18001`，以及 `vite preview` 常用端口 `4173`。若需自定义（例如局域网调试另一台机器上的前端），可在启动后端前设置环境变量：

- `LITERATURE_API_CORS_ORIGINS`：逗号分隔的来源列表，例如 `http://192.168.1.10:18001,http://127.0.0.1:18001`
- 设为 `*` 可允许任意来源（**不推荐**在对外可达的服务上使用；此时不会携带凭证类 CORS 头）

### 健康检查

- `GET /api/health` 返回 `{"status":"ok"}`，用于简单探活。

### 前端类型检查

```bash
npm run typecheck
```

## 使用说明

1. **首次使用**  
   打开侧边栏 **「模型与提示词」**，填写：
   - **API Base URL**（需包含 `/v1`，例如 `https://api.openai.com/v1` 或自建兼容网关）
   - **API Key**
   - **模型名称**、**温度**  
   保存后即可在工作台对话与生成报告。

2. **导入文献**  
   在工作台工具栏点击 **「导入 PDF」**，选择文件。单文件大小上限约 **50 MB**（以服务端校验为准）。

3. **阅读与对话**  
   左侧选择文献，中间查看正文节选，右侧与当前文献进行多轮对话（记录会持久化）。

4. **单篇阅读报告**  
   在工作台右侧 **「本篇报告」** 生成报告；成功后会写入 `reading_reports/`，并可在 **报告中心** 上半区卡片中点击预览。

5. **文献综述**  
   在 **报告中心** 上半区点击 **「生成文献综述」**，输入领域或综述主题；系统会汇总 `reading_reports` 下已有报告并生成综述，保存到 `literature_reviews/`。下半区以卡片展示已生成的综述，点击可预览。

6. **预览**  
   报告与综述支持 Markdown 预览；界面中亦可下载为 `.md` 文件（若提供相关按钮）。

## 构建前端（生产静态资源）

```bash
npm run build
```

产物在 `client/dist/`。构建后的站点需通过 **同源或反向代理** 将 `/api` 转发到后端（例如 `http://127.0.0.1:3001`），否则需自行配置 `client` 内 API 基地址（当前开发配置为相对路径 `""`，依赖 Vite 代理）。

本地预览构建结果：

```bash
npm run preview
```

（默认端口以 Vite 输出为准；若与开发端口不同，请自行处理 `/api` 代理或环境变量。）

## 目录结构（简要）

```
文献管理系统/
├── client/                 # React + Vite 前端
├── backend/
│   ├── app/                # FastAPI 应用
│   ├── data/               # SQLite（运行时生成）
│   └── uploads/            # 上传的 PDF（运行时生成）
├── reading_reports/        # 单篇阅读报告 .md
├── literature_reviews/     # 文献综述 .md
├── package.json            # 根脚本与 concurrently
└── README.md
```

## 常见问题

- **对话或报告报错**  
  检查 Base URL 是否可访问、Key 是否有效、模型名是否与服务商一致；查看运行 `npm run dev` 的终端里后端报错信息。

- **端口被占用**  
  结束占用 **18001** 或 **3001** 的进程，或按上文修改配置并保持一致。

- **数据备份**  
  复制 `backend/data/app.db`、`backend/uploads/`、`reading_reports/`、`literature_reviews/` 即可大致备份文献与生成内容。

## 版权与许可证

Copyright © 2026 文献管理系统项目作者。保留所有权利。

本仓库若未单独附带 `LICENSE` 等开源许可文件，则**不**视为已授予任何明示或默示的开源许可；复制、修改、分发或用于商业用途前，请先取得作者书面授权。

**作者联系邮箱**：[2721061625@qq.com](mailto:2721061625@qq.com)

个人学习、研究及在授权范围内的本地使用，请遵守适用法律法规与第三方服务条款（例如大模型 API 提供方）。
