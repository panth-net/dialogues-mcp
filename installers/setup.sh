#!/usr/bin/env sh
# Dialogues installer for macOS and Linux.
#   sh installers/setup.sh <app> [--from-checkout | --tarball <file>] [--data-dir <folder>]
# <app>: claude-desktop, claude-code, codex, cursor, vscode, antigravity (or "all" to connect every detected app)
# Default installs the released package from npm. --from-checkout builds this folder;
# --tarball installs a package file made with `npm pack`.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CLIENT="${1:-}"
MODE="npm"
TARBALL=""
DATA_DIR=""
if [ "$#" -gt 0 ]; then shift; fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from-checkout) MODE="checkout" ;;
    --tarball) MODE="tarball"; TARBALL="${2:-}"; shift ;;
    --data-dir) DATA_DIR="${2:-}"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$CLIENT" ] && [ -t 0 ]; then
  echo "Which app do you want to connect to Dialogues?"
  echo "1. Claude Desktop (macOS)"
  echo "2. Claude Code"
  echo "3. Codex"
  echo "4. Cursor"
  echo "5. VS Code"
  echo "6. Antigravity"
  printf "Type a number, then press Enter: "
  read choice
  case "$choice" in
    1) CLIENT="claude-desktop" ;;
    2) CLIENT="claude-code" ;;
    3) CLIENT="codex" ;;
    4) CLIENT="cursor" ;;
    5) CLIENT="vscode" ;;
    6) CLIENT="antigravity" ;;
  esac
fi

case "$CLIENT" in
  claude-desktop|claude-code|codex|cursor|vscode|antigravity|all) ;;
  *)
    echo "Choose the app to connect, for example:"
    echo "  sh installers/setup.sh claude-code"
    echo "Apps: claude-desktop, claude-code, codex, cursor, vscode, antigravity"
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js 22.16 or newer from https://nodejs.org, then run this again."
  exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)" >/dev/null 2>&1; then
  echo "Your Node.js is $(node --version). Dialogues needs Node.js 22.16 or newer. Install it from https://nodejs.org, then run this again."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required (it comes with Node.js). Reinstall Node.js from https://nodejs.org, then run this again."
  exit 1
fi

npm_global_install() {
  if ! npm install -g "$1"; then
    echo ""
    echo "npm could not install Dialogues."
    echo "- If the message mentions EACCES or permission denied, npm cannot write to its global folder."
    echo "  Fix npm's global folder (https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally)"
    echo "  rather than using sudo, then run this again."
    echo "- If it mentions ENOTFOUND, ETIMEDOUT, or the registry, check your internet connection and try again."
    exit 1
  fi
}

case "$MODE" in
  npm)
    echo "Installing dialogues-mcp from npm..."
    npm_global_install dialogues-mcp
    ;;
  checkout)
    echo "Building Dialogues from $ROOT_DIR..."
    cd "$ROOT_DIR"
    if [ -f package-lock.json ]; then npm ci; else npm install; fi
    npm run build
    PACK_DIR=$(mktemp -d)
    npm pack --pack-destination "$PACK_DIR" >/dev/null
    npm_global_install "$(ls "$PACK_DIR"/dialogues-mcp-*.tgz)"
    rm -rf "$PACK_DIR"
    ;;
  tarball)
    if [ ! -f "$TARBALL" ]; then echo "Package file not found: $TARBALL"; exit 1; fi
    npm_global_install "$TARBALL"
    ;;
esac

PREFIX=$(npm prefix -g)
DIALOGUES="$PREFIX/bin/dialogues"
if [ ! -x "$DIALOGUES" ]; then DIALOGUES="dialogues"; fi

if [ "$CLIENT" = "all" ]; then
  set -- setup --all
else
  set -- setup --client "$CLIENT"
fi
if [ -n "$DATA_DIR" ]; then set -- "$@" --data-dir "$DATA_DIR"; fi
"$DIALOGUES" "$@"

echo ""
echo "No document collections were downloaded."
echo "Next: fully quit and reopen the app you connected, then send:"
echo "  Hi! I want to use Dialogues. Show me the document collections, recommend where to start, and help me choose."
