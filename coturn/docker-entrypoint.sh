#!/bin/sh
# coturn 起動スクリプト
# 環境変数から認証情報と外部 IP を受け取り turnserver に渡す

set -e

ARGS="-c /etc/coturn/turnserver.conf"

# 認証情報 (必須)
if [ -z "$TURN_USERNAME" ] || [ -z "$TURN_CREDENTIAL" ]; then
  echo "[coturn] ERROR: TURN_USERNAME / TURN_CREDENTIAL が未設定です" >&2
  exit 1
fi
ARGS="$ARGS --user=$TURN_USERNAME:$TURN_CREDENTIAL"

# 外部 IP (Docker でポートマッピングを使う場合は設定が必要)
# 未設定の場合は coturn が自動検出を試みる
if [ -n "$COTURN_EXTERNAL_IP" ]; then
  ARGS="$ARGS --external-ip=$COTURN_EXTERNAL_IP"
fi

echo "[coturn] starting: turnserver $ARGS"
exec turnserver $ARGS
