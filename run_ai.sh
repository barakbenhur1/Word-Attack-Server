#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./run_ai.sh --local /path/to/wordzap.onnx /path/to/tokenizer.json [--port 3000]
#   ./run_ai.sh --url   https://.../wordzap.int8.onnx https://.../tokenizer.json [--port 3000]
#
# Optional:
#   export GITHUB_TOKEN=...     # only if URLs are private
#   export START_CMD="node app.js"
#   export ORT_BACKEND=node|wasm   (default: node)
#   export AI_MAX_CONCURRENCY=1    (default: 1)
#
# Notes:
# - Run this from Word-Attack-Server (where app.js lives)
# - Script will create /tmp/models and configure envs for the server

PORT=3000
MODE=""
MODEL_ARG=""
TOKEN_ARG=""

while (( "$#" )); do
  case "$1" in
    --local)
      MODE="local"; MODEL_ARG="$2"; TOKEN_ARG="$3"; shift 3;;
    --url)
      MODE="url"; MODEL_ARG="$2"; TOKEN_ARG="$3"; shift 3;;
    --port)
      PORT="$2"; shift 2;;
    *)
      echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

if [[ -z "${MODE}" ]]; then
  echo "Usage:"
  echo "  ./run_ai.sh --local /path/to/wordzap.onnx /path/to/tokenizer.json [--port 3000]"
  echo "  ./run_ai.sh --url   https://.../wordzap.int8.onnx https://.../tokenizer.json [--port 3000]"
  exit 1
fi

# --- sanity: server folder ---
if [[ ! -f app.js ]]; then
  echo "Error: run this inside Word-Attack-Server (app.js not found)." >&2
  exit 1
fi

# --- where models live locally ---
MODEL_DIR="/tmp/models"
mkdir -p "$MODEL_DIR"

MODEL_NAME="wordzap.onnx"
TOKENIZER_NAME="tokenizer.json"
MODEL_PATH="${MODEL_DIR}/${MODEL_NAME}"
TOKENIZER_PATH="${MODEL_DIR}/${TOKENIZER_NAME}"

# --- prepare according to mode ---
if [[ "$MODE" == "local" ]]; then
  if [[ ! -f "$MODEL_ARG" || ! -f "$TOKEN_ARG" ]]; then
    echo "Local files not found: $MODEL_ARG / $TOKEN_ARG" >&2
    exit 1
  fi
  cp -f "$MODEL_ARG"     "$MODEL_PATH"
  cp -f "$TOKEN_ARG"     "$TOKENIZER_PATH"
  export MODEL_LOAD_MODE="disk"
  unset MODEL_URL_MODEL MODEL_URL_TOKENIZER
  echo "[run_ai] Using DISK mode with files in /tmp/models"
else
  # URL mode
  export MODEL_URL_MODEL="$MODEL_ARG"
  export MODEL_URL_TOKENIZER="$TOKEN_ARG"
  export MODEL_LOAD_MODE="auto"    # downloads to disk if missing
  echo "[run_ai] Using URL mode (auto download)"
fi

# --- runtime tuning (safe defaults for low RAM) ---
export PORT="${PORT}"
export MODEL_DIR="${MODEL_DIR}"
export MODEL_NAME="${MODEL_NAME}"
export TOKENIZER_NAME="${TOKENIZER_NAME}"
export ORT_BACKEND="${ORT_BACKEND:-node}"        # node(native) or wasm
export AI_MAX_CONCURRENCY="${AI_MAX_CONCURRENCY:-1}"
export ORT_INTRA_OP_NUM_THREADS="${ORT_INTRA_OP_NUM_THREADS:-1}"
export ORT_INTER_OP_NUM_THREADS="${ORT_INTER_OP_NUM_THREADS:-1}"
export ORT_DISABLE_MEMORY_ARENA="${ORT_DISABLE_MEMORY_ARENA:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=420}"

echo "[run_ai] ENV:"
echo "  PORT=$PORT"
echo "  MODEL_LOAD_MODE=$MODEL_LOAD_MODE"
echo "  ORT_BACKEND=$ORT_BACKEND"
echo "  MODEL_DIR=$MODEL_DIR"
echo "  MODEL_URL_MODEL=${MODEL_URL_MODEL:-<none>}"
echo "  MODEL_URL_TOKENIZER=${MODEL_URL_TOKENIZER:-<none>}"
echo "  AI_MAX_CONCURRENCY=$AI_MAX_CONCURRENCY"

# --- start server in background ---
START_CMD="${START_CMD:-node app.js}"
echo "[run_ai] Starting: $START_CMD"
($START_CMD > server.log 2>&1) & S_PID=$!

cleanup() {
  echo "[run_ai] Stopping server (pid $S_PID)"
  kill "$S_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- wait for health ---
echo -n "[run_ai] Waiting for /ai/_ping"
for i in {1..60}; do
  if curl -s --max-time 1 "http://localhost:${PORT}/ai/_ping" >/dev/null; then
    echo " ✓"
    break
  fi
  echo -n "."
  sleep 1
  if ! ps -p "$S_PID" >/dev/null; then
    echo
    echo "[run_ai] Server exited unexpectedly. Last 50 log lines:"
    tail -n 50 server.log || true
    exit 1
  fi
  if [[ $i -eq 60 ]]; then
    echo
    echo "[run_ai] Timeout waiting for server. Last 50 log lines:"
    tail -n 50 server.log || true
    exit 1
  fi
done

# optional: warm the model (full=1 forces init)
echo "[run_ai] Warming model..."
curl -s "http://localhost:${PORT}/ai/health?full=1" | sed 's/.*/[health] &/'

# smoke tests
echo "[run_ai] Test EN opener:"
curl -s -X POST "http://localhost:${PORT}/ai/aiGuess" \
  -H 'Content-Type: application/json' \
  -d '{"history":[],"lang":"en","difficulty":"medium"}' | sed 's/.*/[en] &/'

echo "[run_ai] Test HE opener:"
curl -s -X POST "http://localhost:${PORT}/ai/aiGuess" \
  -H 'Content-Type: application/json' \
  -d '{"history":[],"lang":"he","difficulty":"medium"}' | sed 's/.*/[he] &/'

echo
echo "[run_ai] All good. Tail logs with: tail -f server.log"
wait "$S_PID"
