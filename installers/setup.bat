@echo off
rem Dialogues installer for Windows.
rem   installers\setup.bat <app> [--from-checkout ^| --tarball <file>] [--data-dir <folder>]
rem <app>: claude-desktop, claude-code, codex, cursor, vscode, antigravity (or "all" for every detected app)
rem Default installs the released package from npm. --from-checkout builds this folder;
rem --tarball installs a package file made with "npm pack".
setlocal enabledelayedexpansion
set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."
set "CLIENT=%~1"
set "MODE=npm"
set "TARBALL="
set "DATA_DIR="
rem The first argument is always the app (possibly empty).
shift

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--from-checkout" (
  set "MODE=checkout"
  shift
  goto parse
)
if /i "%~1"=="--tarball" (
  set "MODE=tarball"
  set "TARBALL=%~2"
  shift
  shift
  goto parse
)
if /i "%~1"=="--data-dir" (
  set "DATA_DIR=%~2"
  shift
  shift
  goto parse
)
echo Unknown option: %~1
exit /b 1
:parsed

if "%CLIENT%"=="" (
  echo Which app do you want to connect to Dialogues?
  echo 1. Claude Desktop
  echo 2. Claude Code
  echo 3. Codex
  echo 4. Cursor
  echo 5. VS Code
  echo 6. Antigravity
  set "CHOICE="
  set /p CHOICE="Type a number, then press Enter: "
  if "!CHOICE!"=="1" set "CLIENT=claude-desktop"
  if "!CHOICE!"=="2" set "CLIENT=claude-code"
  if "!CHOICE!"=="3" set "CLIENT=codex"
  if "!CHOICE!"=="4" set "CLIENT=cursor"
  if "!CHOICE!"=="5" set "CLIENT=vscode"
  if "!CHOICE!"=="6" set "CLIENT=antigravity"
)

set "VALID="
for %%C in (claude-desktop claude-code codex cursor vscode antigravity all) do if /i "%CLIENT%"=="%%C" set "VALID=1"
if not defined VALID (
  echo Choose the app to connect, for example:
  echo   installers\setup.bat claude-code
  echo Apps: claude-desktop, claude-code, codex, cursor, vscode, antigravity
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22.16 or newer from https://nodejs.org, then run this again.
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Your Node.js is too old. Dialogues needs Node.js 22.16 or newer. Install it from https://nodejs.org, then run this again.
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required ^(it comes with Node.js^). Reinstall Node.js from https://nodejs.org, then run this again.
  exit /b 1
)

if "%MODE%"=="npm" (
  echo Installing dialogues-mcp from npm...
  call npm install -g dialogues-mcp
  if errorlevel 1 goto npmfailed
)
if "%MODE%"=="checkout" (
  echo Building Dialogues from %ROOT_DIR%...
  pushd "%ROOT_DIR%" >nul
  if exist package-lock.json (call npm ci) else (call npm install)
  if errorlevel 1 exit /b 1
  call npm run build
  if errorlevel 1 exit /b 1
  set "PACK_DIR=%TEMP%\dialogues-pack-%RANDOM%%RANDOM%"
  mkdir "!PACK_DIR!"
  call npm pack --pack-destination "!PACK_DIR!" >nul
  if errorlevel 1 exit /b 1
  for %%F in ("!PACK_DIR!\dialogues-mcp-*.tgz") do set "TARBALL=%%~fF"
  popd >nul
  call npm install -g "!TARBALL!"
  if errorlevel 1 goto npmfailed
  rmdir /s /q "!PACK_DIR!"
)
if "%MODE%"=="tarball" (
  if not exist "%TARBALL%" (
    echo Package file not found: %TARBALL%
    exit /b 1
  )
  call npm install -g "%TARBALL%"
  if errorlevel 1 goto npmfailed
)

for /f "delims=" %%P in ('npm prefix -g') do set "PREFIX=%%P"
set "DIALOGUES=%PREFIX%\dialogues.cmd"
if not exist "%DIALOGUES%" set "DIALOGUES=dialogues"

set "SETUP_ARGS=setup --client %CLIENT%"
if /i "%CLIENT%"=="all" set "SETUP_ARGS=setup --all"
if defined DATA_DIR (
  call "%DIALOGUES%" %SETUP_ARGS% --data-dir "%DATA_DIR%"
) else (
  call "%DIALOGUES%" %SETUP_ARGS%
)
if errorlevel 1 exit /b 1

echo.
echo No document collections were downloaded.
echo Next: fully quit and reopen the app you connected, then send:
echo   Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose.
endlocal
exit /b 0

:npmfailed
echo.
echo npm could not install Dialogues.
echo - If the message mentions EPERM or access denied, close programs using Node.js and try again, or fix npm's global folder permissions.
echo - If it mentions ENOTFOUND, ETIMEDOUT, or the registry, check your internet connection and try again.
exit /b 1
