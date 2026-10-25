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

# 网页一键更新会把新的 server.py / mitm_server.py 与 static 写进数据卷；
# 这里在启动时优先使用这份副本，副本损坏时自动退回镜像内代码。
INSTALL_DIR="${CARD_UPDATE_INSTALL_DIR:-/data/app}"
IMAGE_DIR="${CARD_IMAGE_DIR:-/app}"
STATE_FILE="${CARD_UPDATE_DIR:-/data}/update-state.json"

mkdir -p "$INSTALL_DIR" 2>/dev/null || true

pending_restart() {
  [ -f "$STATE_FILE" ] && grep -q '"pendingRestart": true' "$STATE_FILE" 2>/dev/null
}

# 装上去的代码能不能跑，先编译一遍；不能跑就别拿它当启动入口。
compiles() {
  python -c 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")' "$1" 2>/dev/null
}

use_install=0
if [ -f "$INSTALL_DIR/server.py" ] && [ -f "$INSTALL_DIR/static/index.html" ]; then
  if [ -f "$INSTALL_DIR/.install-disabled" ]; then
    echo "card-service: 数据卷副本上次连续启动失败，已停用；重新下载更新后会再试一次" >&2
  elif compiles "$INSTALL_DIR/server.py"; then
    use_install=1
    if ! pending_restart && [ -f "$INSTALL_DIR/.build-revision" ] && [ -f "$IMAGE_DIR/.build-revision" ]; then
      # 只有镜像比网页更新里写入的副本更新时才切回镜像，否则保留已下载的版本。
      if [ "$IMAGE_DIR/.build-revision" -nt "$INSTALL_DIR/.build-revision" ]; then
        use_install=0
      fi
    fi
    if [ "$use_install" = "1" ]; then
      # 启动成功时 server.py 会删掉这个计数；连续三次没起来就停用这份副本。
      attempts=$(cat "$INSTALL_DIR/.boot-attempts" 2>/dev/null || echo 0)
      case "$attempts" in
        ''|*[!0-9]*) attempts=0 ;;
      esac
      if [ "$attempts" -ge 3 ]; then
        echo "card-service: 数据卷副本连续 $attempts 次没能启动，改用镜像内代码；重新下载更新后会再试" >&2
        : > "$INSTALL_DIR/.install-disabled" 2>/dev/null || true
        use_install=0
      else
        echo $((attempts + 1)) > "$INSTALL_DIR/.boot-attempts" 2>/dev/null || true
      fi
    fi
  else
    echo "card-service: $INSTALL_DIR/server.py 无法编译，回退到镜像内代码" >&2
  fi
fi

if [ "$use_install" = "1" ] && [ "$#" -ge 1 ]; then
  # 把命令里的镜像入口脚本换成数据卷里的同名脚本：解释器和其它参数原样保留，
  # 不再要求命令必须写成 `python /app/server.py`（python3 / -u / 桥接入口同样适用）。
  interp="$1"
  shift

  entry=""
  for arg in "$@"; do
    case "$arg" in
      *.py)
        entry="${arg##*/}"
        break
        ;;
    esac
  done

  if [ -n "$entry" ] && [ -f "$INSTALL_DIR/$entry" ]; then
    set -f
    old_ifs=$IFS
    IFS='
'
    rebuilt=""
    prev=""
    for arg in "$@"; do
      case "$arg" in
        *.py)
          if [ "${arg##*/}" = "$entry" ]; then
            arg="$INSTALL_DIR/$entry"
          fi
          ;;
        --card-service=*)
          # 桥接用 --card-service 指定控制台目录，同样要跟着副本走。
          if [ -f "$INSTALL_DIR/server.py" ]; then
            arg="--card-service=$INSTALL_DIR"
          fi
          ;;
        *)
          if [ "$prev" = "--card-service" ] && [ -f "$INSTALL_DIR/server.py" ]; then
            arg="$INSTALL_DIR"
          fi
          ;;
      esac
      prev="$arg"
      rebuilt="$rebuilt$arg
"
    done
    set --
    for arg in $rebuilt; do
      set -- "$@" "$arg"
    done
    IFS=$old_ifs
    set +f
    echo "card-service: 使用数据卷副本 $INSTALL_DIR/$entry" >&2
    exec "$interp" "$@"
  fi
fi

exec "$@"
