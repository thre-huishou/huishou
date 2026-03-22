import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .paths import DATA_DIR, DB_PATH


def _ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def get_conn() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    _ensure_dirs()
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                original_filename TEXT,
                file_path TEXT NOT NULL,
                extracted_text TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS document_chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_doc_chat_document ON document_chat_messages(document_id);

            CREATE TABLE IF NOT EXISTS reproduction_datasets (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                source_url TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_reproduction_document ON reproduction_datasets(document_id);
            """
        )
        conn.commit()


def get_setting(conn: sqlite3.Connection, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = get_conn()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}
