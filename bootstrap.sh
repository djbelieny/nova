#!/usr/bin/env bash
# Nova Bootstrap — sets up prerequisites and launches the AI installer
# Usage: git clone <repo> nova && cd nova && bash bootstrap.sh

set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}  Nova Bootstrap${NC}"
echo "  ─────────────────────────────────"
echo ""

# ── 1. Detect OS ────────────────────────────────────────────────
OS="$(uname -s)"
echo "  OS: $OS"

# ── 2. Install Bun if missing ────────────────────────────────────
if ! command -v bun &>/dev/null; then
  echo ""
  echo -e "  ${YELLOW}Installing Bun...${NC}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo -e "  ${GREEN}✓ Bun installed${NC}"
else
  echo -e "  ${GREEN}✓ Bun: $(bun --version)${NC}"
fi

# ── 3. Install Python if missing (for Memwright) ─────────────────
if ! command -v python3 &>/dev/null; then
  echo ""
  echo -e "  ${YELLOW}Python 3 not found.${NC}"
  if [[ "$OS" == "Darwin" ]]; then
    echo "  Install via Homebrew: brew install python3"
  else
    echo "  Install via: sudo apt-get install -y python3 python3-pip python3-venv"
  fi
  echo "  Then re-run bootstrap.sh"
  exit 1
else
  echo -e "  ${GREEN}✓ Python: $(python3 --version)${NC}"
fi

# ── 4. Install Node deps ──────────────────────────────────────────
echo ""
echo "  Installing dependencies..."
bun install --silent
echo -e "  ${GREEN}✓ Dependencies installed${NC}"

# ── 5. Install Memwright Python deps ─────────────────────────────
if [[ ! -d ".venv-memwright" ]]; then
  echo ""
  echo "  Setting up Memwright (memory service)..."
  python3 -m venv .venv-memwright
  .venv-memwright/bin/pip install --quiet "agent-memory-server[all]"
  echo -e "  ${GREEN}✓ Memwright installed${NC}"
else
  echo -e "  ${GREEN}✓ Memwright venv exists${NC}"
fi

# ── 6. Detect AI CLI ──────────────────────────────────────────────
AI_CLI=""
if command -v claude &>/dev/null; then
  AI_CLI="claude"
elif command -v codex &>/dev/null; then
  AI_CLI="codex"
elif command -v gemini &>/dev/null; then
  AI_CLI="gemini"
fi

echo ""
echo "  ─────────────────────────────────"

if [[ -z "$AI_CLI" ]]; then
  echo -e "  ${RED}No AI CLI found.${NC}"
  echo ""
  echo "  Install one of:"
  echo "    Claude Code:  npm install -g @anthropic-ai/claude-code"
  echo "    Codex:        npm install -g @openai/codex"
  echo "    Gemini CLI:   npm install -g @google-ai/gemini-cli"
  echo ""
  echo "  Then run: bash bootstrap.sh"
  exit 1
fi

echo -e "  ${GREEN}✓ AI CLI: $AI_CLI${NC}"
echo ""
echo "  Ready to install. Starting the AI-guided setup..."
echo ""

# ── 7. Launch installer ───────────────────────────────────────────
INSTALL_CMD=""
if [[ "$AI_CLI" == "claude" ]]; then
  INSTALL_CMD='claude "Read INSTALLER.md and follow it exactly to set up Nova for this user."'
elif [[ "$AI_CLI" == "codex" ]]; then
  INSTALL_CMD='codex "Read INSTALLER.md and follow it exactly to set up Nova for this user."'
elif [[ "$AI_CLI" == "gemini" ]]; then
  INSTALL_CMD='gemini "Read INSTALLER.md and follow it exactly to set up Nova for this user."'
fi

echo -e "  Run this command to start the installer:\n"
echo -e "  ${BLUE}$INSTALL_CMD${NC}"
echo ""
echo "  Or press Enter to launch it now (Ctrl+C to cancel):"
read -r _
eval "$INSTALL_CMD"
