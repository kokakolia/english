@echo off
setlocal
cd /d "%~dp0app"
where node >nul 2>&1
if errorlevel 1 goto missing
where npm >nul 2>&1
if errorlevel 1 goto missing
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)"
if errorlevel 1 goto missing
if not exist node_modules\.package-lock.json (
  echo Installing dependencies from package-lock.json...
  call npm ci
  if errorlevel 1 goto error
)
echo Building and opening http://localhost:5173...
call npm start
if errorlevel 1 goto error
exit /b 0

:missing
echo Node.js 22.12+ and npm are required. Install Node.js and try again.
goto error

:error
echo Startup failed. See the error above.
pause
exit /b 1
