@echo off
rem #476: console code page -> UTF-8. The log sink (apps/server/src/log-sink.ts) writes
rem raw UTF-8 bytes via fs.writeSync(fd) in a worker thread (to avoid blocking the event
rem loop). Without this, conhost decodes those bytes as cp936(GBK) => garbled Chinese.
rem Pure ASCII line, safe for cmd.exe ANSI parsing.
chcp 65001 >nul
rem ============================================================
rem  YueDu EngineHub - backend server only (no desktop window)
rem  Open http://127.0.0.1:3000 (default PORT) in a browser when it is up.
rem
rem  NOT THE OFFICIAL ENTRY (2026-11-24):
rem    normal users should run YueDu.exe (PC client, starts its own server)
rem    or YueDu.exe --server-only (server + tray only, same exe). This .bat
rem    is kept ONLY as a developer / last-resort fallback (e.g. no packaged build).
rem  It does NOT create the tray, cannot be closed to tray, and is not
rem    protected by the shell-level data-dir lock.
rem
rem  IMPORTANT: closing this window STOPS the server.
rem  Keep it open (minimize is fine) while you use the web UI.
rem  The web UI (apps/web/dist) is served by this same process.
rem ============================================================
rem  NOTE: keep this file pure ASCII. cmd.exe reads .bat as ANSI(GBK);
rem  non-ASCII bytes here break line parsing and the script fails.
cd /d F:\yuedu_PC

rem ---- fallback guard: the server bundle is a BUILD OUTPUT --------------
rem server-bundle.mjs is gitignored, so a fresh clone (or a wiped
rem apps\desktop) has none. Without this check node dies with
rem MODULE_NOT_FOUND further down and the reason is not obvious.
if not exist "apps\desktop\server-bundle.mjs" (
  echo [YueDu] apps\desktop\server-bundle.mjs is missing - it is a BUILD OUTPUT.
  echo [YueDu] build it first:  pnpm --filter @yuedu/desktop build:server
  echo.
  pause
  exit /b 1
)

rem ---- configurable port / explicit data dir --------------------------
rem Both are overridable from the environment; the defaults below are this
rem machine's usual layout. server.pid / cookies.json are derived from the
rem SAME directory (server side), so overriding this one keeps them in sync.
if not defined PORT set "PORT=3000"
if not defined YUEDU_DATA_DIR set "YUEDU_DATA_DIR=F:\yuedu_PC\data"

rem ---- pick a node interpreter (no hardcoded version) ----------------
rem  1) WorkBuddy managed pointer file: versions\current (holds version dir name)
rem  2) first usable version dir under versions\ , name descending
rem  3) plain "node" from PATH
set "NV="
set /p NV=<"C:\Users\SATAN\.workbuddy\binaries\node\versions\current" 2>nul
set "NODE="
if defined NV if exist "C:\Users\SATAN\.workbuddy\binaries\node\versions\%NV%\node.exe" set "NODE=C:\Users\SATAN\.workbuddy\binaries\node\versions\%NV%\node.exe"
for /f "delims=" %%D in ('dir /b /o-n "C:\Users\SATAN\.workbuddy\binaries\node\versions" 2^>nul') do (
  if not defined NODE if exist "C:\Users\SATAN\.workbuddy\binaries\node\versions\%%D\node.exe" set "NODE=C:\Users\SATAN\.workbuddy\binaries\node\versions\%%D\node.exe"
)
if not defined NODE set "NODE=node"

rem ---- refuse to start twice (port already taken) --------------------
rem #242: the old "just tell them to close the window" advice was WRONG for
rem services started by the in-app Restart button (detached, no console):
rem closing the cmd window does NOT kill them, so the user gets stuck in a
rem "closed it, still busy" loop. Now we read data\server.pid, and if the
rem listener really is our own server, offer to stop it and continue.
rem NOTE: kept FLAT (no parenthesised blocks) on purpose -- inside a block,
rem %VAR% is expanded at parse time, so a value set inside the block reads
rem back empty. Labels + goto are the reliable way in a .bat.
set "BUSY_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" 2^>nul') do set "BUSY_PID=%%P"
if not defined BUSY_PID goto :portok

echo.
echo [YueDu] Port %PORT% is ALREADY in use. by PID %BUSY_PID%

