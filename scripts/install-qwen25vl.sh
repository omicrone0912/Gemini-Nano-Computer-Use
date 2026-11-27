#!/usr/bin/env bash
set -euo pipefail

MODEL="${1:-qwen2.5vl:3b}"
echo "=== Gemini Nano Computer Use - Qwen 2.5 VL 1-Step Installer ($MODEL) ==="

if ! command -v ollama >/dev/null 2>&1; then
  echo "[1/4] Installing Ollama locally..."
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1; then
    brew install --cask ollama || brew install ollama
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
else
  echo "[1/4] Ollama is already installed."
fi

echo "[2/4] Configuring OLLAMA_ORIGINS for Chrome extension..."
export OLLAMA_ORIGINS="chrome-extension://*,http://localhost:*,http://127.0.0.1:*"
if [[ "$(uname -s)" == "Darwin" ]] && command -v launchctl >/dev/null 2>&1; then
  launchctl setenv OLLAMA_ORIGINS "$OLLAMA_ORIGINS" || true
fi

echo "[3/4] Starting Ollama service..."
pkill -x ollama >/dev/null 2>&1 || true
sleep 1
nohup ollama serve >/tmp/ollama-nano-cu.log 2>&1 &
sleep 3

echo "[4/4] Pulling $MODEL..."
ollama pull "$MODEL"

echo "Setup Complete! $MODEL is ready. Return to the Chrome side panel."
