from __future__ import annotations

import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel

from .db import get_setting, init_db, row_to_dict, session, set_setting
from .paths import LITERATURE_REVIEWS_DIR, REPORTS_DIR, UPLOADS_DIR
from .pdf_extract import extract_pdf_text

MAX_PAPER_CHARS = 80000  # 增加字符限制以支持更长的文献内容
MAX_REPORT_PAPER_CHARS = 30000
MAX_REPORT_CHAT_CHARS = 16000
MAX_UPLOAD = 50 * 1024 * 1024

DEFAULT_REPORT_SYSTEM_PROMPT = (
    "你是学术文献阅读助手。请根据用户消息中提供的「文献正文节选」与「阅读对话记录」，"
    "用中文撰写一份结构化阅读报告，使用 Markdown（#、## 标题，可加列表）。\n"
    "报告应覆盖：文献概况与核心摘要；方法/数据/实验要点（若文献中有）；主要结论与创新点；"
    "对话中已讨论过的问题归纳；不足、局限与阅读建议。\n"
    "严格依据文献与对话，不要编造引用；信息不足处请明确说明。不要输出外层 ```markdown 代码围栏。"
)

DEFAULT_CHAT_SYSTEM_PROMPT = (
    "你是学术文献助手。请根据下方提供的「文献正文」回答用户问题。\n"
    "你的能力包括：回答正文内容、总结摘要、翻译（全文或段落）、分析方法与结论等。\n"
    "若用户要求翻译，请根据上下文提供准确的学术翻译。若文中没有相关依据，请明确说明，不要编造内容。"
)

DEFAULT_LITERATURE_REVIEW_SYSTEM_PROMPT = (
    "你是学术写作助手。请根据用户提供的「多篇文献阅读报告」合集，围绕用户指定的领域或综述主题，"
    "用中文撰写一份文献综述，使用 Markdown（#、## 标题，可加列表与表格）。\n"
    "综述应覆盖：研究背景与问题域；主要方法与流派或技术路线对比；共同结论与分歧；研究空白与发展趋势；"
    "对已有阅读报告内容的归纳（勿虚构未出现的文献）。\n"
    "严格依据所给阅读报告文本，不要编造引用；信息不足处请明确说明。不要输出外层 ```markdown 代码围栏。"
)

MAX_SYNTHESIS_PER_FILE = 10000
MAX_SYNTHESIS_TOTAL = 110000

MAX_REPRO_PAPER_CHARS = 12000
MAX_REPRO_REPORT_CHARS = 18000
MAX_REPRO_EXTRA_CHARS = 4000

