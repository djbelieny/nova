#!/bin/bash
set -euo pipefail

# ============================================================
# Nova Setup Wizard
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

ENV_FILE="$PROJECT_DIR/.env"

# ---- Color helpers ----
if command -v tput &>/dev/null && tput setaf 1 &>/dev/null; then
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1)
  RESET=$(tput sgr0)
  BOLD=$(tput bold)
else
  GREEN="" YELLOW="" RED="" RESET="" BOLD=""
fi

info()    { echo "${GREEN}${BOLD}$*${RESET}"; }
warn()    { echo "${YELLOW}WARNING: $*${RESET}"; }
error()   { echo "${RED}ERROR: $*${RESET}" >&2; }
die()     { error "$*"; exit 1; }

# ---- Load existing .env if present ----
load_env() {
  if [ -f "$ENV_FILE" ]; then
    # Source .env safely (skip comments and empty lines)
    set -a
    # shellcheck disable=SC1090
    source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$') 2>/dev/null || true
    set +a
  fi
}

# ---- Get env value with fallback ----
get_env() {
  local var="$1"
  local default="${2:-}"
  local val="${!var:-$default}"
  echo "$val"
}

# ---- Write or update a variable in .env ----
set_env() {
  local key="$1"
  local value="$2"
  if [ -f "$ENV_FILE" ] && grep -q "^${key}=" "$ENV_FILE"; then
    # Update existing line
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

# ---- Prompt with default ----
prompt() {
  local msg="$1"
  local default="${2:-}"
  local var
  if [ -n "$default" ]; then
    read -rp "$msg [default: $default]: " var
    echo "${var:-$default}"
  else
    read -rp "$msg: " var
    echo "$var"
  fi
}

# ---- Secret prompt (no echo) ----
prompt_secret() {
  local msg="$1"
  local var
  read -rsp "$msg: " var
  echo ""
  echo "$var"
}

# ==============================================================
# HEADER
# ==============================================================
echo ""
echo "╔══════════════════════════════════════╗"
echo "║         Nova Setup Wizard            ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ==============================================================
# STEP 1: Prerequisites check
# ==============================================================
echo "${BOLD}Checking prerequisites...${RESET}"

check_docker_version() {
  local version
  version=$(docker --version 2>/dev/null | grep -oE '[0-9]+' | head -1) || true
  if [ -z "$version" ]; then
    die "Docker is not installed or not in PATH. Install it from https://docs.docker.com/get-docker/"
  fi
  if [ "$version" -lt 24 ]; then
    die "Docker version $version found but version >= 24 is required. Please upgrade Docker."
  fi
  info "  ✓ Docker $version"
}

check_docker_compose() {
  if ! docker compose version &>/dev/null; then
    die "'docker compose' (v2) is not available. Install Docker Desktop or the compose plugin: https://docs.docker.com/compose/install/"
  fi
  info "  ✓ docker compose (v2)"
}

check_git() {
  if ! git --version &>/dev/null; then
    die "git is not installed. Install it from https://git-scm.com"
  fi
  info "  ✓ git"
}

check_openssl() {
  if ! openssl version &>/dev/null; then
    die "openssl is not installed. Install it via your package manager (e.g. apt install openssl)."
  fi
  info "  ✓ openssl"
}

check_docker_version
check_docker_compose
check_git
check_openssl
echo ""

# ==============================================================
# Load existing .env (idempotency)
# ==============================================================
load_env

USE_FULL_PROFILE="${USE_FULL_PROFILE:-false}"

# ==============================================================
# STEP 2: Claude auth mode
# ==============================================================
if [ -z "$(get_env ANTHROPIC_API_KEY)" ] && [ -z "$(get_env CLAUDE_HOME_DIR)" ]; then
  echo "${BOLD}How will Nova access Claude?${RESET}"
  echo "  1) I have Claude Code authenticated on this machine (OAuth — uses your subscription)"
  echo "  2) I have an Anthropic API key"
  echo ""
  read -rp "Choice [1/2]: " AUTH_CHOICE
  echo ""

  if [ "${AUTH_CHOICE}" = "2" ]; then
    ANTHROPIC_API_KEY=$(prompt_secret "Enter your Anthropic API key")
    set_env "ANTHROPIC_API_KEY" "$ANTHROPIC_API_KEY"
  else
    # OAuth mode — detect credential paths
    CLAUDE_HOME="${HOME}/.claude"
    CLAUDE_CONFIG="${HOME}/.config/@anthropic-ai"

    if [ -d "$CLAUDE_HOME" ] && [ -d "$CLAUDE_CONFIG" ]; then
      set_env "CLAUDE_HOME_DIR" "$CLAUDE_HOME"
      set_env "CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG"
      info "  ✓ Found Claude credentials at $CLAUDE_HOME and $CLAUDE_CONFIG"
    elif [ -d "$CLAUDE_HOME" ]; then
      set_env "CLAUDE_HOME_DIR" "$CLAUDE_HOME"
      warn "Found $CLAUDE_HOME but not $CLAUDE_CONFIG — OAuth may be incomplete."
      read -rp "Continue anyway? [y/N]: " CONT
      [ "${CONT,,}" = "y" ] || die "Setup cancelled."
    else
      warn "Claude credentials not found at $CLAUDE_HOME or $CLAUDE_CONFIG."
      warn "Make sure you have run 'claude' at least once and authenticated."
      read -rp "Continue anyway? [y/N]: " CONT
      [ "${CONT,,}" = "y" ] || die "Setup cancelled."
    fi
  fi
fi
echo ""

# ==============================================================
# STEP 3: Required fields
# ==============================================================
if [ -z "$(get_env TELEGRAM_BOT_TOKEN)" ]; then
  TELEGRAM_BOT_TOKEN=$(prompt "Enter your Telegram bot token (from @BotFather)")
  set_env "TELEGRAM_BOT_TOKEN" "$TELEGRAM_BOT_TOKEN"
fi

if [ -z "$(get_env TELEGRAM_USER_ID)" ]; then
  TELEGRAM_USER_ID=$(prompt "Enter your Telegram user ID (send /start to @userinfobot)")
  set_env "TELEGRAM_USER_ID" "$TELEGRAM_USER_ID"
fi
echo ""

# ==============================================================
# STEP 4: Bot identity
# ==============================================================
if [ -z "$(get_env NOVA_NAME)" ]; then
  NOVA_NAME=$(prompt "What would you like to name your AI assistant?" "Nova")
  set_env "NOVA_NAME" "$NOVA_NAME"
fi
echo ""

# ==============================================================
# STEP 5: Personalization
# ==============================================================
if [ -z "$(get_env USER_NAME)" ]; then
  USER_NAME=$(prompt "Your name (how Nova addresses you)")
  set_env "USER_NAME" "$USER_NAME"
fi

if [ -z "$(get_env USER_TIMEZONE)" ]; then
  USER_TIMEZONE=$(prompt "Your timezone (e.g. America/New_York, Europe/London)" "America/New_York")
  set_env "USER_TIMEZONE" "$USER_TIMEZONE"
fi
echo ""

# ==============================================================
# STEP 6: Optional — Voice & TTS
# ==============================================================
if [ -z "$(get_env VOICE_PROVIDER)" ]; then
  read -rp "Enable voice support? (requires Groq API key) [y/N]: " VOICE_CHOICE
  echo ""
  if [ "${VOICE_CHOICE,,}" = "y" ]; then
    GROQ_API_KEY=$(prompt_secret "Enter your Groq API key (console.groq.com)")
    set_env "GROQ_API_KEY" "$GROQ_API_KEY"
    set_env "VOICE_PROVIDER" "groq"

    read -rp "Enable ElevenLabs TTS? [y/N]: " TTS_CHOICE
    echo ""
    if [ "${TTS_CHOICE,,}" = "y" ]; then
      ELEVENLABS_API_KEY=$(prompt_secret "Enter your ElevenLabs API key")
      set_env "ELEVENLABS_API_KEY" "$ELEVENLABS_API_KEY"
      ELEVENLABS_VOICE_ID=$(prompt "Enter your ElevenLabs voice ID (leave blank for default)")
      if [ -n "$ELEVENLABS_VOICE_ID" ]; then
        set_env "ELEVENLABS_VOICE_ID" "$ELEVENLABS_VOICE_ID"
      fi
    fi
  else
    set_env "VOICE_PROVIDER" "disabled"
  fi
fi
echo ""

# ==============================================================
# STEP 7: Optional — Dashboard
# ==============================================================
if [ -z "$(get_env DASHBOARD_ENABLED)" ]; then
  read -rp "Enable admin dashboard? [y/N]: " DASH_CHOICE
  echo ""
  if [ "${DASH_CHOICE,,}" = "y" ]; then
    DASHBOARD_USER=$(prompt "Dashboard username" "admin")
    set_env "DASHBOARD_USER" "$DASHBOARD_USER"
    DASHBOARD_PASS=$(prompt_secret "Dashboard password")
    set_env "DASHBOARD_PASS" "$DASHBOARD_PASS"
    set_env "DASHBOARD_ENABLED" "true"
    USE_FULL_PROFILE="true"
  else
    set_env "DASHBOARD_ENABLED" "false"
  fi
fi
echo ""

# ==============================================================
# STEP 8: Optional — Custom domain (HTTPS via Caddy)
# ==============================================================
if ! grep -q "^NOVA_DOMAIN=" "$ENV_FILE" 2>/dev/null; then
  read -rp "Do you have a domain name for Nova? (enables HTTPS via Caddy) [y/N]: " DOMAIN_CHOICE
  echo ""
  if [ "${DOMAIN_CHOICE,,}" = "y" ]; then
    NOVA_DOMAIN=$(prompt "Enter your domain (e.g. nova.example.com)")
    set_env "NOVA_DOMAIN" "$NOVA_DOMAIN"
    USE_FULL_PROFILE="true"

    # Verify Caddyfile exists
    if [ ! -f "$PROJECT_DIR/Caddyfile" ]; then
      warn "Caddyfile not found at $PROJECT_DIR/Caddyfile — HTTPS will not work until it is present."
    else
      info "  ✓ Caddyfile found"
    fi
  else
    set_env "NOVA_DOMAIN" ""
  fi
fi

# Persist USE_FULL_PROFILE
set_env "USE_FULL_PROFILE" "$USE_FULL_PROFILE"
echo ""

# ==============================================================
# STEP 9: Generate encryption key (if not already set)
# ==============================================================
if [ -z "$(get_env NOVA_ENCRYPTION_KEY)" ]; then
  NOVA_ENCRYPTION_KEY=$(openssl rand -hex 32)
  set_env "NOVA_ENCRYPTION_KEY" "$NOVA_ENCRYPTION_KEY"
  info "  ✓ Generated NOVA_ENCRYPTION_KEY"
fi
echo ""

# ==============================================================
# STEP 10: Build and start
# ==============================================================
echo "${BOLD}Building Docker images (this may take a few minutes on first run)...${RESET}"
docker compose build

echo ""
echo "${BOLD}Starting Nova...${RESET}"

if [ "$(get_env USE_FULL_PROFILE)" = "true" ]; then
  docker compose --profile full up -d
else
  docker compose up -d
fi

# ==============================================================
# STEP 11: Wait and tail logs
# ==============================================================
echo ""
echo "Starting Nova... (waiting for relay to be ready)"
sleep 5

docker compose logs relay --tail=30 --follow &
LOG_PID=$!

TIMEOUT=60
ELAPSED=0
while ! docker compose logs relay 2>/dev/null | grep -qi "listening\|ready\|telegram"; do
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    break
  fi
done

kill "$LOG_PID" 2>/dev/null || true

# ==============================================================
# Done
# ==============================================================
echo ""
info "✓ Nova is running!"
echo ""
echo "Next step: Send \"hello\" to your Telegram bot to verify it's working."
echo ""
echo "Useful commands:"
echo "  docker compose logs relay -f     # tail relay logs"
echo "  docker compose ps                # check service status"
echo "  bash scripts/update.sh           # update to latest version"
echo ""
