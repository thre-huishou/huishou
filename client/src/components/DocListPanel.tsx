import type { DocumentRow } from "../api";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export type DocListPanelProps = {
  documents: DocumentRow[];
  loadingList: boolean;
  selectedId: string | null;
  emptyHint: string;
  onSelectDocument: (id: string) => void;
};

export function DocListPanel({
  documents,
  loadingList,
  selectedId,
  emptyHint,
  onSelectDocument,
}: DocListPanelProps) {
  return (
    <section className="panel">
      <div className="panel-header">文献列表</div>
      <ul className={`doc-list ${loadingList ? "loading" : ""}`} aria-busy={loadingList}>
        {documents.length === 0 && !loadingList && (
          <li className="doc-item-meta" style={{ padding: "1rem", textAlign: "center" }}>
            {emptyHint}
          </li>
        )}
        {documents.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className={`doc-item ${d.id === selectedId ? "active" : ""}`}
              onClick={() => onSelectDocument(d.id)}
            >
              <div className="doc-item-title">{d.title}</div>
              <div className="doc-item-meta">{formatDate(d.updated_at)}</div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
