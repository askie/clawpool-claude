#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$REPO_ROOT"
MCP_CONFIG_PATH="$REPO_ROOT/.mcp.json"

WS_URL="${CLAWPOOL_WS_URL:-}"
AGENT_ID="${CLAWPOOL_AGENT_ID:-}"
API_KEY="${CLAWPOOL_API_KEY:-}"
OUTBOUND_TEXT_CHUNK_LIMIT="1200"
DATA_DIR=""
DEBUG_LOG=""
SKIP_BUILD=0
LAUNCH=1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

usage() {
  cat <<'EOF'
用法:
  ./start.sh [options]

说明:
  自动编译当前插件目录，并直接从仓库根目录启动 Claude 调试会话。

选项:
  --ws-url <value>         必填，ClawPool Agent API WebSocket URL
  --agent-id <value>       必填，Agent ID
  --api-key <value>        必填，API Key
  --data-dir <path>        指定 CLAUDE_PLUGIN_DATA，默认 ~/.claude/channels/clawpool-claude/manual-<agent_id>
  --debug-log <path>       指定 Claude debug log，默认 /tmp/claude-clawpool-claude-<agent_id>.log
  --chunk-limit <n>        outbound_text_chunk_limit，默认 1200
  --skip-build             跳过 npm install 和 npm run build
  --no-launch              只准备配置和构建，不直接启动 Claude
  --help, -h               显示帮助

也支持环境变量:
  CLAWPOOL_WS_URL
  CLAWPOOL_AGENT_ID
  CLAWPOOL_API_KEY
EOF
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令: $cmd"
}

run_logged() {
  local description="$1"
  local log_file="$2"
  shift 2

  info "$description"
  "$@" >"$log_file" 2>&1 || {
    cat "$log_file" >&2
    fail "$description 失败"
  }
  rm -f "$log_file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ws-url)
      [[ $# -ge 2 ]] || fail "--ws-url 缺少值"
      WS_URL="$2"
      shift 2
      ;;
    --agent-id)
      [[ $# -ge 2 ]] || fail "--agent-id 缺少值"
      AGENT_ID="$2"
      shift 2
      ;;
    --api-key)
      [[ $# -ge 2 ]] || fail "--api-key 缺少值"
      API_KEY="$2"
      shift 2
      ;;
    --data-dir)
      [[ $# -ge 2 ]] || fail "--data-dir 缺少值"
      DATA_DIR="$2"
      shift 2
      ;;
    --debug-log)
      [[ $# -ge 2 ]] || fail "--debug-log 缺少值"
      DEBUG_LOG="$2"
      shift 2
      ;;
    --chunk-limit)
      [[ $# -ge 2 ]] || fail "--chunk-limit 缺少值"
      OUTBOUND_TEXT_CHUNK_LIMIT="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --no-launch)
      LAUNCH=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "未知参数: $1"
      ;;
  esac
done

[[ -n "$WS_URL" ]] || fail "缺少 --ws-url 或 CLAWPOOL_WS_URL"
[[ -n "$AGENT_ID" ]] || fail "缺少 --agent-id 或 CLAWPOOL_AGENT_ID"
[[ -n "$API_KEY" ]] || fail "缺少 --api-key 或 CLAWPOOL_API_KEY"
[[ "$OUTBOUND_TEXT_CHUNK_LIMIT" =~ ^[1-9][0-9]*$ ]] || fail "--chunk-limit 必须是正整数"

if [[ -z "$DATA_DIR" ]]; then
  DATA_DIR="$HOME/.claude/channels/clawpool-claude/manual-$AGENT_ID"
fi

if [[ -z "$DEBUG_LOG" ]]; then
  DEBUG_LOG="/tmp/claude-clawpool-claude-$AGENT_ID.log"
fi

CONFIG_PATH="$DATA_DIR/clawpool-config.json"

require_cmd python3
require_cmd npm
require_cmd claude

[[ -d "$PLUGIN_DIR" ]] || fail "插件目录不存在: $PLUGIN_DIR"
[[ -f "$MCP_CONFIG_PATH" ]] || fail "仓库根目录缺少 .mcp.json: $MCP_CONFIG_PATH"

python3 - "$MCP_CONFIG_PATH" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
server = data.get("mcpServers", {}).get("clawpool-claude")
if not isinstance(server, dict):
    raise SystemExit("仓库根目录 .mcp.json 缺少 mcpServers.clawpool-claude")
PY

info "校验 Claude 插件 manifest"
claude plugin validate "$PLUGIN_DIR" >/dev/null || fail "Claude 插件 manifest 校验失败"
ok "Claude 插件 manifest 校验通过"

if [[ "$SKIP_BUILD" != "1" ]]; then
  run_logged \
    "安装 Claude clawpool 插件依赖" \
    "/tmp/start-claude-clawpool-claude-root-debug.npm-install.log" \
    bash -lc "cd \"$PLUGIN_DIR\" && npm install"

  run_logged \
    "构建 Claude clawpool 插件" \
    "/tmp/start-claude-clawpool-claude-root-debug.npm-build.log" \
    bash -lc "cd \"$PLUGIN_DIR\" && npm run build"
else
  warn "已跳过构建；请确认 $PLUGIN_DIR/dist/main.cjs 已是最新产物"
fi

mkdir -p "$DATA_DIR"

python3 - "$CONFIG_PATH" "$WS_URL" "$AGENT_ID" "$API_KEY" "$OUTBOUND_TEXT_CHUNK_LIMIT" <<'PY'
import json
import pathlib
import sys

output_path = pathlib.Path(sys.argv[1])
payload = {
    "schema_version": 1,
    "ws_url": sys.argv[2],
    "agent_id": sys.argv[3],
    "api_key": sys.argv[4],
    "outbound_text_chunk_limit": int(sys.argv[5]),
}
output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
PY

if [[ ${#API_KEY} -le 8 ]]; then
  API_KEY_HINT="${API_KEY:0:2}***"
else
  API_KEY_HINT="${API_KEY:0:4}***${API_KEY: -2}"
fi

ok "Claude 插件配置已写入: $CONFIG_PATH"
ok "Claude workspace: $REPO_ROOT"
ok "WS URL: $WS_URL"
ok "Agent ID: $AGENT_ID"
ok "API Key: $API_KEY_HINT"
ok "Claude debug log: $DEBUG_LOG"

printf '\n%s\n' "Claude 启动命令："
printf 'cd %q && ' "$REPO_ROOT"
printf 'CLAUDE_PLUGIN_DATA=%q ' "$DATA_DIR"
printf 'claude --debug-file %q --plugin-dir %q --dangerously-load-development-channels server:clawpool-claude --dangerously-skip-permissions\n' \
  "$DEBUG_LOG" \
  "$PLUGIN_DIR"

if [[ "$LAUNCH" == "1" ]]; then
  info "从仓库根目录启动 Claude 调试会话"
  cd "$REPO_ROOT"
  export CLAUDE_PLUGIN_DATA="$DATA_DIR"
  exec claude \
    --debug-file "$DEBUG_LOG" \
    --plugin-dir "$PLUGIN_DIR" \
    --dangerously-load-development-channels server:clawpool-claude \
    --dangerously-skip-permissions
fi

printf '\n%s\n' "启动后建议先执行：/clawpool-claude:status"