DEFAULT_REPRODUCTION_SYSTEM_PROMPT = (
    "你是科研复现助手。用户会提供一篇文献的正文节选、该文献已保存的阅读报告全文，以及用户为复现准备的数据集条目（名称、说明、链接）。\n"
    "请根据用户指定的**目标语言**（Python 或 MATLAB）输出**可运行的初步骨架代码**，要求：\n"
    "- 用注释标明各模块对应文献中的哪一部分；细节不足处用 `TODO` 或中文注释说明假设，不要编造未在材料中出现的公式、超参数或网络结构。\n"
    "- 为每个数据集条目预留加载路径或占位变量，并在注释中写明应替换为用户本机路径或下载方式。\n"
    "- Python：使用常见库（如 numpy/torch/sklearn 等）时可在文件头注释列出 `pip install` 建议；MATLAB：使用脚本或函数形式，注明所需工具箱（若不确定则注释说明）。\n"
    "- 输出**仅为源代码**，不要 Markdown 围栏（不要 ```）；不要长篇前言；若需多个逻辑文件，用注释行分隔，例如 `# --- file: train.py ---` 或 `% --- file: train.m ---`。\n"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_chat_url(base_url: str) -> str:
    trimmed = (base_url or "").strip().rstrip("/")
    if not trimmed:
        return ""
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return f"{trimmed}/chat/completions"


def _default_cors_origins() -> list[str]:
    """与 Vite 开发（18001）及 vite preview（默认 4173）对齐；按需通过环境变量扩展。"""
    return [
        "http://127.0.0.1:18001",
        "http://localhost:18001",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
    ]


def _cors_config() -> tuple[list[str], bool]:
    """
    返回 (allow_origins, allow_credentials)。
    设置 LITERATURE_API_CORS_ORIGINS=* 可恢复任意来源（不推荐对外暴露服务时使用）。
    逗号分隔多个来源；留空则使用默认本机前端地址。
    """
    raw = os.environ.get("LITERATURE_API_CORS_ORIGINS", "").strip()
    if raw == "*":
        return (["*"], False)
    if raw:
        parts = [x.strip() for x in raw.split(",") if x.strip()]
        return (parts if parts else _default_cors_origins(), True)
    return (_default_cors_origins(), True)


def strip_document(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "original_filename": row["original_filename"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    LITERATURE_REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=120.0) as client:
        app.state.http = client
        yield


app = FastAPI(title="Literature Manager API", lifespan=lifespan)
_cors_origins, _cors_credentials = _cors_config()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_http(request: Request) -> httpx.Client:
    return request.app.state.http


@app.get("/api/health")
def health():
    """进程存活探测（不含数据库探测，避免额外开销）。"""
    return {"status": "ok"}


class PatchDocumentBody(BaseModel):
    title: str | None = None
    notes: str | None = None


class SettingsPutBody(BaseModel):
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str | None = None
    temperature: float | None = None
    reportPrompt: str | None = None
    chatPrompt: str | None = None
    literatureReviewPrompt: str | None = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatBody(BaseModel):
    documentId: str
    messages: list[ChatMessage]


class ReportBody(BaseModel):
    documentId: str
    messages: list[ChatMessage] | None = None


class SynthesisBody(BaseModel):
    fieldDirection: str = ""


class ReproductionDatasetCreate(BaseModel):
    name: str
    description: str | None = None
    sourceUrl: str | None = None


class ReproductionGenerateBody(BaseModel):
    language: Literal["python", "matlab"]
    extraNotes: str = ""


def get_document_row(conn, doc_id: str) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (doc_id,)).fetchone()
    return row_to_dict(row) if row else None


def load_chat_messages(conn, doc_id: str) -> list[dict[str, str]]:
    rows = conn.execute(
        "SELECT role, content FROM document_chat_messages WHERE document_id = ? ORDER BY position ASC",
        (doc_id,),
    ).fetchall()
    return [{"role": r["role"], "content": r["content"]} for r in rows]


def replace_chat_messages(conn, doc_id: str, messages: list[dict[str, str]]) -> None:
    conn.execute("DELETE FROM document_chat_messages WHERE document_id = ?", (doc_id,))
    pos = 0
    for m in messages:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        conn.execute(
            "INSERT INTO document_chat_messages (document_id, position, role, content) VALUES (?, ?, ?, ?)",
            (doc_id, pos, role, content),
        )
        pos += 1


def get_report_system_prompt(conn) -> str:
    custom = get_setting(conn, "report_system_prompt", "").strip()
    return custom if custom else DEFAULT_REPORT_SYSTEM_PROMPT


def get_chat_system_prompt(conn) -> str:
    custom = get_setting(conn, "chat_system_prompt", "").strip()
    return custom if custom else DEFAULT_CHAT_SYSTEM_PROMPT


def get_literature_review_system_prompt(conn) -> str:
    custom = get_setting(conn, "literature_review_system_prompt", "").strip()
    return custom if custom else DEFAULT_LITERATURE_REVIEW_SYSTEM_PROMPT


def load_reading_report_files() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for path in sorted(REPORTS_DIR.glob("*.md")):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
            out.append((path.name, text))
        except OSError:
            continue
    return out


def find_reading_report_content_for_doc(doc_id: str) -> str | None:
    if not REPORTS_DIR.exists():
        return None
    needle = doc_id[:8]
    candidates: list[tuple[Path, float]] = []
    for path in REPORTS_DIR.glob(f"*_{needle}_*.md"):
        if path.is_file():
            try:
                candidates.append((path, path.stat().st_mtime))
            except OSError:
                continue
    if candidates:
        candidates.sort(key=lambda x: x[1], reverse=True)
        try:
            return candidates[0][0].read_text(encoding="utf-8")
        except OSError:
            return None
    marker = f"**文献 ID**：{doc_id}"
    for path in REPORTS_DIR.glob("*.md"):
        try:
            text = path.read_text(encoding="utf-8")
            if marker in text:
                return text
        except OSError:
            continue
    return None


def _strip_code_fence(text: str) -> str:
    t = (text or "").strip()
    if not t.startswith("```"):
        return t
    lines = t.split("\n")
    if not lines:
        return t
    if lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _format_reproduction_datasets(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "（用户尚未添加数据集条目；请在代码中使用占位路径或示例数据。）"
    parts: list[str] = []
    for i, r in enumerate(rows, 1):
        name = r.get("name") or ""
        desc = (str(r.get("description") or "")).strip()
        url = (str(r.get("source_url") or "")).strip()
        line = f"{i}. **{name}**"
        if desc:
            line += f"\n   - 说明：{desc}"
        if url:
            line += f"\n   - 来源/链接：{url}"
        parts.append(line)
    return "\n".join(parts)


def ensure_extracted_text(conn, row: dict[str, Any]) -> str:
    existing = row.get("extracted_text") or ""
    if isinstance(existing, str) and len(existing) > 0:
        return existing
    text = extract_pdf_text(row["file_path"])
    trimmed = text[: MAX_PAPER_CHARS * 2]
    ts = now_iso()
    conn.execute(
        "UPDATE documents SET extracted_text = ?, updated_at = ? WHERE id = ?",
        (trimmed, ts, row["id"]),
    )
    return trimmed


def _truncate_note(s: str, limit: int) -> str:
    if len(s) <= limit:
        return s
    return s[:limit] + "\n\n…（以下已截断以控制长度）"


def _format_chat_lines(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for m in messages:
        if not m.content:
            continue
        label = "用户" if m.role == "user" else "助手"
        lines.append(f"**{label}**：{m.content}")
    return "\n\n".join(lines) if lines else "（暂无对话记录，请主要依据文献正文撰写报告。）"


def _safe_filename_title(title: str, max_len: int = 40) -> str:
    bad = '<>:"/\\|?*\n\r\t'
    s = "".join("_" if c in bad else c for c in title)
    s = "_".join(s.split()) or "literature"
    return s[:max_len]


def _llm_error_response(r: httpx.Response) -> JSONResponse:
    raw = r.text
    detail = raw
    try:
        j = r.json()
        err = j.get("error")
        if isinstance(err, dict):
            detail = err.get("message") or raw
        elif isinstance(err, str):
            detail = err
        else:
            detail = j.get("message") or raw
    except Exception:
        pass
    return JSONResponse(
        status_code=502,
        content={"error": f"模型接口错误 ({r.status_code})", "detail": detail},
    )


@app.get("/api/documents")
def list_documents():
    with session() as conn:
        rows = conn.execute(
            "SELECT id, title, original_filename, notes, created_at, updated_at FROM documents ORDER BY updated_at DESC"
        ).fetchall()
        return [row_to_dict(r) for r in rows]


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        ext = row.get("extracted_text") or ""
        out = {k: v for k, v in row.items() if k not in ("file_path", "extracted_text")}
        out["has_extracted_text"] = bool(ext and len(ext) > 0)
        return out


@app.get("/api/documents/{doc_id}/file")
def get_document_file(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        path_str = row.get("file_path")
        if not path_str:
            raise HTTPException(status_code=404, detail="未找到文献文件路径")
        path = Path(path_str)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="文献文件不存在")
        
        response = FileResponse(
            path, 
            media_type="application/pdf"
        )
        # 显式指定 inline，防止浏览器下载
        response.headers["Content-Disposition"] = "inline"
        return response


@app.get("/api/documents/{doc_id}/messages")
def get_document_messages(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        msgs = load_chat_messages(conn, doc_id)
    return {"messages": msgs}


@app.delete("/api/documents/{doc_id}/messages", status_code=204)
def clear_document_messages(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        conn.execute("DELETE FROM document_chat_messages WHERE document_id = ?", (doc_id,))
    return Response(status_code=204)


@app.post("/api/documents", status_code=201)
async def create_document(
    file: UploadFile | None = File(None),
    title: str | None = Form(None),
    notes: str | None = Form(None),
):
    if not file or not file.filename:
        raise HTTPException(status_code=400, detail="请上传 PDF 文件")

    name_lower = file.filename.lower()
    if not name_lower.endswith(".pdf") and (file.content_type or "") != "application/pdf":
        raise HTTPException(status_code=400, detail="仅支持 PDF 文件")

    raw = await file.read()
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=400, detail="文件过大")

    doc_id = str(uuid.uuid4())
    ext = Path(file.filename).suffix or ".pdf"
    saved_name = f"{doc_id}{ext}"
    dest = UPLOADS_DIR / saved_name

    title_final = (title or "").strip() or Path(file.filename).stem or "未命名文献"
    notes_val = (notes or "").strip() or None
    ts = now_iso()

    try:
        dest.write_bytes(raw)
        with session() as conn:
            conn.execute(
                """INSERT INTO documents (id, title, original_filename, file_path, extracted_text, notes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (doc_id, title_final, file.filename, str(dest), None, notes_val, ts, ts),
            )
            row = conn.execute(
                "SELECT id, title, original_filename, notes, created_at, updated_at FROM documents WHERE id = ?",
                (doc_id,),
            ).fetchone()
            return row_to_dict(row)
    except Exception:
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        raise


@app.patch("/api/documents/{doc_id}")
def patch_document(doc_id: str, body: PatchDocumentBody):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")

        updates: list[str] = []
        vals: list[Any] = []
        if body.title is not None:
            updates.append("title = ?")
            vals.append(body.title.strip() or row["title"])
        if body.notes is not None:
            updates.append("notes = ?")
            vals.append(None if body.notes == "" else str(body.notes))

        if not updates:
            return strip_document(row)

        vals.append(now_iso())
        vals.append(doc_id)
        conn.execute(
            f"UPDATE documents SET {', '.join(updates)}, updated_at = ? WHERE id = ?",
            vals,
        )
        next_row = get_document_row(conn, doc_id)
        assert next_row
        return strip_document(next_row)


@app.delete("/api/documents/{doc_id}", status_code=204)
def delete_document(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        path = row.get("file_path")
        if path:
            p = Path(path)
            if p.exists():
                try:
                    p.unlink()
                except OSError:
                    pass
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    return Response(status_code=204)


@app.get("/api/settings")
def get_settings():
    with session() as conn:
        base_url = get_setting(conn, "llm_base_url", "")
        model = get_setting(conn, "llm_model", "gpt-4o-mini")
        temperature = get_setting(conn, "llm_temperature", "0.3")
        has_key = bool(get_setting(conn, "llm_api_key", ""))
        stored_rp = get_setting(conn, "report_system_prompt", "")
        stored_cp = get_setting(conn, "chat_system_prompt", "")
        stored_lr = get_setting(conn, "literature_review_system_prompt", "")
        return {
            "baseUrl": base_url,
            "model": model,
            "temperature": float(temperature) if temperature else 0.3,
            "hasApiKey": has_key,
            "reportPrompt": stored_rp,
            "defaultReportPrompt": DEFAULT_REPORT_SYSTEM_PROMPT,
            "usingCustomReportPrompt": bool(stored_rp.strip()),
            "chatPrompt": stored_cp,
            "defaultChatPrompt": DEFAULT_CHAT_SYSTEM_PROMPT,
            "usingCustomChatPrompt": bool(stored_cp.strip()),
            "literatureReviewPrompt": stored_lr,
            "defaultLiteratureReviewPrompt": DEFAULT_LITERATURE_REVIEW_SYSTEM_PROMPT,
            "usingCustomLiteratureReviewPrompt": bool(stored_lr.strip()),
        }


@app.put("/api/settings")
def put_settings(body: SettingsPutBody):
    with session() as conn:
        if body.baseUrl is not None:
            set_setting(conn, "llm_base_url", str(body.baseUrl).strip())
        if body.apiKey is not None and str(body.apiKey).strip():
            set_setting(conn, "llm_api_key", str(body.apiKey))
        if body.model is not None:
            set_setting(conn, "llm_model", str(body.model).strip())
        if body.temperature is not None:
            set_setting(conn, "llm_temperature", str(body.temperature))
        if body.reportPrompt is not None:
            set_setting(conn, "report_system_prompt", str(body.reportPrompt).strip())
        if body.chatPrompt is not None:
            set_setting(conn, "chat_system_prompt", str(body.chatPrompt).strip())
        if body.literatureReviewPrompt is not None:
            set_setting(conn, "literature_review_system_prompt", str(body.literatureReviewPrompt).strip())
    return {"ok": True}


@app.post("/api/chat")
def chat_endpoint(body: ChatBody, http: httpx.Client = Depends(get_http)):
    doc_id = body.documentId
    messages = body.messages
    if not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")

    with session() as conn:
        base_url = get_setting(conn, "llm_base_url", "").strip()
        api_key = get_setting(conn, "llm_api_key", "")
        model = get_setting(conn, "llm_model", "gpt-4o-mini").strip()
        temp_raw = get_setting(conn, "llm_temperature", "0.3")
        try:
            temperature = float(temp_raw) if temp_raw else 0.3
        except ValueError:
            temperature = 0.3

        if not base_url:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Base URL")
        if not api_key:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Key")

        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")

        paper_text = ensure_extracted_text(conn, row)
        paper_text = paper_text[:MAX_PAPER_CHARS]

        system_instructions = get_chat_system_prompt(conn)
        system_content = (
            f"{system_instructions}\n\n"
            f"--- 文献正文 ---\n{paper_text or '（未能从 PDF 中提取到文本，可能是扫描版或加密文件）'}"
        )

        chat_url = normalize_chat_url(base_url)
        if not chat_url:
            raise HTTPException(status_code=400, detail="API Base URL 无效")

        outbound: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        for m in messages:
            if m.content and m.role in ("user", "assistant"):
                outbound.append({"role": m.role, "content": m.content})

        try:
            r = http.post(
                chat_url,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={"model": model, "temperature": temperature, "messages": outbound},
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        raw = r.text
        if not r.is_success:
            return _llm_error_response(r)

        try:
            data = r.json()
        except Exception:
            return JSONResponse(status_code=502, content={"error": "模型接口错误", "detail": raw})

        content = ""
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            content = msg.get("content") or ""

        full_thread: list[dict[str, str]] = []
        for m in messages:
            if m.content and m.role in ("user", "assistant"):
                full_thread.append({"role": m.role, "content": m.content})
        full_thread.append({"role": "assistant", "content": content})
        replace_chat_messages(conn, doc_id, full_thread)

        return {"content": content}


@app.post("/api/reports/generate")
def generate_reading_report(body: ReportBody, http: httpx.Client = Depends(get_http)):
    doc_id = body.documentId

    with session() as conn:
        base_url = get_setting(conn, "llm_base_url", "").strip()
        api_key = get_setting(conn, "llm_api_key", "")
        model = get_setting(conn, "llm_model", "gpt-4o-mini").strip()
        temp_raw = get_setting(conn, "llm_temperature", "0.3")
        try:
            temperature = float(temp_raw) if temp_raw else 0.3
        except ValueError:
            temperature = 0.3

        if not base_url:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Base URL")
        if not api_key:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Key")

        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")

        title = str(row.get("title") or "未命名文献")
        paper_text = ensure_extracted_text(conn, row)
        paper_text = _truncate_note(paper_text[:MAX_PAPER_CHARS], MAX_REPORT_PAPER_CHARS)

        stored = load_chat_messages(conn, doc_id)
        chat_for_report = [ChatMessage(role=x["role"], content=x["content"]) for x in stored]
        chat_block = _format_chat_lines(chat_for_report)
        chat_block = _truncate_note(chat_block, MAX_REPORT_CHAT_CHARS)

        system_instructions = get_report_system_prompt(conn)

        user_payload = (
            f"文献标题：{title}\n\n"
            "## 文献正文节选\n\n"
            f"{paper_text or '（未能从 PDF 提取文本，可能是扫描版或加密文件）'}\n\n"
            "## 阅读对话记录\n\n"
            f"{chat_block}\n\n"
            "请基于以上内容输出完整阅读报告（Markdown 正文）。"
        )

        chat_url = normalize_chat_url(base_url)
        if not chat_url:
            raise HTTPException(status_code=400, detail="API Base URL 无效")

        outbound: list[dict[str, str]] = [
            {"role": "system", "content": system_instructions},
            {"role": "user", "content": user_payload},
        ]

        try:
            r = http.post(
                chat_url,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={"model": model, "temperature": temperature, "messages": outbound},
                timeout=180.0,
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        raw = r.text
        if not r.is_success:
            return _llm_error_response(r)

        try:
            data = r.json()
        except Exception:
            return JSONResponse(status_code=502, content={"error": "模型接口错误", "detail": raw})

        report_body = ""
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            report_body = msg.get("content") or ""

    # 清理同一文献已有的旧报告文件，避免产生多个文件
    # 查找文件名中包含此 doc_id 的 .md 文件
    for old_file in REPORTS_DIR.glob(f"*_{doc_id[:8]}_*.md"):
        try:
            old_file.unlink()
        except OSError:
            pass

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    slug = _safe_filename_title(title)
    filename = f"{slug}_{doc_id[:8]}_{ts}.md"
    path = REPORTS_DIR / filename

    header = (
        f"# 阅读报告\n\n"
        f"- **文献标题**：{title}\n"
        f"- **文献 ID**：{doc_id}\n"
        f"- **生成时间（UTC）**：{datetime.now(timezone.utc).isoformat()}\n"
        f"- **说明**：由大模型根据文献正文与当前对话历史自动生成，请核对原文。\n\n"
        f"---\n\n"
    )
    full_md = header + (report_body or "（模型未返回内容）")

    path.write_text(full_md, encoding="utf-8")

    rel = f"reading_reports/{filename}"
    return {
        "filename": filename,
        "relativePath": rel,
        "content": full_md,
    }


@app.get("/api/reports/reading-reports-count")
def reading_reports_count():
    return {"count": len(load_reading_report_files())}


def _list_md_files(directory: Path, rel_prefix: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not directory.exists():
        return out
    paths = [p for p in directory.glob("*.md") if p.is_file()]
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths:
        try:
            stat = path.stat()
            out.append(
                {
                    "filename": path.name,
                    "relativePath": f"{rel_prefix}/{path.name}",
                    "modifiedAt": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                    "size": stat.st_size,
                }
            )
        except OSError:
            continue
    return out


@app.get("/api/reports/inventory")
def reports_inventory():
    return {
        "readingReports": _list_md_files(REPORTS_DIR, "reading_reports"),
        "synthesisReports": _list_md_files(LITERATURE_REVIEWS_DIR, "literature_reviews"),
    }


@app.get("/api/reports/content")
def get_report_file_content(
    kind: Literal["reading", "synthesis"] = Query(...),
    filename: str = Query(..., max_length=512),
):
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="非法文件名")
    name = Path(filename).name
    if not name.endswith(".md"):
        raise HTTPException(status_code=400, detail="非法文件名")
    if kind == "reading":
        path = REPORTS_DIR / name
        rel = f"reading_reports/{name}"
        title = "阅读报告"
    else:
        path = LITERATURE_REVIEWS_DIR / name
        rel = f"literature_reviews/{name}"
        title = "文献综述"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"filename": name, "relativePath": rel, "content": content, "kind": kind, "title": title}


@app.delete("/api/reports/delete")
def delete_report_file(
    kind: Literal["reading", "synthesis"] = Query(...),
    filename: str = Query(..., max_length=512),
):
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="非法文件名")
    name = Path(filename).name
    if not name.endswith(".md"):
        raise HTTPException(status_code=400, detail="非法文件名")
    if kind == "reading":
        path = REPORTS_DIR / name
    else:
        path = LITERATURE_REVIEWS_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    return {"status": "ok"}


@app.post("/api/reports/synthesis")
def generate_literature_synthesis(body: SynthesisBody, http: httpx.Client = Depends(get_http)):
    field = (body.fieldDirection or "").strip()
    files = load_reading_report_files()
    if not files:
        raise HTTPException(
            status_code=400,
            detail="reading_reports 目录中暂无阅读报告，请先为各篇文献生成单篇阅读报告",
        )

    with session() as conn:
        base_url = get_setting(conn, "llm_base_url", "").strip()
        api_key = get_setting(conn, "llm_api_key", "")
        model = get_setting(conn, "llm_model", "gpt-4o-mini").strip()
        temp_raw = get_setting(conn, "llm_temperature", "0.3")
        try:
            temperature = float(temp_raw) if temp_raw else 0.3
        except ValueError:
            temperature = 0.3

        if not base_url:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Base URL")
        if not api_key:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Key")

        system_instructions = get_literature_review_system_prompt(conn)

        parts: list[str] = []
        total = 0
        used_names: list[str] = []
        for name, content in files:
            chunk = _truncate_note(content, MAX_SYNTHESIS_PER_FILE)
            block = f"### 来源文件：{name}\n\n{chunk}\n"
            if total + len(block) > MAX_SYNTHESIS_TOTAL:
                break
            parts.append(block)
            total += len(block)
            used_names.append(name)

        aggregated = "\n---\n\n".join(parts)

        user_payload = (
            "## 综述主题（领域方向）\n\n"
            f"{field or '（未指定，请综合各报告自行归纳领域与问题）'}\n\n"
            "## 以下为项目目录 `reading_reports` 中已保存的多篇单篇阅读报告（节选）\n\n"
            f"{aggregated}\n\n"
            "请基于以上内容撰写完整文献综述（Markdown 正文）。"
        )

        chat_url = normalize_chat_url(base_url)
        if not chat_url:
            raise HTTPException(status_code=400, detail="API Base URL 无效")

        outbound: list[dict[str, str]] = [
            {"role": "system", "content": system_instructions},
            {"role": "user", "content": user_payload},
        ]

        try:
            r = http.post(
                chat_url,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={"model": model, "temperature": temperature, "messages": outbound},
                timeout=300.0,
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        raw = r.text
        if not r.is_success:
            return _llm_error_response(r)

        try:
            data = r.json()
        except Exception:
            return JSONResponse(status_code=502, content={"error": "模型接口错误", "detail": raw})

        report_body = ""
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            report_body = msg.get("content") or ""

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    slug = _safe_filename_title(field) if field else "general"
    filename = f"synthesis_{slug}_{ts}.md"
    path = LITERATURE_REVIEWS_DIR / filename

    header = (
        f"# 文献综述\n\n"
        f"- **领域方向**：{field or '（未指定）'}\n"
        f"- **依据阅读报告**：{len(used_names)} 个文件（共发现 {len(files)} 个 .md）\n"
        f"- **生成时间（UTC）**：{datetime.now(timezone.utc).isoformat()}\n"
        f"- **说明**：由大模型根据 `reading_reports` 中已保存的单篇阅读报告归纳生成，请核对。\n\n"
        f"---\n\n"
    )
    full_md = header + (report_body or "（模型未返回内容）")

    path.write_text(full_md, encoding="utf-8")

    rel = f"literature_reviews/{filename}"
    return {
        "filename": filename,
        "relativePath": rel,
        "content": full_md,
    }


@app.get("/api/documents/{doc_id}/reproduction-datasets")
def list_reproduction_datasets(doc_id: str):
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        cur = conn.execute(
            """
            SELECT id, document_id, name, description, source_url, created_at
            FROM reproduction_datasets
            WHERE document_id = ?
            ORDER BY datetime(created_at) DESC
            """,
            (doc_id,),
        )
        rows = cur.fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d = row_to_dict(r)
        out.append(
            {
                "id": d["id"],
                "documentId": d["document_id"],
                "name": d["name"],
                "description": d["description"],
                "sourceUrl": d["source_url"],
                "createdAt": d["created_at"],
            }
        )
    return out


@app.post("/api/documents/{doc_id}/reproduction-datasets", status_code=201)
def create_reproduction_dataset(doc_id: str, body: ReproductionDatasetCreate):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="数据集名称不能为空")
    desc = (body.description or "").strip() or None
    surl = (body.sourceUrl or "").strip() or None
    ds_id = str(uuid.uuid4())
    ts = now_iso()
    with session() as conn:
        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")
        conn.execute(
            """
            INSERT INTO reproduction_datasets (id, document_id, name, description, source_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (ds_id, doc_id, name, desc, surl, ts),
        )
        r = conn.execute(
            "SELECT id, document_id, name, description, source_url, created_at FROM reproduction_datasets WHERE id = ?",
            (ds_id,),
        ).fetchone()
        assert r
        d = row_to_dict(r)
    return {
        "id": d["id"],
        "documentId": d["document_id"],
        "name": d["name"],
        "description": d["description"],
        "sourceUrl": d["source_url"],
        "createdAt": d["created_at"],
    }


@app.delete("/api/documents/{doc_id}/reproduction-datasets/{dataset_id}", status_code=204)
def delete_reproduction_dataset(doc_id: str, dataset_id: str):
    with session() as conn:
        ex = conn.execute(
            "SELECT id FROM reproduction_datasets WHERE id = ? AND document_id = ?",
            (dataset_id, doc_id),
        ).fetchone()
        if not ex:
            raise HTTPException(status_code=404, detail="未找到数据集")
        conn.execute("DELETE FROM reproduction_datasets WHERE id = ? AND document_id = ?", (dataset_id, doc_id))
    return Response(status_code=204)


@app.post("/api/documents/{doc_id}/reproduction/generate")
def generate_reproduction_code(
    doc_id: str,
    body: ReproductionGenerateBody,
    http: httpx.Client = Depends(get_http),
):
    with session() as conn:
        base_url = get_setting(conn, "llm_base_url", "").strip()
        api_key = get_setting(conn, "llm_api_key", "")
        model = get_setting(conn, "llm_model", "gpt-4o-mini").strip()
        temp_raw = get_setting(conn, "llm_temperature", "0.3")
        try:
            temperature = float(temp_raw) if temp_raw else 0.3
        except ValueError:
            temperature = 0.3

        if not base_url:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Base URL")
        if not api_key:
            raise HTTPException(status_code=400, detail="请先在设置中填写 API Key")

        row = get_document_row(conn, doc_id)
        if not row:
            raise HTTPException(status_code=404, detail="未找到文献")

        report_text = find_reading_report_content_for_doc(doc_id)
        if not report_text:
            raise HTTPException(
                status_code=400,
                detail="未找到该文献的阅读报告。请先在「工作台」生成并保存单篇阅读报告（reading_reports）。",
            )

        ds_rows = conn.execute(
            "SELECT name, description, source_url FROM reproduction_datasets WHERE document_id = ? ORDER BY datetime(created_at) ASC",
            (doc_id,),
        ).fetchall()
        ds_dicts = [row_to_dict(r) for r in ds_rows]

        title = str(row.get("title") or "未命名文献")
        paper_text = ensure_extracted_text(conn, row)
        paper_text = _truncate_note(paper_text[:MAX_PAPER_CHARS], MAX_REPRO_PAPER_CHARS)
        report_trunc = _truncate_note(report_text, MAX_REPRO_REPORT_CHARS)
        datasets_block = _format_reproduction_datasets(ds_dicts)

        lang_name = "Python 3" if body.language == "python" else "MATLAB"
        ext_hint = "`.py`" if body.language == "python" else "`.m`"
        extra = _truncate_note((body.extraNotes or "").strip(), MAX_REPRO_EXTRA_CHARS)

        user_payload = (
            f"文献标题：{title}\n"
            f"目标语言：**{lang_name}**（请只使用该语言编写代码）\n\n"
            "## 文献正文节选\n\n"
            f"{paper_text or '（未能从 PDF 提取文本）'}\n\n"
            "## 阅读报告（已保存）\n\n"
            f"{report_trunc}\n\n"
            "## 复现数据集条目\n\n"
            f"{datasets_block}\n\n"
        )
        if extra:
            user_payload += f"## 额外说明\n\n{extra}\n\n"
        user_payload += (
            f"请输出完整源代码，便于直接保存为 {ext_hint} 文件。\n"
            "不要输出 Markdown 代码围栏；不要添加与代码无关的说明段落。"
        )

        system_instructions = DEFAULT_REPRODUCTION_SYSTEM_PROMPT + f"\n\n**当前任务**：仅输出 {lang_name} 源代码。"

        chat_url = normalize_chat_url(base_url)
        if not chat_url:
            raise HTTPException(status_code=400, detail="API Base URL 无效")

        outbound: list[dict[str, str]] = [
            {"role": "system", "content": system_instructions},
            {"role": "user", "content": user_payload},
        ]

        try:
            r = http.post(
                chat_url,
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json={"model": model, "temperature": min(temperature, 0.5), "messages": outbound},
                timeout=240.0,
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e

        raw = r.text
        if not r.is_success:
            return _llm_error_response(r)

        try:
            data = r.json()
        except Exception:
            return JSONResponse(status_code=502, content={"error": "模型接口错误", "detail": raw})

        raw_code = ""
        choices = data.get("choices") or []
        if choices:
            msg = choices[0].get("message") or {}
            raw_code = msg.get("content") or ""

    code = _strip_code_fence(raw_code)
    if not code.strip():
        code = "# 模型未返回有效代码，请重试或检查网络与模型配置。\n"

    return {
        "language": body.language,
        "code": code,
        "filename": "reproduce.py" if body.language == "python" else "reproduce.m",
    }
