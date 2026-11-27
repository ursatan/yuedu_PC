@echo off
rem ============================================================
rem  YueDu PC - WEB DEV SERVER ONLY (hot reload)
rem
rem  What this does:
rem    starts vite on http://127.0.0.1:5173 with HMR.
rem    /api requests are proxied to the backend on 127.0.0.1:3000
rem    (that target is hardcoded in apps\web\vite.config.ts), so you must
rem    ALREADY have a port-3000 backend running: YueDu.exe --server-only (official)
rem    or start-server.bat (developer fallback) in another window.
rem    The PC client (YueDu.exe / start-desktop.bat) listens on 3100 and is
rem    NOT reachable through this proxy.
rem
rem  Why you need this:
rem    the backend serves the web UI from apps/web/dist, which is a
rem    BUILD OUTPUT. Editing apps/web/src does nothing until you
rem    rebuild dist and restart the backend. This dev server removes
rem    that rebuild step - save a file, the page updates itself.
rem
rem  IMPORTANT: closing this window STOPS the dev server.
rem  NOTE: keep this file pure ASCII. cmd.exe reads .bat as ANSI(GBK).
rem ============================================================
cd /d F:\yuedu_PC

rem ---- pick a node interpreter (no hardcoded version) ----------------
set "NV="
set /p NV=<"C:\Users\SATAN\.workbuddy\binaries\node\versions\current" 2>nul
set "NODE="
if defined NV if exist "C:\Users\SATAN\.workbuddy\binaries\node\versions\%NV%\node.exe" set "NODE=C:\Users\SATAN\.workbuddy\binaries\node\versions\%NV%\node.exe"
for /f "delims=" %%D in ('dir /b /o-n "C:\Users\SATAN\.workbuddy\binaries\node\versions" 2^>nul') do (
  if not defined NODE if exist "C:\Users\SATAN\.workbuddy\binaries\node\versions\%%D\node.exe" set "NODE=C:\Users\SATAN\.workbuddy\binaries\node\versions\%%D\node.exe"
)
if not defined NODE set "NODE=node"

rem ---- refuse to start twice ------------------------------------------
set "BUSY="
for /f "delims=" %%L in ('netstat -ano ^| findstr /r /c:":5173 .*LISTENING" 2^>nul') do set "BUSY=1"
if defined BUSY (
  echo [YueDu] Port 5173 is ALREADY in use - dev server probably running.
  echo [YueDu] Just open http://127.0.0.1:5173
  echo.
  pause
  exit /b 1
)

rem ---- warn if the backend is not up (pages will fail to load data) ---
set "SRV="
for /f "delims=" %%L in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING" 2^>nul') do set "SRV=1"
if not defined SRV (
  echo [YueDu] WARNING: nothing is listening on port 3000.
  echo [YueDu] Start the port-3000 backend first in another window:
  echo [YueDu]   YueDu.exe --server-only - official
  echo [YueDu]   start-server.bat - developer fallback
  echo.
)

echo.
echo [YueDu] node    = %NODE%
echo [YueDu] dev UI  = http://127.0.0.1:5173   ^<-- open THIS one
echo [YueDu] api     = proxied to http://127.0.0.1:3000
echo [YueDu] (closing this window stops the dev server)
echo.
rem Run vite straight from node: no dependency on pnpm being on PATH.
cd /d F:\yuedu_PC\apps\web
"%NODE%" node_modules\vite\bin\vite.js
pause