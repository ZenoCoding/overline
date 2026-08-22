#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/transcribe-openai.sh /path/to/link-click-excerpt.webm" >&2
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