rem ---- identity handshake: NEVER kill a desktop-managed server ---------
rem Read /api/system/identity; mode=desktop means YueDu.exe owns it. Its
rem watchdog would restart it 3s after a kill, so killing only creates a
rem kill/restart loop. Ask the user to quit the desktop app instead.
set "MODE="
set "MODEFILE=%TEMP%\yuedu-server-mode.txt"
del "%MODEFILE%" >nul 2>&1
powershell -NoProfile -NonInteractive -Command "$r=$null; try{$r=Invoke-RestMethod 'http://127.0.0.1:%PORT%/api/system/identity' -TimeoutSec 2}catch{}; if($r){Set-Content -Path '%MODEFILE%' -Value $r.mode -Encoding ASCII}" >nul 2>&1
if exist "%MODEFILE%" set /p MODE=<"%MODEFILE%"
del "%MODEFILE%" >nul 2>&1
if /i "%MODE%"=="desktop" goto :desktopport

set "OWN_PID="
if exist "%YUEDU_DATA_DIR%\server.pid" (
  for /f "usebackq delims=" %%J in ("%YUEDU_DATA_DIR%\server.pid") do (
    echo %%J | findstr /r /c:"\"pid\": *%BUSY_PID%[,} ]" >nul && set "OWN_PID=%BUSY_PID%"
  )
)

if not defined OWN_PID goto :unknownpid
echo [YueDu] That listener IS this project's own server, started earlier.
echo [YueDu] It may have no visible window - e.g. started by the in-app Restart button.
echo [YueDu] (closing that cmd window would NOT kill it; that is the trap you hit before)
echo.
choice /c YN /n /m "[YueDu] Stop pid %BUSY_PID% and start a fresh server now? (Y/N) "
if errorlevel 2 goto :abandon
echo [YueDu] Stopping pid %BUSY_PID% ...
taskkill /PID %BUSY_PID% /F /T >nul 2>&1
for /l %%I in (1,1,20) do (
  netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1 || goto :portfree
  ping -n 2 127.0.0.1 >nul
)
:portfree
goto :portok

rem ---- #242 fallthrough: port taken but server.pid cannot prove ownership -------
rem This happens when the listener was started by an OLD build (before server.pid
rem existed). We must NOT auto-kill: the listener may be someone else's program.
rem So ask, and state plainly what we could and could not verify.
:desktopport
echo.
echo [YueDu] Port %PORT% is managed by the DESKTOP app (identity mode=desktop).
echo [YueDu] Refusing to kill it: the desktop watchdog would restart it anyway.
echo [YueDu] Please quit YueDu.exe (client or --server-only) first, then run this again.
echo.
pause
exit /b 1

:unknownpid
echo [YueDu] No matching record in data\server.pid, so ownership is UNCONFIRMED.
echo [YueDu] That is expected if the old server was started before this feature.
echo.
choice /c YN /n /m "[YueDu] Kill pid %BUSY_PID% and start anyway? (Y/N) "
if errorlevel 2 goto :abandon
echo [YueDu] Stopping pid %BUSY_PID% ...
taskkill /PID %BUSY_PID% /F /T >nul 2>&1
for /l %%I in (1,1,20) do (
  netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1 || goto :portfree
  ping -n 2 127.0.0.1 >nul
)
goto :portfree

:abandon
echo.
echo [YueDu] Aborted. The existing server keeps running.
echo [YueDu] If it is yours, just open http://127.0.0.1:%PORT%
echo.
pause
exit /b 1

:portok

set YUEDU_SERVER_DIR=F:\yuedu_PC\apps\desktop

