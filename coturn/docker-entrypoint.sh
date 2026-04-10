#!/bin/sh
# coturn 起動スクリプト
# 環境変数から認証情報と外部 IP を受け取り turnserver に渡す

set -e

# 認証情報が未設定の場合は TURN サーバーを無効化して正常終了
# (restart: on-failure を使っているため再起動ループにはならない)
if [ -z "$TURN_USERNAME" ] || [ -z "$TURN_CREDENTIAL" ]; then
  echo "[coturn] TURN_USERNAME / TURN_CREDENTIAL が未設定のため TURN サーバーを無効化します"
  echo "[coturn] .env に TURN_USERNAME と TURN_CREDENTIAL を設定して再起動してください"
  exit 0
fi

ARGS="-c /etc/coturn/turnserver.conf"
ARGS="$ARGS --user=$TURN_USERNAME:$TURN_CREDENTIAL"

# 外部 IP (Docker でポートマッピングを使う場合は設定が必要)
# 未設定の場合は coturn が自動検出を試みる
if [ -n "$COTURN_EXTERNAL_IP" ]; then
  ARGS="$ARGS --external-ip=$COTURN_EXTERNAL_IP"
fi

# TLS 証明書が未発行の場合 (https-portal 初回起動直後など) は TLS を無効化して起動
CERT="/etc/certs/afjk.jp/production/signed.crt"
if [ ! -f "$CERT" ]; then
  echo "[coturn] 証明書未発行 — TLS 無効で起動します (TURNS は無効、TURN のみ有効)"
  ARGS="$ARGS --no-tls"
fi

echo "[coturn] starting: turnserver $ARGS"
exec turnserver $ARGS
