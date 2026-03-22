from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent

DATA_DIR = BACKEND_ROOT / "data"
UPLOADS_DIR = BACKEND_ROOT / "uploads"
DB_PATH = DATA_DIR / "app.db"

# 与 client、backend 同级的项目目录，用于存放阅读报告
REPORTS_DIR = PROJECT_ROOT / "reading_reports"
# 文献综述（基于多篇阅读报告）
LITERATURE_REVIEWS_DIR = PROJECT_ROOT / "literature_reviews"
