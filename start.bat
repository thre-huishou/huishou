@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo [文献管理] 启动开发环境：后端 API 3001 + 前端 http://localhost:18001
echo.
npm run dev
if errorlevel 1 pause
