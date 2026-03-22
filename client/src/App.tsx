import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { DocListPanel } from "./components/DocListPanel";
import { type AppViewId, PRIMARY_NAV } from "./layout/navConfig";
import {
  type ChatMessage,
  type DocumentRow,
  type Settings,
  chat,
  clearDocumentMessages,
  createDocument,
  deleteDocument,
  deleteReportFile,
  createReproductionDataset,
  deleteReproductionDataset,
  generateLiteratureSynthesis,
  generateReadingReport,
  generateReproductionCode,
  getDocumentMessages,
  getReadingReportsCount,
  getReportFileContent,
  getReportsInventory,
  type ReportFileItem,
  getSettings,
  listDocuments,
  listReproductionDatasets,
  saveSettings,
  updateDocument,
  type ReproductionDatasetRow,
} from "./api";

function downloadMarkdown(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadSourceFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function App() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.3,
    reportPrompt: "",
    chatPrompt: "",
    literatureReviewPrompt: "",
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({ title: "", notes: "" });

  const [chatByDoc, setChatByDoc] = useState<Record<string, ChatMessage[]>>({});
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportSaved, setReportSaved] = useState<{
    filename: string;
    relativePath: string;
    content: string;
  } | null>(null);
  const [synthesisSaved, setSynthesisSaved] = useState<{
    filename: string;
    relativePath: string;
    content: string;
  } | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{
    title: string;
    filename: string;
    relativePath: string;
    content: string;
  } | null>(null);
  const [synthesisModalOpen, setSynthesisModalOpen] = useState(false);
  const [synthesisField, setSynthesisField] = useState("");
  const [synthesisBusy, setSynthesisBusy] = useState(false);
  const [synthesisReportCount, setSynthesisReportCount] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<AppViewId>("workspace");
  const [reportsInventory, setReportsInventory] = useState<{
    readingReports: ReportFileItem[];
    synthesisReports: ReportFileItem[];
  } | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);

  const [reproDatasets, setReproDatasets] = useState<ReproductionDatasetRow[]>([]);
  const [reproLoading, setReproLoading] = useState(false);
  const [reproForm, setReproForm] = useState({ name: "", description: "", sourceUrl: "" });
  const [reproLang, setReproLang] = useState<"python" | "matlab">("python");
  const [reproExtraNotes, setReproExtraNotes] = useState("");
  const [reproCode, setReproCode] = useState<string | null>(null);
  const [reproFilename, setReproFilename] = useState("reproduce.py");
  const [reproBusy, setReproBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => documents.find((d) => d.id === selectedId) ?? null,
    [documents, selectedId]
  );

  const messages = selectedId ? chatByDoc[selectedId] ?? [] : [];

  const refreshList = useCallback(async () => {
    setError(null);
    setLoadingList(true);
    try {
      const rows = await listDocuments();
      setDocuments(rows);
      setSelectedId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoadingList(false);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
      setSettingsDraft({
        baseUrl: s.baseUrl,
        apiKey: "",
        model: s.model,
        temperature: s.temperature,
        reportPrompt: s.reportPrompt?.trim() ? s.reportPrompt : (s.defaultReportPrompt ?? ""),
        chatPrompt: s.chatPrompt?.trim() ? s.chatPrompt : (s.defaultChatPrompt ?? ""),
        literatureReviewPrompt: s.literatureReviewPrompt?.trim()
          ? s.literatureReviewPrompt
          : (s.defaultLiteratureReviewPrompt ?? ""),
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshList();
    refreshSettings();
  }, [refreshList, refreshSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (previewDoc) setPreviewDoc(null);
      else if (synthesisModalOpen) setSynthesisModalOpen(false);
      else if (editOpen) setEditOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewDoc, synthesisModalOpen, editOpen, settingsOpen]);

  useEffect(() => {
    if (activeView !== "workspace") return;
    const el = chatLogRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, activeView, selectedId]);

  const refreshReportsInventory = useCallback(async () => {
    setReportsLoading(true);
    try {
      const inv = await getReportsInventory();
      setReportsInventory(inv);
    } catch {
      setReportsInventory({ readingReports: [], synthesisReports: [] });
    } finally {
      setReportsLoading(false);
    }
  }, []);

  useLayoutEffect(() => {
    if (activeView !== "reports") return;
    void refreshReportsInventory();
  }, [activeView, refreshReportsInventory]);

  useEffect(() => {
    if (activeView !== "reproduction" || !selectedId) {
      setReproDatasets([]);
      return;
    }
    let cancelled = false;
    setReproLoading(true);
    listReproductionDatasets(selectedId)
      .then((rows) => {
        if (!cancelled) setReproDatasets(rows);
      })
      .catch(() => {
        if (!cancelled) setReproDatasets([]);
      })
      .finally(() => {
        if (!cancelled) setReproLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      try {
        const { messages } = await getDocumentMessages(selectedId);
        if (!cancelled) {
          setChatByDoc((prev) => {
            const local = prev[selectedId] ?? [];
            if (local.length > messages.length) {
              return prev;
            }
            return { ...prev, [selectedId]: messages };
          });
        }
      } catch {
        if (!cancelled) {
          setChatByDoc((prev) => ({ ...prev, [selectedId]: [] }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const onImportClick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const row = await createDocument(file);
      setDocuments((prev) => [row, ...prev.filter((x) => x.id !== row.id)]);
      setSelectedId(row.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    }
  };

  const openEdit = () => {
    if (!selected) return;
    setEditDraft({ title: selected.title, notes: selected.notes ?? "" });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!selected) return;
    setError(null);
    try {
      const row = await updateDocument(selected.id, {
        title: editDraft.title.trim() || selected.title,
        notes: editDraft.notes.trim() || null,
      });
      setDocuments((prev) => prev.map((d) => (d.id === row.id ? row : d)));
      setEditOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    }
  };

  const removeDoc = async () => {
    if (!selected) return;
    if (!confirm(`确定删除「${selected.title}」？`)) return;
    setError(null);
    try {
      await deleteDocument(selected.id);
      setDocuments((prev) => prev.filter((d) => d.id !== selected.id));
      setChatByDoc((prev) => {
        const next = { ...prev };
        delete next[selected.id];
        return next;
      });
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const openSettings = () => {
    refreshSettings();
    setSettingsOpen(true);
  };

  const saveSettingsClick = async () => {
    setError(null);
    try {
      const def = (settings?.defaultReportPrompt ?? "").trim();
      const cur = settingsDraft.reportPrompt.trim();
      const reportPromptToSave = cur === def ? "" : settingsDraft.reportPrompt;

      const defChat = (settings?.defaultChatPrompt ?? "").trim();
      const curChat = settingsDraft.chatPrompt.trim();
      const chatPromptToSave = curChat === defChat ? "" : settingsDraft.chatPrompt;

      const defLr = (settings?.defaultLiteratureReviewPrompt ?? "").trim();
      const curLr = settingsDraft.literatureReviewPrompt.trim();
      const literatureReviewPromptToSave = curLr === defLr ? "" : settingsDraft.literatureReviewPrompt;
      await saveSettings({
        baseUrl: settingsDraft.baseUrl,
        apiKey: settingsDraft.apiKey || undefined,
        model: settingsDraft.model,
        temperature: settingsDraft.temperature,
        reportPrompt: reportPromptToSave,
        chatPrompt: chatPromptToSave,
        literatureReviewPrompt: literatureReviewPromptToSave,
      });
      await refreshSettings();
      setSettingsOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存设置失败");
    }
  };

  const resetReportPromptToDefault = async () => {
    setError(null);
    try {
      await saveSettings({ reportPrompt: "" });
      await refreshSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复默认报告提示词失败");
    }
  };

  const resetChatPromptToDefault = async () => {
    setError(null);
    try {
      await saveSettings({ chatPrompt: "" });
      await refreshSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复默认对话提示词失败");
    }
  };

  const resetLiteratureReviewPromptToDefault = async () => {
    setError(null);
    try {
      await saveSettings({ literatureReviewPrompt: "" });
      await refreshSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "恢复默认综述提示词失败");
    }
  };

  const openSynthesisModal = () => {
    setSynthesisField("");
    setSynthesisModalOpen(true);
    setSynthesisReportCount(null);
    void getReadingReportsCount()
      .then(({ count }) => setSynthesisReportCount(count))
      .catch(() => setSynthesisReportCount(0));
  };

  const runSynthesis = async () => {
    setError(null);
    setSynthesisBusy(true);
    setSynthesisSaved(null);
    try {
      const res = await generateLiteratureSynthesis(synthesisField);
      setSynthesisSaved({
        filename: res.filename,
        relativePath: res.relativePath,
        content: res.content,
      });
      setPreviewDoc({
        title: "文献综述",
        filename: res.filename,
        relativePath: res.relativePath,
        content: res.content,
      });
      setSynthesisModalOpen(false);
      void refreshReportsInventory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成文献综述失败");
    } finally {
      setSynthesisBusy(false);
    }
  };

  const sendChat = async () => {
    if (!selectedId || !chatInput.trim()) return;
    const text = chatInput.trim();
    setChatInput("");
    const userMsg: ChatMessage = { role: "user", content: text };
    const prior = chatByDoc[selectedId] ?? [];
    const nextMessages = [...prior, userMsg];
    setChatByDoc((prev) => ({ ...prev, [selectedId]: nextMessages }));
    setChatSending(true);
    setError(null);
    try {
      const { content } = await chat(selectedId, nextMessages);
      const assistantMsg: ChatMessage = { role: "assistant", content };
      setChatByDoc((prev) => ({
        ...prev,
        [selectedId]: [...(prev[selectedId] ?? []), assistantMsg],
      }));
    } catch (e) {
      setChatByDoc((prev) => ({ ...prev, [selectedId]: prior }));
      setError(e instanceof Error ? e.message : "对话失败");
    } finally {
      setChatSending(false);
    }
  };

  const clearChat = async () => {
    if (!selectedId) return;
    if (!confirm("清空当前文献的对话记录？（服务器端同步清空）")) return;
    setError(null);
    try {
      await clearDocumentMessages(selectedId);
      setChatByDoc((prev) => ({ ...prev, [selectedId]: [] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "清空对话失败");
    }
  };

  const buildReport = async () => {
    if (!selectedId) return;
    setError(null);
    setReportBusy(true);
    setReportSaved(null);
    try {
      const res = await generateReadingReport(selectedId);
      setReportSaved({
        filename: res.filename,
        relativePath: res.relativePath,
        content: res.content,
      });
      setPreviewDoc({
        title: "阅读报告",
        filename: res.filename,
        relativePath: res.relativePath,
        content: res.content,
      });
      void refreshReportsInventory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成阅读报告失败");
    } finally {
      setReportBusy(false);
    }
  };

  const openReportFile = async (kind: "reading" | "synthesis", filename: string) => {
    setError(null);
    try {
      const res = await getReportFileContent(kind, filename);
      setPreviewDoc({
        title: res.title,
        filename: res.filename,
        relativePath: res.relativePath,
        content: res.content,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载报告失败");
    }
  };

  const handleDeleteReportFile = async (kind: "reading" | "synthesis", filename: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`确定要删除报告 "${filename}" 吗？此操作不可撤销。`)) return;
    setError(null);
    try {
      await deleteReportFile(kind, filename);
      if (previewDoc?.filename === filename) {
        setPreviewDoc(null);
      }
      void refreshReportsInventory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除报告失败");
    }
  };

  const addReproDataset = async () => {
    if (!selectedId || !reproForm.name.trim()) return;
    setError(null);
    try {
      const row = await createReproductionDataset(selectedId, {
        name: reproForm.name.trim(),
        description: reproForm.description.trim() || undefined,
        sourceUrl: reproForm.sourceUrl.trim() || undefined,
      });
      setReproDatasets((prev) => [row, ...prev]);
      setReproForm({ name: "", description: "", sourceUrl: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "添加数据集失败");
    }
  };

  const removeReproDataset = async (datasetId: string) => {
    if (!selectedId) return;
    if (!confirm("删除该数据集条目？")) return;
    setError(null);
    try {
      await deleteReproductionDataset(selectedId, datasetId);
      setReproDatasets((prev) => prev.filter((d) => d.id !== datasetId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  const runReproduce = async () => {
    if (!selectedId) return;
    setError(null);
    setReproBusy(true);
    setReproCode(null);
    try {
      const res = await generateReproductionCode(selectedId, {
        language: reproLang,
        extraNotes: reproExtraNotes,
      });
      setReproCode(res.code);
      setReproFilename(res.filename);
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成复现代码失败");
    } finally {
      setReproBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={onFile} />

      <div className="app-layout">
        <header className="app-topbar" aria-label="应用导航">
          <div className="app-topbar-brand">
            <span className="app-topbar-logo" aria-hidden>
              📚
            </span>
            <div>
              <div className="app-topbar-title">文献管理</div>
              <div className="app-topbar-sub">本地 · PDF 助手</div>
            </div>
          </div>
          <nav className="app-topbar-nav">
            {PRIMARY_NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`app-topbar-link ${activeView === item.id ? "active" : ""}`}
                onClick={() => setActiveView(item.id)}
                title={item.description}
              >
                <span className="app-topbar-link-label">{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="app-topbar-actions">
            <button type="button" className="btn btn-ghost app-topbar-settings" onClick={openSettings}>
              ⚙ 模型与提示词
            </button>
          </div>
        </header>

        <div className="app-main-area">
          {activeView === "workspace" && (
            <div className="app-toolbar" role="toolbar" aria-label="工作台快捷操作">
              <div className="app-toolbar-group">
                <span className="app-toolbar-label">文献</span>
                <button type="button" className="btn btn-primary" onClick={onImportClick}>
                  导入 PDF
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="app-banner-slot error-banner" role="alert">
              {error}
            </div>
          )}

          {reportSaved && (
            <div className="app-banner-slot success-banner" role="status">
          <span>
            阅读报告已保存到项目目录：<code>{reportSaved.relativePath}</code>
          </span>
          <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                setPreviewDoc({
                  title: "阅读报告",
                  filename: reportSaved.filename,
                  relativePath: reportSaved.relativePath,
                  content: reportSaved.content,
                })
              }
            >
              查看报告
            </button>
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => downloadMarkdown(reportSaved.filename, reportSaved.content)}
            >
              下载 Markdown
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setReportSaved(null);
                setPreviewDoc((p) => (p?.title === "阅读报告" ? null : p));
              }}
            >
              关闭
            </button>
          </span>
            </div>
          )}

          {synthesisSaved && (
            <div className="app-banner-slot success-banner" role="status">
          <span>
            文献综述已保存到项目目录：<code>{synthesisSaved.relativePath}</code>
          </span>
          <span style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                setPreviewDoc({
                  title: "文献综述",
                  filename: synthesisSaved.filename,
                  relativePath: synthesisSaved.relativePath,
                  content: synthesisSaved.content,
                })
              }
            >
              查看综述
            </button>
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => downloadMarkdown(synthesisSaved.filename, synthesisSaved.content)}
            >
              下载 Markdown
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSynthesisSaved(null);
                setPreviewDoc((p) => (p?.title === "文献综述" ? null : p));
              }}
            >
              关闭
            </button>
          </span>
            </div>
          )}

          {activeView === "workspace" && (
            <main className="app-main">
              <DocListPanel
                documents={documents}
                loadingList={loadingList}
                selectedId={selectedId}
                emptyHint="暂无文献，请点击「导入 PDF」"
                onSelectDocument={(id) => {
                  setSelectedId(id);
                  setReportSaved(null);
                  setPreviewDoc((p) => (p?.title === "阅读报告" ? null : p));
                }}
              />

              <div className="reader-layout">
                {selected && (
                  <section className="panel pdf-panel">
                    <div className="panel-header">
                      原文献预览
                      <span className="panel-header-hint">查看 PDF 原始内容</span>
                    </div>
                    <iframe
                      key={selected.id}
                      className="pdf-viewer-frame"
                      src={`/api/documents/${selected.id}/file#toolbar=0`}
                      title="PDF Preview"
                    />
                  </section>
                )}

                <section className="panel">
                  <div className="panel-header">
                    阅读助手（当前文献）
                    <span className="panel-header-hint">同一篇文献的对话在服务端持久保存，可跨刷新用于问答与报告</span>
                  </div>
                  {!selected && (
                    <div className="reader-empty">请从文献列表选择一篇文献，或在工作台顶部导入 PDF。</div>
                  )}
                  {selected && (
                    <div className="reader-body">
                      <div className="reader-title">{selected.title}</div>
                      <div className="reader-toolbar">
                        <div className="reader-tool-group">
                          <span className="reader-tool-label">文献</span>
                          <div className="reader-tool-buttons">
                            <button type="button" className="btn btn-ghost btn-sm" onClick={openEdit}>
                              编辑
                            </button>
                            <button type="button" className="btn btn-danger btn-sm" onClick={removeDoc}>
                              删除
                            </button>
                          </div>
                        </div>
                        <div className="reader-tool-group">
                          <span className="reader-tool-label">对话</span>
                          <div className="reader-tool-buttons">
                            <button type="button" className="btn btn-ghost btn-sm" onClick={clearChat}>
                              清空
                            </button>
                          </div>
                        </div>
                        <div className="reader-tool-group reader-tool-group-grow">
                          <span className="reader-tool-label">本篇报告</span>
                          <div className="reader-tool-buttons">
                            <button
                              type="button"
                              className="btn btn-accent btn-sm"
                              disabled={reportBusy || chatSending}
                              title="保存到 reading_reports"
                              onClick={() => void buildReport()}
                            >
                              {reportBusy ? "生成中…" : "生成阅读报告"}
                            </button>
                            {reportSaved && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() =>
                                  setPreviewDoc({
                                    title: "阅读报告",
                                    filename: reportSaved.filename,
                                    relativePath: reportSaved.relativePath,
                                    content: reportSaved.content,
                                  })
                                }
                              >
                                查看
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="chat-log" ref={chatLogRef}>
                        {messages.length === 0 && (
                          <div className="msg assistant">
                            向模型提问本篇文献的内容、方法或结论。回答将仅基于该 PDF 提取的正文（扫描版可能无法识别）。
                          </div>
                        )}
                        {messages.map((m, i) => (
                          <div key={i} className={`msg ${m.role}`}>
                            {m.content}
                          </div>
                        ))}
                      </div>
                      <div className="chat-input-row">
                        <textarea
                          placeholder="输入问题…（Enter 发送，Shift+Enter 换行）"
                          value={chatInput}
                          disabled={chatSending}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              void sendChat();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={chatSending}
                          onClick={() => void sendChat()}
                        >
                          {chatSending ? "…" : "发送"}
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </main>
          )}

          {activeView === "reproduction" && (
            <main className="app-main">
              <DocListPanel
                documents={documents}
                loadingList={loadingList}
                selectedId={selectedId}
                emptyHint="暂无文献，请切换到「工作台」导入 PDF"
                onSelectDocument={(id) => setSelectedId(id)}
              />

              <section className="panel reproduction-panel">
                <div className="panel-header">
                  文献复现
                  <span className="panel-header-hint">
                    使用当前文献正文 + 已保存的阅读报告 + 下列数据集条目，生成 Python 或 MATLAB 初步代码
                  </span>
                </div>
                {!selected && (
                  <div className="reader-empty">请从左侧选择一篇文献。需已在工作台生成单篇阅读报告。</div>
                )}
                {selected && (
                  <div className="reproduction-body">
                    <p className="reproduction-intro">
                      阅读报告来自项目目录 <code>reading_reports</code> 中与该文献 ID 匹配的文件；若未生成过报告，请先到「工作台」点击「生成阅读报告」。
                    </p>

                    <div className="reproduction-block">
                      <h4 className="reproduction-subtitle">数据集条目</h4>
                      {reproLoading ? (
                        <p className="hint">加载中…</p>
                      ) : reproDatasets.length === 0 ? (
                        <p className="hint">暂无条目，可在下方添加（名称必填）。</p>
                      ) : (
                        <ul className="reproduction-dataset-list">
                          {reproDatasets.map((ds) => (
                            <li key={ds.id} className="reproduction-dataset-item">
                              <div className="reproduction-dataset-main">
                                <strong>{ds.name}</strong>
                                {ds.description && <span className="reproduction-dataset-desc">{ds.description}</span>}
                                {ds.sourceUrl && (
                                  <a className="reproduction-dataset-link" href={ds.sourceUrl} target="_blank" rel="noreferrer">
                                    {ds.sourceUrl}
                                  </a>
                                )}
                              </div>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                onClick={() => void removeReproDataset(ds.id)}
                              >
                                删除
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="reproduction-form-grid">
                        <div className="form-group reproduction-form-compact">
                          <label htmlFor="reproName">名称</label>
                          <input
                            id="reproName"
                            value={reproForm.name}
                            onChange={(e) => setReproForm((f) => ({ ...f, name: e.target.value }))}
                            placeholder="例如：CIFAR-10、自定义实验数据"
                          />
                        </div>
                        <div className="form-group reproduction-form-compact">
                          <label htmlFor="reproDesc">说明（可选）</label>
                          <input
                            id="reproDesc"
                            value={reproForm.description}
                            onChange={(e) => setReproForm((f) => ({ ...f, description: e.target.value }))}
                            placeholder="分辨率、标注方式等"
                          />
                        </div>
                        <div className="form-group reproduction-form-compact">
                          <label htmlFor="reproUrl">来源 URL（可选）</label>
                          <input
                            id="reproUrl"
                            value={reproForm.sourceUrl}
                            onChange={(e) => setReproForm((f) => ({ ...f, sourceUrl: e.target.value }))}
                            placeholder="https://…"
                          />
                        </div>
                      </div>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void addReproDataset()}>
                        添加数据集
                      </button>
                    </div>

                    <div className="reproduction-block">
                      <h4 className="reproduction-subtitle">目标语言</h4>
                      <div className="reproduction-lang-row">
                        <label className="reproduction-radio">
                          <input
                            type="radio"
                            name="reproLang"
                            checked={reproLang === "python"}
                            onChange={() => setReproLang("python")}
                          />
                          Python
                        </label>
                        <label className="reproduction-radio">
                          <input
                            type="radio"
                            name="reproLang"
                            checked={reproLang === "matlab"}
                            onChange={() => setReproLang("matlab")}
                          />
                          MATLAB
                        </label>
                      </div>
                    </div>

                    <div className="reproduction-block">
                      <h4 className="reproduction-subtitle">额外说明（可选）</h4>
                      <textarea
                        className="reproduction-notes"
                        placeholder="例如：仅复现训练部分；使用 CPU；与某开源仓库对齐等"
                        value={reproExtraNotes}
                        onChange={(e) => setReproExtraNotes(e.target.value)}
                        rows={3}
                      />
                    </div>

                    <div className="reproduction-actions">
                      <button
                        type="button"
                        className="btn btn-accent"
                        disabled={reproBusy}
                        onClick={() => void runReproduce()}
                      >
                        {reproBusy ? "生成中…" : "生成初步复现代码"}
                      </button>
                    </div>

                    {reproCode !== null && (
                      <div className="reproduction-block reproduction-code-wrap">
                        <div className="reproduction-code-toolbar">
                          <span className="reproduction-code-filename">{reproFilename}</span>
                          <span className="reproduction-code-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() =>
                                downloadSourceFile(
                                  reproFilename,
                                  reproCode,
                                  reproLang === "python" ? "text/x-python" : "text/plain"
                                )
                              }
                            >
                              下载
                            </button>
                          </span>
                        </div>
                        <pre className="reproduction-code-pre">
                          <code>{reproCode}</code>
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </main>
          )}

          {activeView === "reports" && (
            <div className="reports-view">
              <header className="reports-view-head">
                <h2 className="reports-view-title">报告中心</h2>
                <p className="reports-view-desc">
                  上方为已保存的单篇阅读报告，可点击预览；在此发起文献综述。下方为已生成的综述文件。
                </p>
              </header>

              <section className="reports-section" aria-labelledby="reports-reading-heading">
                <div className="reports-section-head">
                  <h3 id="reports-reading-heading" className="reports-section-title">
                    单篇阅读报告
                  </h3>
                  <button type="button" className="btn btn-primary" onClick={openSynthesisModal}>
                    生成文献综述
                  </button>
                </div>
                <p className="reports-section-hint">
                  新报告请在「工作台」选择文献后，在右侧「本篇报告」中生成并保存至{" "}
                  <code>reading_reports</code>。
                </p>
                {reportsLoading && reportsInventory === null ? (
                  <p className="reports-section-empty">加载中…</p>
                ) : (reportsInventory?.readingReports.length ?? 0) === 0 ? (
                  <p className="reports-section-empty">暂无单篇阅读报告。</p>
                ) : (
                  <div className="reports-file-grid">
                    {reportsInventory?.readingReports.map((item) => (
                      <div key={item.filename} className="reports-file-card-wrap">
                        <button
                          type="button"
                          className="reports-file-card"
                          onClick={() => void openReportFile("reading", item.filename)}
                        >
                          <span className="reports-file-card-icon" aria-hidden>
                            📄
                          </span>
                          <span className="reports-file-card-name" title={item.filename}>
                            {item.filename}
                          </span>
                          <span className="reports-file-card-meta">
                            {formatDate(item.modifiedAt)} · {formatBytes(item.size)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger reports-file-card-delete"
                          title="删除报告"
                          onClick={(e) => void handleDeleteReportFile("reading", item.filename, e)}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="reports-section reports-section-bottom" aria-labelledby="reports-synthesis-heading">
                <h3 id="reports-synthesis-heading" className="reports-section-title">
                  文献综述
                </h3>
                <p className="reports-section-hint">
                  由「生成文献综述」根据全部单篇报告生成，保存至 <code>literature_reviews</code>。
                </p>
                {reportsLoading && reportsInventory === null ? (
                  <p className="reports-section-empty">加载中…</p>
                ) : (reportsInventory?.synthesisReports.length ?? 0) === 0 ? (
                  <p className="reports-section-empty">暂无文献综述文件。</p>
                ) : (
                  <div className="reports-file-grid">
                    {reportsInventory?.synthesisReports.map((item) => (
                      <div key={item.filename} className="reports-file-card-wrap">
                        <button
                          type="button"
                          className="reports-file-card reports-file-card-synthesis"
                          onClick={() => void openReportFile("synthesis", item.filename)}
                        >
                          <span className="reports-file-card-icon" aria-hidden>
                            📑
                          </span>
                          <span className="reports-file-card-name" title={item.filename}>
                            {item.filename}
                          </span>
                          <span className="reports-file-card-meta">
                            {formatDate(item.modifiedAt)} · {formatBytes(item.size)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger reports-file-card-delete"
                          title="删除综述"
                          onClick={(e) => void handleDeleteReportFile("synthesis", item.filename, e)}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSettingsOpen(false)}>
          <div className="modal modal-wide" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
            <h2>大模型设置（OpenAI 兼容接口）</h2>
            <div className="form-group">
              <label htmlFor="baseUrl">API Base URL</label>
              <input
                id="baseUrl"
                value={settingsDraft.baseUrl}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
              />
              <p className="hint">需包含 /v1 前缀；服务端将请求 {`{Base URL}/chat/completions`}</p>
            </div>
            <div className="form-group">
              <label htmlFor="apiKey">API Key</label>
              <input
                id="apiKey"
                type="password"
                autoComplete="off"
                value={settingsDraft.apiKey}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, apiKey: e.target.value }))}
                placeholder={settings?.hasApiKey ? "已保存，留空则不修改" : "必填"}
              />
            </div>
            <div className="form-group">
              <label htmlFor="model">模型名称</label>
              <input
                id="model"
                value={settingsDraft.model}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, model: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="temp">温度 temperature（0–2）</label>
              <input
                id="temp"
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={settingsDraft.temperature}
                onChange={(e) =>
                  setSettingsDraft((s) => ({ ...s, temperature: parseFloat(e.target.value) || 0 }))
                }
              />
            </div>

            <div className="form-group form-group-report-prompt">
              <div className="form-group-label-row">
                <label htmlFor="reportPrompt">阅读报告 · 系统提示词</label>
                {settings?.usingCustomReportPrompt === true ? (
                  <span className="tag-custom">已自定义</span>
                ) : (
                  <span className="tag-default">使用内置默认</span>
                )}
              </div>
              <textarea
                id="reportPrompt"
                className="settings-report-textarea"
                spellCheck={false}
                value={settingsDraft.reportPrompt}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, reportPrompt: e.target.value }))}
              />
              <p className="hint">
                生成阅读报告时作为<strong>系统角色</strong>发送给模型；用户消息中仍会附带文献节选与对话记录。若内容与内置默认完全一致并保存，将视为使用默认（不重复存储）。
              </p>
              <div className="report-prompt-actions">
                <button type="button" className="btn btn-ghost" onClick={() => void resetReportPromptToDefault()}>
                  恢复内置默认并保存
                </button>
              </div>
            </div>

            <div className="form-group form-group-report-prompt">
              <div className="form-group-label-row">
                <label htmlFor="chatPrompt">对话助手 · 系统提示词</label>
                {settings?.usingCustomChatPrompt === true ? (
                  <span className="tag-custom">已自定义</span>
                ) : (
                  <span className="tag-default">使用内置默认</span>
                )}
              </div>
              <textarea
                id="chatPrompt"
                className="settings-report-textarea"
                spellCheck={false}
                value={settingsDraft.chatPrompt}
                onChange={(e) => setSettingsDraft((s) => ({ ...s, chatPrompt: e.target.value }))}
              />
              <p className="hint">
                工作台对话时作为<strong>系统角色</strong>发送给模型。用于定义 AI 助手的身份、翻译风格和回答规范。
              </p>
              <div className="report-prompt-actions">
                <button type="button" className="btn btn-ghost" onClick={() => void resetChatPromptToDefault()}>
                  恢复内置默认并保存
                </button>
              </div>
            </div>

            <div className="form-group form-group-report-prompt">
              <div className="form-group-label-row">
                <label htmlFor="literatureReviewPrompt">文献综述 · 系统提示词</label>
                {settings?.usingCustomLiteratureReviewPrompt === true ? (
                  <span className="tag-custom">已自定义</span>
                ) : (
                  <span className="tag-default">使用内置默认</span>
                )}
              </div>
              <textarea
                id="literatureReviewPrompt"
                className="settings-report-textarea"
                spellCheck={false}
                value={settingsDraft.literatureReviewPrompt}
                onChange={(e) =>
                  setSettingsDraft((s) => ({ ...s, literatureReviewPrompt: e.target.value }))
                }
              />
              <p className="hint">
                根据 <code>reading_reports</code> 中<strong>全部单篇阅读报告</strong>生成文献综述时，作为系统角色发送；用户消息中会附带各报告节选与领域方向。若与内置默认完全一致并保存，将视为使用默认。
              </p>
              <div className="report-prompt-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void resetLiteratureReviewPromptToDefault()}
                >
                  恢复内置默认并保存
                </button>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveSettingsClick()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {synthesisModalOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSynthesisModalOpen(false)}>
          <div className="modal modal-wide" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
            <h2>生成文献综述</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              将读取项目目录 <code>reading_reports</code> 下<strong>所有</strong>已保存的单篇阅读报告（.md），按领域方向综合为一份综述，并保存到{" "}
              <code>literature_reviews</code>。
            </p>
            <div className="form-group">
              <label htmlFor="synthesisField">领域方向 / 综述主题（可选）</label>
              <input
                id="synthesisField"
                value={synthesisField}
                onChange={(e) => setSynthesisField(e.target.value)}
                placeholder="例如：遥感图像分类、深度学习在农业中的应用"
              />
            </div>
            <p className="hint">
              当前可聚合的阅读报告数量：
              {synthesisReportCount === null ? " …" : ` ${synthesisReportCount} 个`}
              {synthesisReportCount === 0 ? "（请先生成单篇阅读报告）" : null}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setSynthesisModalOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={synthesisBusy || synthesisReportCount === 0}
                onClick={() => void runSynthesis()}
              >
                {synthesisBusy ? "生成中…" : "生成文献综述"}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewDoc && (
        <div
          className="modal-backdrop report-viewer-backdrop"
          role="presentation"
          onClick={() => setPreviewDoc(null)}
        >
          <div
            className="modal modal-report"
            role="dialog"
            aria-modal
            aria-labelledby="preview-doc-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-report-toolbar">
              <div className="modal-report-title-block">
                <h2 id="preview-doc-title">{previewDoc.title}</h2>
                <p className="modal-report-filename">{previewDoc.filename}</p>
              </div>
              <div className="modal-report-toolbar-actions">
                <button
                  type="button"
                  className="btn btn-accent"
                  onClick={() => downloadMarkdown(previewDoc.filename, previewDoc.content)}
                >
                  下载
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setPreviewDoc(null)}>
                  关闭窗口
                </button>
              </div>
            </div>
            <div className="report-view-frame">
              <div className="report-md-content">
                <ReactMarkdown>{previewDoc.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        </div>
      )}

      {editOpen && selected && (
        <div className="modal-backdrop" role="presentation" onClick={() => setEditOpen(false)}>
          <div className="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>编辑文献</h2>
            <div className="form-group">
              <label htmlFor="title">标题</label>
              <input
                id="title"
                value={editDraft.title}
                onChange={(e) => setEditDraft((d) => ({ ...d, title: e.target.value }))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="notes">备注</label>
              <textarea
                id="notes"
                value={editDraft.notes}
                onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setEditOpen(false)}>
                取消
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveEdit()}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
