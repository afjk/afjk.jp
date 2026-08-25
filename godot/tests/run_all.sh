#!/bin/bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PROJECT_DIR")"
TMP_DIR="${TMPDIR:-/tmp}/scenesync-godot-tests"
TEST_PORT="${SCENESYNC_TEST_PORT:-18787}"
REMOTE_ASSET_TEST_PORT="${SCENESYNC_REMOTE_ASSET_TEST_PORT:-18788}"
PRESENCE_PID=""
REMOTE_ASSET_PID=""

cleanup() {
  if [ -n "$REMOTE_ASSET_PID" ]; then
    kill "$REMOTE_ASSET_PID" 2>/dev/null || true
    wait "$REMOTE_ASSET_PID" 2>/dev/null || true
  fi
  if [ -n "$PRESENCE_PID" ]; then
    kill "$PRESENCE_PID" 2>/dev/null || true
    wait "$PRESENCE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM
mkdir -p "$TMP_DIR/blobs"
mkdir -p "$TMP_DIR/logs"

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

if ! command -v dotnet >/dev/null 2>&1; then
  echo "dotnet SDK not found; Godot .NET integration tests require it"
  exit 1
fi

echo "--- Building and importing Godot .NET assembly ---"
dotnet build "$PROJECT_DIR/SceneSyncGodot.csproj" --nologo || exit 1
cd "$PROJECT_DIR"
"$GODOT" --headless --log-file "$TMP_DIR/logs/dotnet-import.log" \
  --editor --import --quit || exit 1
echo ""

echo "--- Checking SceneSync scripts ---"
cd "$PROJECT_DIR"
"$GODOT" --headless --log-file "$TMP_DIR/logs/manager-check.log" \
  --check-only --script addons/scene_sync/scene_sync_manager.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-bridge-check.log" \
  --check-only --script addons/scene_sync/scene_sync_rapier_bridge.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/tests-check.log" \
  --check-only --script tests/run_tests.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-tests-check.log" \
  --check-only --script tests/test_rapier_bridge.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-manager-transform-tests-check.log" \
  --check-only --script tests/test_rapier_manager_transform_order.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-editor-tests-check.log" \
  --check-only --script tests/test_rapier_editor_fallback.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/loom-runner-check.log" \
  --check-only --script tests/test_loom_runner.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/wire-asset-visual-check.log" \
  --check-only --script tests/test_wire_asset_visual.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat-check.log" \
  --check-only --script addons/scene_sync/gaussian_splat_glb.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat-preview-check.log" \
  --check-only --script addons/scene_sync/gaussian_splat_preview.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat-backend-check.log" \
  --check-only --script addons/scene_sync/gaussian_splat_backend.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/godot-gsplat-backend-check.log" \
  --check-only --script addons/scene_sync/godot_gsplat_backend.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat-node-check.log" \
  --check-only --script addons/scene_sync/scene_sync_gaussian_splat_node.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/plugin-check.log" \
  --check-only --script addons/scene_sync/plugin.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat-tests-check.log" \
  --check-only --script tests/test_gaussian_splat_glb.gd || exit 1
"$GODOT" --headless --log-file "$TMP_DIR/logs/godot-gsplat-smoke-check.log" \
  --check-only --script tests/test_godot_gsplat_backend.gd || exit 1
echo ""

echo "--- Starting presence-server ---"
cd "$REPO_ROOT/apps/presence-server"
PORT="$TEST_PORT" \
STATS_FILE="$TMP_DIR/stats.json" \
STATS_ARCHIVE_DIR="$TMP_DIR/archive" \
BLOB_DIR="$TMP_DIR/blobs" \
SCENE_SYNC_GLB_BACKUP_DIR="$TMP_DIR/glb-backups" \
node src/server.mjs &
PRESENCE_PID=$!
sleep 2
echo "presence-server PID: $PRESENCE_PID"
echo ""

echo "--- Starting remote asset fixture ---"
cd "$PROJECT_DIR"
SCENESYNC_REMOTE_ASSET_TEST_PORT="$REMOTE_ASSET_TEST_PORT" \
node tests/remote_asset_fixture_server.mjs &
REMOTE_ASSET_PID=$!
sleep 1
echo "remote asset fixture PID: $REMOTE_ASSET_PID"
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

run_rapier_editor_fallback_test() {
  local log_file="$TMP_DIR/logs/rapier-editor-fallback.log"
  "$GODOT" --headless --editor --log-file "$log_file" -s tests/test_rapier_editor_fallback.gd || return 1
  if grep -E "placeholder instance|Nonexistent '(bool|int)' constructor" "$log_file"; then
    echo "Rapier editor fallback emitted a placeholder call error"
    return 1
  fi
}

run_test "Unit Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/unit.log" -s tests/run_tests.gd

run_test "Loomlet Runner Integration Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/loom-runner.log" -s tests/test_loom_runner.gd

run_test "Wire Asset Visual Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/wire-asset-visual.log" -s tests/test_wire_asset_visual.gd

run_test "Gaussian Splat GLB Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/gaussian-splat.log" -s tests/test_gaussian_splat_glb.gd

run_test "godot-gsplat Real Backend Smoke" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/godot-gsplat-smoke.log" -s tests/test_godot_gsplat_backend.gd

run_test "Playback Clock Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/playback-clock.log" -s tests/test_playback_clock.gd

run_test "Rapier Bridge Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-bridge.log" -s tests/test_rapier_bridge.gd

run_test "Rapier Manager Transform Order Tests" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/rapier-manager-transform.log" -s tests/test_rapier_manager_transform_order.gd

run_test "Rapier Editor Fallback Tests" \
  run_rapier_editor_fallback_test

run_test "Remote Asset Loader Tests" \
  env SCENESYNC_REMOTE_ASSET_TEST_PORT="$REMOTE_ASSET_TEST_PORT" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/remote-asset.log" -s tests/test_remote_asset_loader.gd

run_test "WebSocket Connection Test" \
  env SCENESYNC_PRESENCE_URL="ws://localhost:$TEST_PORT" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/connection.log" tests/test_connection.tscn

run_test "Blob Store Test" \
  env SCENESYNC_BLOB_URL="http://localhost:$TEST_PORT/blob" \
  "$GODOT" --headless --log-file "$TMP_DIR/logs/blob.log" tests/test_blob.tscn

cleanup
trap - EXIT INT TERM

echo "========================================"
echo "  TOTAL: PASS=$TOTAL_PASS  FAIL=$TOTAL_FAIL"
echo "========================================"

if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
