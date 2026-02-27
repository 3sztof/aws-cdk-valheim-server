#!/usr/bin/env bash
# devcontainer postCreateCommand - runs once after container creation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# uv (Python package manager - required for Lambda layer builds)
# ---------------------------------------------------------------------------
if ! command -v uv &>/dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
# Ensure uv's bin dir is on PATH regardless of whether we just installed it.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# ---------------------------------------------------------------------------
# gitleaks (secrets scanner - pre-built binary, avoids go proxy at install time)
# ---------------------------------------------------------------------------
GITLEAKS_VERSION="8.24.0"
if ! command -v gitleaks &>/dev/null; then
  ARCH=$(uname -m)
  case "$ARCH" in
    aarch64|arm64) GITLEAKS_ARCH="arm64" ;;
    x86_64)        GITLEAKS_ARCH="x64" ;;
    *)             echo "Unsupported arch: $ARCH"; exit 1 ;;
  esac
  GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz"
  echo "Installing gitleaks ${GITLEAKS_VERSION} (${GITLEAKS_ARCH})..."
  curl -fsSL "$GITLEAKS_URL" | tar -xz -C "$HOME/.local/bin" gitleaks
fi

# ---------------------------------------------------------------------------
# Python tools (pre-commit, ty)
# ---------------------------------------------------------------------------
uv tool install pre-commit --quiet
uv tool install ty --quiet

# ---------------------------------------------------------------------------
# Node dependencies + pre-commit hooks
# ---------------------------------------------------------------------------
npm install
pre-commit install

# ---------------------------------------------------------------------------
# opencode (AI coding assistant)
# ---------------------------------------------------------------------------
# Install via the official installer (downloads a native binary for linux-x64/arm64).
if ! command -v opencode &>/dev/null; then
  curl -fsSL https://opencode.ai/install | bash
  # The installer adds ~/.opencode/bin to the detected shell config, but
  # postCreateCommand runs under /bin/sh which may not match the login shell.
  # Explicitly append to ~/.bashrc so all subsequent terminal sessions pick it up.
  OPENCODE_BIN="$HOME/.opencode/bin"
  if ! grep -qF "$OPENCODE_BIN" "$HOME/.bashrc" 2>/dev/null; then
    echo "export PATH=\"$OPENCODE_BIN:\$PATH\"" >> "$HOME/.bashrc"
  fi
  export PATH="$OPENCODE_BIN:$PATH"
fi

# Copy project-scoped opencode config into the standard config directory.
# Files in .devcontainer/opencode/ are version-controlled and curated for
# this project (only the aws-documentation and cdk MCP servers are enabled).
OPENCODE_CONFIG_DIR="$HOME/.config/opencode"
mkdir -p "$OPENCODE_CONFIG_DIR/skills"

# opencode.json - MCP server config (project-scoped, only relevant servers)
if [ ! -f "$OPENCODE_CONFIG_DIR/opencode.json" ]; then
  cp "$SCRIPT_DIR/opencode/opencode.json" "$OPENCODE_CONFIG_DIR/opencode.json"
  echo "opencode: wrote opencode.json"
fi

# AGENTS.md - system prompt / engineering principles
if [ ! -f "$OPENCODE_CONFIG_DIR/AGENTS.md" ]; then
  cp "$SCRIPT_DIR/opencode/AGENTS.md" "$OPENCODE_CONFIG_DIR/AGENTS.md"
  echo "opencode: wrote AGENTS.md"
fi

# Skills - only copy skills that don't already exist (don't overwrite user customizations)
for skill_dir in "$SCRIPT_DIR/opencode/skills"/*/; do
  skill_name="$(basename "$skill_dir")"
  target_dir="$OPENCODE_CONFIG_DIR/skills/$skill_name"
  if [ ! -d "$target_dir" ]; then
    cp -r "$skill_dir" "$target_dir"
    echo "opencode: installed skill: $skill_name"
  fi
done

echo ""
echo "Setup complete."
echo "  - npm dependencies installed"
echo "  - pre-commit hooks registered"
echo "  - uv available for Lambda layer builds"
echo "  - ty available for Python type checking"
echo "  - opencode installed (run: opencode)"