rem ---- #787: CPU priority for the server-side node ---------------------
rem #786 proved the node main thread spent ~92% of wall time as READY
rem (runnable, never scheduled) on a 4-core box that was ~100% busy with
rem msedge + Trae CN: node got only ~2% of the CPU. This switch gives the
rem server a slightly larger share WITHOUT touching engine code.
rem
rem How to revert: delete the "if not defined" line below (or set the
rem value to off / empty) => start-server.bat runs node directly again,
rem exactly like before #787.
rem
rem   YUEDU_CPU_PRIORITY  off | normal | above | high
rem      default: above (ABOVE_NORMAL_PRIORITY_CLASS). AboveNormal wins
rem      against normal-class foreground apps (msedge/IDE) but stays
rem      below High, so UI + system threads are not starved back.
rem
rem The limit goes through a Windows Job object (scripts\run-node-cpu.ps1)
rem => the batch-child / DOM worker node processes that the server forks
rem carry the same priority class as well.
rem (#788: CPU affinity was measured to give no gain and was removed.)
rem Optional first argument overrides the priority switch (handy for A/B):
rem   start-server.bat off      /  start-server.bat above
if not "%~1"=="" set "YUEDU_CPU_PRIORITY=%~1"
if not defined YUEDU_CPU_PRIORITY set "YUEDU_CPU_PRIORITY=above"
set "YUEDU_CPU_LAUNCH=0"
if defined YUEDU_CPU_PRIORITY if /i not "%YUEDU_CPU_PRIORITY%"=="off" set "YUEDU_CPU_LAUNCH=1"
rem ---- source store (#651) ------------------------------------------
rem Sources live in ONE place now: data\yuedu.db (table sources).
rem There is NO source directory any more: YUEDU_BOOK_DIR / YUEDU_CMS_DIR
rem are retired (data\sources + tests\fixtures\sources were both deleted).
rem Lookup from a shell:  npx tsx scripts\src.mts find <source-name>
rem cookies.json lives next to the DB; only set when not already provided.
if not defined YUEDU_COOKIES_FILE set "YUEDU_COOKIES_FILE=%YUEDU_DATA_DIR%\cookies.json"
rem TOC concurrency: code default is 4 (#761). `auto` stays an explicit
rem experiment switch only: set YUEDU_TOC_CONC=auto here to try it.
rem NOTE: the web dist dir (apps/web/dist) is auto-detected by the server
rem (source layout / bundle layout / electron web-dist), so YUEDU_WEB_DIST
rem is no longer needed here. Only set it if the dist lives elsewhere.

echo.
echo [YueDu] node    = %NODE%
if not "%YUEDU_CPU_LAUNCH%"=="1" echo [YueDu] cpu     = untouched (no priority override)
if "%YUEDU_CPU_LAUNCH%"=="1" echo [YueDu] cpu     = priority=%YUEDU_CPU_PRIORITY% (job object; child processes inherit)
echo [YueDu] data    = %YUEDU_DATA_DIR%
echo [YueDu] serving = http://127.0.0.1:%PORT%
echo [YueDu] (closing this window stops the server)
echo.

rem ---- #246: run node in a LOOP, so "Restart" happens in THIS window ----------
rem Why: the server used to spawn a detached, window-less replacement itself. That
rem left the user with NO console at all -- the old process exited, bat hit its
rem trailing "pause", the user pressed a key and the window closed, while the new
rem server kept running invisibly. (And bat's own header line "closing this window
rem stops the server" stopped being true, which is how the user got stuck before.)
rem Now the server exits with code 42 when it wants a restart, and we relaunch it
rem here => console + logs stay visible, no orphan process, and closing this
rem window really does stop the server.
set "YUEDU_RESTART_BY_SHELL=1"
:run
rem #830: re-assert UTF-8 on EVERY iteration. chcp is a console property, not an
rem env var; a relaunch that goes through a fresh console / resetting host loses
rem it, and then the log sink's raw UTF-8 bytes render as GBK mojibake.
rem (run-node-cpu.ps1 also asserts SetConsoleOutputCP(65001) right before node.)
chcp 65001 >nul
if not "%YUEDU_CPU_LAUNCH%"=="1" goto :runplain
rem #787: launched through the job-object helper so priority also covers
rem the node children the server forks. Exit code still propagates.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "F:\yuedu_PC\scripts\run-node-cpu.ps1" -Node "%NODE%" -NodeArgs "--max-old-space-size=4096 apps\desktop\server-bundle.mjs" -Priority "%YUEDU_CPU_PRIORITY%"
goto :randone
:runplain
"%NODE%" --max-old-space-size=4096 apps\desktop\server-bundle.mjs
:randone
set "RC=%ERRORLEVEL%"
if "%RC%"=="42" (
  echo.
  echo [YueDu] server asked for a restart ^(exit 42^) - relaunching in this window...
  echo.
  goto :run
)
echo.
echo [YueDu] server exited with code %RC%.
pause
