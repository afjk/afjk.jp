#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PROJECT_DIR")"
TMP_DIR="${TMPDIR:-/tmp}/scenesync-godot-tests"
TEST_PORT="${SCENESYNC_TEST_PORT:-18787}"
mkdir -p "$TMP_DIR/blobs"

if [ -n "${GODOT_BIN:-}" ]; then
  GODOT="$GODOT_BIN"
else
  GODOT="$PROJECT_DIR/Godot.app/Contents/MacOS/Godot"
fi

echo "=== Godot Headless Test Runner ==="
echo "Godot: $GODOT"
echo "Project: $PROJECT_DIR"
echo ""

if [ ! -x "$GODOT" ]; then
  echo "Godot binary not found or not executable: $GODOT"
  exit 1
fi

echo "--- Generating import cache ---"
cd "$PROJECT_DIR"
"$GODOT" --headless --editor --import --quit >/dev/null 2>&1 || true
echo ""

echo "--- Starting presence-server ---"
cd "$REPO_ROOT/apps/presence-server"
PORT="$TEST_PORT" \
STATS_FILE="$TMP_DIR/stats.json" \
STATS_ARCHIVE_DIR="$TMP_DIR/archive" \
BLOB_DIR="$TMP_DIR/blobs" \
node src/server.mjs &
PRESENCE_PID=$!
sleep 2
echo "presence-server PID: $PRESENCE_PID"
echo ""

TOTAL_PASS=0
TOTAL_FAIL=0

run_test() {
  local name="$1"
  shift
  echo "--- Running: $name ---"
  cd "$PROJECT_DIR"
  if "$@"; then
    echo "  => $name: PASS"
    TOTAL_PASS=$((TOTAL_PASS + 1))
  else
    echo "  => $name: FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
  echo ""
}

run_test "Unit Tests" \
  "$GODOT" --headless -s tests/run_tests.gd

run_test "WebSocket Connection Test" \
  env SCENESYNC_PRESENCE_URL="ws://localhost:$TEST_PORT" \
  "$GODOT" --headless tests/test_connection.tscn

run_test "Blob Store Test" \
  env SCENESYNC_BLOB_URL="http://localhost:$TEST_PORT/blob" \
  "$GODOT" --headless tests/test_blob.tscn

kill "$PRESENCE_PID" 2>/dev/null || true

echo "========================================"
echo "  TOTAL: PASS=$TOTAL_PASS  FAIL=$TOTAL_FAIL"
echo "========================================"

if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
