#!/bin/sh
# Add the TapeAPI signing sidecar to the new-api compose you ALREADY run, on a hostname of its own.
# 把 TapeAPI 签名旁路加进你**已经在跑**的 new-api compose，并给它一个单独的主机名。
#
#   sh add-sidecar.sh /path/to/your/new-api            (run it from this directory of a tapeapi checkout, on YOUR server)
#   sh add-sidecar.sh --no-build --no-up /path/...     (only the file steps / 只做文件准备)
#
# What it does, in order, and nothing else / 它依次做这些事，别的都不做:
#   1. copies three files next to your compose file, never overwriting one that exists:
#      docker-compose.sidecar.yml, tapeapi-sidecar.env (from tapeapi-sidecar.env.example, mode 600), tapeapi-models.json
#      (from models.example.json). Your own compose file and .env are not touched.
#      把三个文件复制到你的 compose 文件旁边，已存在的一律不覆盖；你自己的 compose 文件与 .env 不动。
#   2. builds the sidecar image from this checkout (docker build; nothing pulled from a registry but node:22-alpine).
#      由本检出构建旁路镜像。
#   3. starts the sidecar alone: docker compose -f <your compose file> -f docker-compose.sidecar.yml up -d tapeapi-sidecar
#      (new-api is not restarted). 只启动旁路（不重启 new-api）。
#   4. asks the sidecar for its signing ADDRESS (GET /tapeapi/v1/health inside the container) and prints it.
#      向旁路询问签名**地址**并打印。
#
# The signing key is made inside the container at its first start and stays in the volume tapeapi-signer on this
# server. This script never reads, prints or sends the key: it only ever sees the address, which is public.
# 签名密钥在容器第一次启动时于容器内生成，只保存在本服务器的卷 tapeapi-signer 里。本脚本从不读取、打印或发送密钥：它只看得到公开的地址。
# Nothing here contacts TapeAPI or anyone else. / 这里没有任何东西联系 TapeAPI 或其他任何人。
set -eu

usage() {
  cat <<'EOF'
usage: sh add-sidecar.sh [--no-build] [--no-up] <directory of your new-api compose file>
  --no-build   the image tapeapi-new-api-sidecar:local is already built (or TAPEAPI_SIDECAR_IMAGE names another)
  --no-up      copy the files only; start nothing
用法：sh add-sidecar.sh [--no-build] [--no-up] <你的 new-api compose 文件所在目录>
EOF
}

say() { printf '%s\n' "$*"; }
die() { printf 'add-sidecar: %s\n' "$*" >&2; exit 2; }

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
IMAGE=${TAPEAPI_SIDECAR_IMAGE:-tapeapi-new-api-sidecar:local}
BUILD=1
UP=1
TARGET=''
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --no-up) UP=0 ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown option $a / 不认识的选项 $a" ;;
    *) [ -z "$TARGET" ] || { usage >&2; die 'one directory only / 只能给一个目录'; }; TARGET=$a ;;
  esac
done
[ -n "$TARGET" ] || { usage >&2; exit 2; }
[ -d "$TARGET" ] || die "no such directory: $TARGET / 目录不存在"
TARGET=$(CDPATH='' cd -- "$TARGET" && pwd)
[ "$TARGET" != "$HERE" ] || die 'give the directory of YOUR new-api compose file, not this example / 请给出你自己的 new-api compose 目录，而不是本示例目录'

BASE=''
for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [ -f "$TARGET/$f" ]; then BASE=$f; break; fi
done
[ -n "$BASE" ] || die "no compose file (compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml) in $TARGET / 该目录里没有 compose 文件"

# 1. Files, never overwritten. / 文件，从不覆盖。
copy_new() {
  if [ -e "$2" ]; then
    if cmp -s "$1" "$2"; then say "same     $2"; else say "kept     $2 (it exists: not overwritten / 已存在，未覆盖)"; fi
  else
    (umask 077 && cp "$1" "$2")
    chmod "$3" "$2"
    say "created  $2"
  fi
}
copy_new "$HERE/docker-compose.sidecar.yml" "$TARGET/docker-compose.sidecar.yml" 644
copy_new "$HERE/tapeapi-sidecar.env.example" "$TARGET/tapeapi-sidecar.env" 600
copy_new "$HERE/models.example.json" "$TARGET/tapeapi-models.json" 644

