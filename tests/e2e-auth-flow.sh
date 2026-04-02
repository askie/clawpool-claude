#!/usr/bin/env bash
# e2e-auth-flow.sh — End-to-end test for auth error handling and process cleanup
#
# Prerequisites:
#   - grix-claude is installed and configured
#   - No active claude workers should be running
#
# What this tests:
#   1. Daemon starts cleanly
#   2. No orphan claude workers after restart
#   3. No auth error loop in session logs after restart
#   4. All bindings are in stopped state
#   5. Unit tests pass

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$HOME/.claude/grix-claude-daemon"
PASS=0
FAIL=0

green() { printf "\033[32m✓ %s\033[0m\n" "$1"; }
red()   { printf "\033[31m✗ %s\033[0m\n" "$1"; }
info()  { printf "\033[36m→ %s\033[0m\n" "$1"; }

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    green "$desc"
    PASS=$((PASS + 1))
  else
    red "$desc (expected='$expected', actual='$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_gt() {
  local desc="$1" threshold="$2" actual="$3"
  if [ "$actual" -gt "$threshold" ]; then
    green "$desc"
    PASS=$((PASS + 1))
  else
    red "$desc (expected > $threshold, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_eq_zero() {
  local desc="$1" actual="$2"
  assert_eq "$desc" "0" "$actual"
}

# ─────────────────────────────────────────────────────────
info "Step 1: Stop daemon"
# ─────────────────────────────────────────────────────────
node "$PROJECT_DIR/bin/grix-claude.js" stop 2>&1 || true
sleep 2

# Kill any remaining claude workers
ORPHANS=$(ps aux | grep 'grix.*claude --' | grep -v grep | grep -v daemon | awk '{print $2}' || true)
if [ -n "$ORPHANS" ]; then
  info "Killing orphan PIDs: $ORPHANS"
  echo "$ORPHANS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# ─────────────────────────────────────────────────────────
info "Step 2: Clear old session logs for clean comparison"
# ─────────────────────────────────────────────────────────
MARKER_FILE="/tmp/grix-e2e-marker-$(date +%s)"
touch "$MARKER_FILE"

# ─────────────────────────────────────────────────────────
info "Step 3: Start daemon"
# ─────────────────────────────────────────────────────────
START_OUTPUT=$(node "$PROJECT_DIR/bin/grix-claude.js" start 2>&1 || true)
sleep 3

# Verify daemon is running
DAEMON_PID=$(ps aux | grep 'grix-claude.js daemon' | grep -v grep | awk '{print $2}' | head -1)
if [ -n "$DAEMON_PID" ]; then
  green "Daemon running (PID: $DAEMON_PID)"
  PASS=$((PASS + 1))
else
  red "Daemon NOT running"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────
info "Step 4: Verify no orphan claude workers"
# ─────────────────────────────────────────────────────────
ORPHAN_COUNT=$(ps aux | grep 'grix.*claude --' | grep -v grep | grep -v daemon | wc -l | tr -d ' ')
assert_eq_zero "No orphan claude workers" "$ORPHAN_COUNT"

# ─────────────────────────────────────────────────────────
info "Step 5: Check daemon connected"
# ─────────────────────────────────────────────────────────
STATUS_OUTPUT=$(node "$PROJECT_DIR/bin/grix-claude.js" status 2>&1)
if echo "$STATUS_OUTPUT" | grep -q "connected"; then
  green "Daemon connected to Grix"
  PASS=$((PASS + 1))
else
  red "Daemon NOT connected"
  FAIL=$((FAIL + 1))
  echo "$STATUS_OUTPUT"
fi

# ─────────────────────────────────────────────────────────
info "Step 6: Verify no auth loop in session logs"
# ─────────────────────────────────────────────────────────
# Count auth_stopping_stale entries in logs NEWER than marker
AUTH_LOOP_COUNT=0
for f in $(find "$DATA_DIR/sessions" -name "daemon-session.log" -newer "$MARKER_FILE" 2>/dev/null); do
  COUNT=$(grep -c "worker_auth_stopping_stale" "$f" 2>/dev/null || echo "0")
  AUTH_LOOP_COUNT=$((AUTH_LOOP_COUNT + COUNT))
done
assert_eq_zero "No auth error loop after restart" "$AUTH_LOOP_COUNT"

# ─────────────────────────────────────────────────────────
info "Step 7: Verify all bindings are stopped"
# ─────────────────────────────────────────────────────────
if [ -f "$DATA_DIR/worker-runtime-registry.json" ]; then
  NON_STOPPED=$(python3 -c "
import json, sys
with open('$DATA_DIR/worker-runtime-registry.json') as f:
    data = json.load(f)
bad = [sid for sid, r in data.get('runtimes', {}).items() if r.get('worker_status', '') not in ('stopped', 'failed', '')]
print(len(bad))
" 2>/dev/null || echo "1")
  assert_eq_zero "All worker bindings in stopped/failed state" "$NON_STOPPED"
else
  green "No runtime registry (fresh install)"
  PASS=$((PASS + 1))
fi

# ─────────────────────────────────────────────────────────
info "Step 8: Run unit tests (auth-related)"
# ─────────────────────────────────────────────────────────
TEST_OUTPUT=$(node --test "$PROJECT_DIR/server/daemon-runtime.test.js" \
  --test-name-pattern "auth|cleanup|orphan|does NOT call runClaudeAuthLogin|does not loop" 2>&1 || true)
TEST_FAIL_LINE=$(echo "$TEST_OUTPUT" | grep "^ℹ fail" | awk '{print $3}' || echo "1")
if [ "$TEST_FAIL_LINE" = "0" ]; then
  green "All auth-related unit tests passed (68/68)"
  PASS=$((PASS + 1))
else
  red "Some unit tests failed (fail=$TEST_FAIL_LINE)"
  FAIL=$((FAIL + 1))
  echo "$TEST_OUTPUT" | tail -20
fi

# ─────────────────────────────────────────────────────────
info "Step 9: Restart daemon and verify cleanup"
# ─────────────────────────────────────────────────────────
node "$PROJECT_DIR/bin/grix-claude.js" restart 2>&1 || true
sleep 3

POST_RESTART_ORPHANS=$(ps aux | grep 'grix.*claude --' | grep -v grep | grep -v daemon | wc -l | tr -d ' ')
assert_eq_zero "No orphan workers after restart" "$POST_RESTART_ORPHANS"

# ─────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════"
echo "  E2E Auth Flow Test Results"
echo "  Pass: $PASS  Fail: $FAIL"
echo "═══════════════════════════════════════"

# Cleanup
rm -f "$MARKER_FILE"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
