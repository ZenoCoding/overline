#!/bin/bash
set -euo pipefail

if [[ -z "${OPENAI_API_KEY:-}" && -f "$(dirname "$0")/../.env" ]]; then
  export OPENAI_API_KEY="$(grep -E '^OPENAI_API_KEY=' "$(dirname "$0")/../.env" | cut -d= -f2- | tr -d '\r\n"' | tr -d "'")"
fi

if [[ "${1:-}" == "--validate-only" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "Usage: scripts/transcribe-openai.sh --validate-only /path/to/link-click-excerpt.webm" >&2
    exit 2
  fi
  exec node "$(dirname "$0")/transcribe-openai.mjs" --validate-only "$2"
fi

if [[ "${1:-}" == "--preflight" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "Usage: scripts/transcribe-openai.sh --preflight /path/to/link-click-excerpt.webm" >&2
    exit 2
  fi
  if [[ -n "${OPENAI_API_KEY:-}" ]]; then
    exec node "$(dirname "$0")/transcribe-openai.mjs" --preflight "$2"
  fi
  read -r -s -p "OpenAI API key (input hidden; kept only for this process): " session_key
  echo
  if [[ -z "$session_key" ]]; then
    echo "No key entered; preflight cancelled." >&2
    exit 3
  fi
  trap 'unset session_key' EXIT
  OPENAI_API_KEY="$session_key" node "$(dirname "$0")/transcribe-openai.mjs" --preflight "$2"
  exit $?
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/transcribe-openai.sh [--validate-only|--preflight] /path/to/link-click-excerpt.webm" >&2
  exit 2
fi

if [[ -n "${OPENAI_API_KEY:-}" ]]; then
  exec node "$(dirname "$0")/transcribe-openai.mjs" "$1"
fi

read -r -s -p "OpenAI API key (input hidden; kept only for this process): " session_key
echo
if [[ -z "$session_key" ]]; then
  echo "No key entered; transcription cancelled." >&2
  exit 3
fi

trap 'unset session_key' EXIT
OPENAI_API_KEY="$session_key" node "$(dirname "$0")/transcribe-openai.mjs" "$1"
