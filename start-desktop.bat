@echo off
rem ============================================================
rem  YueDu EngineHub - DESKTOP CLIENT (developer launcher)
rem
rem  What this does:
rem    starts apps\desktop with the local electron binary, i.e. the
rem    PC client (main window + tray). No pnpm on PATH required.
rem
rem  Defaults in this DEV layout:
rem    port    = 3100 (PC client default; set PORT to override)
rem    data    = F:\yuedu_PC\data (desktop shell injects it itself;
rem              set YUEDU_DATA_DIR to override)
rem    server  = apps\desktop\server-bundle.mjs (build output, reused as-is)
rem
rem  Not the entry for end users: they run YueDu.exe (client) or
rem  YueDu.exe --server-only (service + tray only, same exe).
rem  Service shell for debugging: electron . --server-only  (port 3000)
rem
rem  NOTE: keep this file pure ASCII. cmd.exe reads .bat as ANSI(GBK).
rem ============================================================
rem Clears ELECTRON_RUN_AS_NODE so electron runs as a GUI app (required when
rem launched from hosts that export it, e.g. VS Code / WorkBuddy terminals).
set ELECTRON_RUN_AS_NODE=
cd /d %~dp0apps\desktop
if not exist "node_modules\electron\dist\electron.exe" (
  echo [YueDu] electron binary is missing:
  echo [YueDu]   apps\desktop\node_modules\electron\dist\electron.exe
  echo [YueDu] install it first:  pnpm install
  echo [YueDu] fallback: node node_modules\electron\install.js
  echo.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
