#!/bin/sh
set -eu

SECRET="${CARD_SECRET:-}"
ADMIN_PASSWORD="${CARD_ADMIN_PASSWORD:-}"

if [ "${ALLOW_INSECURE_DEFAULTS:-0}" != "1" ]; then
  if [ -z "$SECRET" ] || [ "$SECRET" = "LICENSE_BLOB" ]; then
    echo "refusing to start: set CARD_SECRET to a long random value, or set ALLOW_INSECURE_DEFAULTS=1 for a local trial" >&2
    exit 1
  fi
  if [ -z "$ADMIN_PASSWORD" ] || [ "$ADMIN_PASSWORD" = "ADMIN_PASSWORD" ]; then
    echo "refusing to start: set CARD_ADMIN_PASSWORD, or set ALLOW_INSECURE_DEFAULTS=1 for a local trial" >&2
    exit 1
  fi
  if [ "${#SECRET}" -lt 16 ]; then
    echo "refusing to start: CARD_SECRET must be at least 16 characters" >&2
    exit 1
  fi
  if [ "${#ADMIN_PASSWORD}" -lt 10 ]; then
    echo "refusing to start: CARD_ADMIN_PASSWORD must be at least 10 characters" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "${CARD_DB:-/data/cards.sqlite3}")"

# 网页一键更新会把新的 server.py 与 static 写进 /data/app；
# 这里在启动时优先使用这份代码，没有时回退到镜像内的 /app。
INSTALL_DIR="${CARD_UPDATE_INSTALL_DIR:-/data/app}"
mkdir -p "$INSTALL_DIR"
IMAGE_DIR="${CARD_IMAGE_DIR:-/app}"
use_install=0
STATE_FILE="${CARD_UPDATE_DIR:-/data}/update-state.json"
PENDING_RESTART=0
if [ -f "$INSTALL_DIR/server.py" ] && [ -f "$INSTALL_DIR/static/index.html" ]; then
  use_install=1
  if [ -f "$STATE_FILE" ] && grep -q '"pendingRestart": true' "$STATE_FILE"; then
    PENDING_RESTART=1
  fi
  if [ "$PENDING_RESTART" != "1" ] && [ -f "$INSTALL_DIR/.build-revision" ] && [ -f "$IMAGE_DIR/.build-revision" ]; then
    # 只有镜像比网页更新里写入的副本更新时才切回镜像，否则保留已下载的版本。
    if [ "$IMAGE_DIR/.build-revision" -nt "$INSTALL_DIR/.build-revision" ]; then
      use_install=0
    fi
  fi
fi
if [ "$use_install" = "1" ]; then
  if [ "$#" -gt 0 ] && [ "$1" = "python" ] && [ "${2:-}" = "/app/server.py" ]; then
    shift 2
    exec python "$INSTALL_DIR/server.py" "$@"
  fi
fi

exec "$@"
