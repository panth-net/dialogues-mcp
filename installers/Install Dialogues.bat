@echo off
rem Double-click installer: builds this downloaded folder and connects one app.
set SCRIPT_DIR=%~dp0
call "%SCRIPT_DIR%setup.bat" "" --from-checkout
if errorlevel 1 (
  echo.
  echo Setup did not finish. Read the message above for what to do next.
)
echo.
pause
