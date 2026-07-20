#!/usr/bin/env bash
# Nova Bootstrap — installs prerequisites and launches the setup wizard.
# Usage:
#   git clone <repo> nova && cd nova && bash bootstrap.sh
#   bash bootstrap.sh --check    # detect everything, change nothing (CI-safe)

set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

CHECK=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
  esac
done

echo ""
if [[ "$CHECK" == "1" ]]; then
  echo -e "${BLUE}  Nova Bootstrap — preflight check (no changes)${NC}"
else
  echo -e "${BLUE}  Nova Bootstrap${NC}"
fi
echo "  ─────────────────────────────────"
echo ""

# ── 1. Detect OS (and reject bare Windows shells) ────────────────
OS="$(uname -s)"
echo "  OS: $OS"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    echo ""
    echo -e "  ${RED}Windows shells (Git Bash / MSYS / Cygwin) aren't supported.${NC}"
    echo "  Nova runs great on Windows via WSL2:"
    echo "    1. Open PowerShell as Administrator and run:  wsl --install"
    echo "    2. Reboot, open 'Ubuntu' from the Start menu."
    echo "    3. Inside Ubuntu, re-run this installer."
    exit 1
    ;;
esac

# ── helper: report presence in --check mode, install otherwise ───
have() { command -v "$1" &>/dev/null; }

# ── 2. Bun ───────────────────────────────────────────────────────
if have bun; then
  echo -e "  ${GREEN}✓ Bun: $(bun --version)${NC}"
elif [[ "$CHECK" == "1" ]]; then
  echo -e "  ${YELLOW}! Bun: not found (would install from bun.sh)${NC}"
else
  echo -e "  ${YELLOW}Installing Bun...${NC}"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  echo -e "  ${GREEN}✓ Bun installed${NC}"
fi

# ── 3. Python (for Memwright memory service) ─────────────────────
if have python3; then
  echo -e "  ${GREEN}✓ Python: $(python3 --version 2>&1)${NC}"
else
  echo -e "  ${YELLOW}! Python 3: not found${NC}"
  if [[ "$OS" == "Darwin" ]]; then echo "    Install: brew install python3";
  else echo "    Install: sudo apt-get install -y python3 python3-pip python3-venv"; fi
  [[ "$CHECK" == "1" ]] || { echo "  Then re-run bootstrap.sh"; exit 1; }
fi

# ── 4. Claude Code CLI (Nova's default brain) ────────────────────
if have claude; then
  echo -e "  ${GREEN}✓ Claude Code CLI: found${NC}"
elif have codex || have gemini; then
  echo -e "  ${GREEN}✓ AI CLI: $(have codex && echo codex || echo gemini) found${NC}"
elif [[ "$CHECK" == "1" ]]; then
  echo -e "  ${YELLOW}! Claude Code CLI: not found (would install)${NC}"
else
  echo -e "  ${YELLOW}Installing Claude Code CLI...${NC}"
  if curl -fsSL https://claude.ai/install.sh | bash; then
    export PATH="$HOME/.local/bin:$PATH"
    echo -e "  ${GREEN}✓ Claude Code installed${NC}"
  elif have npm && npm install -g @anthropic-ai/claude-code; then
    echo -e "  ${GREEN}✓ Claude Code installed (via npm)${NC}"
  else
    echo -e "  ${RED}Could not install Claude Code automatically.${NC}"
    echo "    Install it manually: npm install -g @anthropic-ai/claude-code"
    echo "    Then re-run bootstrap.sh"
    exit 1
  fi
fi

# ── 5. In --check mode we stop here (no mutations) ───────────────
if [[ "$CHECK" == "1" ]]; then
  echo ""
  echo -e "  ${GREEN}Preflight complete — no changes made.${NC}"
  echo "  Run 'bash bootstrap.sh' to install and set up Nova."
  exit 0
fi

# ── 6. Install dependencies ──────────────────────────────────────
echo ""
echo "  Installing dependencies..."
bun install --silent
echo -e "  ${GREEN}✓ Dependencies installed${NC}"

if [[ ! -d ".venv-memwright" ]] && have python3; then
  echo "  Setting up Memwright (memory service)..."
  python3 -m venv .venv-memwright
  .venv-memwright/bin/pip install --quiet "agent-memory-server[all]" || \
    echo -e "  ${YELLOW}! Memwright deps skipped (optional).${NC}"
  echo -e "  ${GREEN}✓ Memwright ready${NC}"
fi

# ── 7. Launch the setup wizard ───────────────────────────────────
echo ""
echo "  ─────────────────────────────────"
echo -e "  ${GREEN}Prerequisites ready.${NC} Starting the Nova setup wizard..."
echo ""
if [[ -t 0 ]]; then
  bun run init
  echo ""
  echo -e "  Done! Start Nova with:  ${BLUE}bun run start${NC}"
else
  # No interactive terminal (e.g. piped). Tell the user how to finish.
  echo "  Finish setup by running:"
  echo -e "    ${BLUE}bun run init${NC}     # guided setup wizard"
  echo -e "    ${BLUE}bun run start${NC}    # start Nova"
fi
