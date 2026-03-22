from pathlib import Path

from pypdf import PdfReader


def extract_pdf_text(file_path: str | Path) -> str:
    path = Path(file_path)
    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        t = page.extract_text() or ""
        parts.append(t)
    return "\n".join(parts).strip()