if [ "$UP" = 0 ] && [ "$BUILD" = 0 ]; then
  say ''
  say "Next: edit $TARGET/tapeapi-sidecar.env (PUBLIC_URL, FORMATS) and $TARGET/tapeapi-models.json, then run this again without --no-up."
  say "下一步：编辑 tapeapi-sidecar.env（PUBLIC_URL、FORMATS）与 tapeapi-models.json，然后去掉 --no-up 再运行一次。"
  exit 0
fi
command -v docker >/dev/null 2>&1 || die 'docker is not installed on this machine / 本机没有安装 docker'

# 2. The image, from this checkout. / 由本检出构建镜像。
if [ "$BUILD" = 1 ]; then
  say "building $IMAGE from $HERE"
  (cd "$HERE" && docker build --build-context sdk=../../sdk --build-context server=../../server -t "$IMAGE" .)
fi
[ "$UP" = 1 ] || exit 0

# 3. The sidecar alone; new-api keeps running as it is. / 只启动旁路；new-api 照常运行。
say "starting tapeapi-sidecar next to $TARGET/$BASE"
(cd "$TARGET" && TAPEAPI_SIDECAR_IMAGE="$IMAGE" docker compose -f "$BASE" -f docker-compose.sidecar.yml up -d tapeapi-sidecar)

# 4. The signing address, from the sidecar's health answer: an address is all this script ever reads.
# 签名地址，取自旁路的 health 回答：本脚本读到的只有地址。
SIGNER=''
TRIES=${TAPEAPI_ADD_SIDECAR_TRIES:-30}
i=0
while [ "$i" -lt "$TRIES" ]; do
  HEALTH=$(cd "$TARGET" && docker compose -f "$BASE" -f docker-compose.sidecar.yml exec -T tapeapi-sidecar wget -q -O - http://127.0.0.1:8080/tapeapi/v1/health 2>/dev/null || true)
  SIGNER=$(printf '%s' "$HEALTH" | sed -n 's/.*"signer":"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p')
  [ -z "$SIGNER" ] || break
  i=$((i + 1))
  [ "$i" -ge "$TRIES" ] || sleep 1
done

say ''
if [ -z "$SIGNER" ]; then
  say 'The sidecar did not report a signing address yet. See why with:'
  say '旁路还没有报出签名地址。用下面的命令查看原因：'
  say "  cd $TARGET && docker compose -f $BASE -f docker-compose.sidecar.yml logs tapeapi-sidecar"
  exit 1
fi
say "signing address (public) / 签名地址（公开值）: $SIGNER"
say 'The key itself stays in the volume tapeapi-signer on this server; this script never read it.'
say '密钥本身留在本服务器的卷 tapeapi-signer 里；本脚本从未读取它。'
say ''
say 'Next, all done by you / 下一步，全部由你自己完成:'
say "  1. put SIGNER_ADDRESS=$SIGNER in tapeapi-sidecar.env (a guard: a lost key volume then stops the sidecar instead of making a new key)"
say "     把 SIGNER_ADDRESS=$SIGNER 写进 tapeapi-sidecar.env（防护：密钥卷丢失时旁路会停下，而不是生成新密钥）"
say '  2. in the holder console, sign the delegation for exactly this address (OPERATOR-KIT.md, "A key made on the server")'
say '     在持有人操作台为**正是这个地址**签委托（见 OPERATOR-KIT.md“在服务器上生成的密钥”）'
say '  3. set DELEGATION_EXPIRES and DELEGATION_SIG in tapeapi-sidecar.env, then run the same docker compose up -d again'
say '     把 DELEGATION_EXPIRES、DELEGATION_SIG 填进 tapeapi-sidecar.env，再运行一次同样的 docker compose up -d'
