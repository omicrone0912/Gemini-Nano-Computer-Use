@echo off
chcp 65001 >nul
setlocal EnableExtensions
set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=qwen2.5vl:3b"
title Gemini Nano Computer Use - Qwen 2.5 VL 1-Step Installer
echo ============================================================
echo  Qwen 2.5 VL (Ollama) 1-Step Setup for Chrome Extension
echo  Target Model: %MODEL%
echo ============================================================
echo.
set "OLLAMA_EXE=ollama"
where ollama >nul 2>&1
if errorlevel 1 (
  if exist "%LocalAppData%\Programs\Ollama\ollama.exe" (
    set "OLLAMA_EXE=%LocalAppData%\Programs\Ollama\ollama.exe"
  )
)
if "%OLLAMA_EXE%"=="ollama" (
  where ollama >nul 2>&1
  if errorlevel 1 (
    echo [1/4] Installing Ollama locally...
    where winget >nul 2>&1
    if not errorlevel 1 (
      winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements --silent
    )
    if exist "%LocalAppData%\Programs\Ollama\ollama.exe" (
      set "OLLAMA_EXE=%LocalAppData%\Programs\Ollama\ollama.exe"
    ) else (
      echo Downloading official OllamaSetup.exe...
      powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri https://ollama.com/download/OllamaSetup.exe -OutFile ($env:TEMP + '\OllamaSetup.exe')"
      "%TEMP%\OllamaSetup.exe" /VERYSILENT /NORESTART
      if exist "%LocalAppData%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LocalAppData%\Programs\Ollama\ollama.exe"
    )
  ) else (
    echo [1/4] Ollama is already installed.
  )
) else (
  echo [1/4] Ollama is already installed.
)
echo [2/4] Allowing Chrome extension origin (OLLAMA_ORIGINS)...
setx OLLAMA_ORIGINS "chrome-extension://*,http://localhost:*,http://127.0.0.1:*" >nul
set "OLLAMA_ORIGINS=chrome-extension://*,http://localhost:*,http://127.0.0.1:*"
echo [3/4] Restarting local Ollama service...
taskkill /IM ollama.exe /F >nul 2>&1
taskkill /IM "ollama app.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "%OLLAMA_EXE%" serve
timeout /t 4 /nobreak >nul
echo [4/4] Downloading %MODEL% (this may take a few minutes)...
"%OLLAMA_EXE%" pull %MODEL%
if errorlevel 1 (
  echo.
  echo [ERROR] Model download failed. Make sure internet connection is active and try again.
  pause
  exit /b 1
)
echo.
echo ============================================================
echo  Setup Complete! %MODEL% is ready.
echo  Return to Chrome side panel and click "再確認" (or wait 4s).
echo ============================================================
pause
