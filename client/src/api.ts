const base = "";

export type DocumentRow = {
  id: string;
  title: string;
  original_filename: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Settings = {
  baseUrl: string;
  model: string;
  temperature: number;
  hasApiKey: boolean;
  /** 已保存的自定义提示词，空字符串表示使用 defaultReportPrompt */
  reportPrompt: string;
  defaultReportPrompt?: string;
  usingCustomReportPrompt?: boolean;
  chatPrompt: string;
  defaultChatPrompt?: string;
  usingCustomChatPrompt?: boolean;
  literatureReviewPrompt?: string;
  defaultLiteratureReviewPrompt?: string;
  usingCustomLiteratureReviewPrompt?: boolean;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** 解析 FastAPI / Starlette 常见 JSON 错误体（含 detail 数组），供非 handle() 请求复用。 */
export function parseApiErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: string; detail?: unknown };
    if (j.detail !== undefined && j.detail !== null) {
      if (typeof j.detail === "string") return j.detail;
      if (Array.isArray(j.detail)) {
        const parts = j.detail.map((item: unknown) => {
          if (item && typeof item === "object" && "msg" in item) {
            return String((item as { msg: string }).msg);
          }
          return typeof item === "string" ? item : JSON.stringify(item);
        });
        return parts.filter(Boolean).join("；") || j.error || text;
      }
    }
    if (j.error) return typeof j.error === "string" ? j.error : JSON.stringify(j.error);
  } catch {
    /* ignore */
  }
  return text;
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    const msg = parseApiErrorMessage(text);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function listDocuments(): Promise<DocumentRow[]> {
  const res = await fetch(`${base}/api/documents`);
  return handle<DocumentRow[]>(res);
}

export async function createDocument(file: File, title?: string, notes?: string): Promise<DocumentRow> {
  const fd = new FormData();
  fd.append("file", file);
  if (title) fd.append("title", title);
  if (notes) fd.append("notes", notes);
  const res = await fetch(`${base}/api/documents`, { method: "POST", body: fd });
  return handle<DocumentRow>(res);
}

export async function updateDocument(
  id: string,
  patch: { title?: string; notes?: string | null }
): Promise<DocumentRow> {
  const res = await fetch(`${base}/api/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return handle<DocumentRow>(res);
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${base}/api/documents/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text) || `HTTP ${res.status}`);
  }
}

export async function getDocumentMessages(documentId: string): Promise<{ messages: ChatMessage[] }> {
  const res = await fetch(`${base}/api/documents/${documentId}/messages`);
  return handle<{ messages: ChatMessage[] }>(res);
}

export async function clearDocumentMessages(documentId: string): Promise<void> {
  const res = await fetch(`${base}/api/documents/${documentId}/messages`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text) || `HTTP ${res.status}`);
  }
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch(`${base}/api/settings`);
  return handle<Settings>(res);
}

export async function saveSettings(body: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** 传空字符串可清除自定义，恢复内置默认 */
  reportPrompt?: string;
  chatPrompt?: string;
  literatureReviewPrompt?: string;
}): Promise<void> {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await handle(res);
}

export async function chat(documentId: string, messages: ChatMessage[]): Promise<{ content: string }> {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, messages }),
  });
  return handle<{ content: string }>(res);
}

export type ReadingReportResult = {
  filename: string;
  relativePath: string;
  content: string;
};

export async function generateReadingReport(documentId: string): Promise<ReadingReportResult> {
  const res = await fetch(`${base}/api/reports/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  });
  return handle<ReadingReportResult>(res);
}

export async function getReadingReportsCount(): Promise<{ count: number }> {
  const res = await fetch(`${base}/api/reports/reading-reports-count`);
  return handle<{ count: number }>(res);
}

export type ReportFileItem = {
  filename: string;
  relativePath: string;
  modifiedAt: string;
  size: number;
};

export async function getReportsInventory(): Promise<{
  readingReports: ReportFileItem[];
  synthesisReports: ReportFileItem[];
}> {
  const res = await fetch(`${base}/api/reports/inventory`);
  return handle<{
    readingReports: ReportFileItem[];
    synthesisReports: ReportFileItem[];
  }>(res);
}

export async function getReportFileContent(
  kind: "reading" | "synthesis",
  filename: string
): Promise<{ filename: string; relativePath: string; content: string; title: string }> {
  const params = new URLSearchParams({ kind, filename });
  const res = await fetch(`${base}/api/reports/content?${params}`);
  return handle<{ filename: string; relativePath: string; content: string; title: string }>(res);
}

export async function deleteReportFile(kind: "reading" | "synthesis", filename: string): Promise<void> {
  const params = new URLSearchParams({ kind, filename });
  const res = await fetch(`${base}/api/reports/delete?${params}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiErrorMessage(text) || `HTTP ${res.status}`);
  }
}

export async function generateLiteratureSynthesis(fieldDirection: string): Promise<ReadingReportResult> {
  const res = await fetch(`${base}/api/reports/synthesis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fieldDirection: fieldDirection.trim() }),
  });
  return handle<ReadingReportResult>(res);
}

export type ReproductionDatasetRow = {
  id: string;
  documentId: string;
  name: string;
  description: string | null;
  sourceUrl: string | null;
  createdAt: string;
};

export async function listReproductionDatasets(documentId: string): Promise<ReproductionDatasetRow[]> {
  const res = await fetch(`${base}/api/documents/${documentId}/reproduction-datasets`);
  return handle<ReproductionDatasetRow[]>(res);
}

export async function createReproductionDataset(
  documentId: string,
  body: { name: string; description?: string; sourceUrl?: string }
): Promise<ReproductionDatasetRow> {
  const res = await fetch(`${base}/api/documents/${documentId}/reproduction-datasets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: body.name,
      description: body.description?.trim() || undefined,
      sourceUrl: body.sourceUrl?.trim() || undefined,
    }),
  });
  return handle<ReproductionDatasetRow>(res);
}

export async function deleteReproductionDataset(documentId: string, datasetId: string): Promise<void> {
  const res = await fetch(`${base}/api/documents/${documentId}/reproduction-datasets/${datasetId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
}

export async function generateReproductionCode(
  documentId: string,
  body: { language: "python" | "matlab"; extraNotes?: string }
): Promise<{ language: string; code: string; filename: string }> {
  const res = await fetch(`${base}/api/documents/${documentId}/reproduction/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: body.language,
      extraNotes: body.extraNotes?.trim() ?? "",
    }),
  });
  return handle(res);
}
