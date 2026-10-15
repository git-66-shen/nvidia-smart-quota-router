#!/bin/sh
# NVIDIA Smart Quota Router 测试入口。
# 运行全部 70 项自动化测试（模拟 NVIDIA 端点，不接触真实 API、不消耗任何配额）。
#
# 前提：本目录位于 DSH 源码检出内（测试通过祖先链解析真实 @deepseek-ai/* 工作区包，
# 并经 tsx 加载其 TS 源码），且存在 Node >= 22 与检出根的依赖。
#
# 用法：sh tests/run.sh [检出根目录]
#   环境变量 DSH_NODE 可指定 Node 可执行文件（默认自动探测）。

set -e
CHECKOUT="${1:-$(cd "$(dirname "$0")/../../.." && pwd)}"

if [ -n "$DSH_NODE" ]; then
  NODE="$DSH_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE=node
else
  NODE="/vol1/@appdata/trim.hermes/旧hermes配置文件/node/bin/node"
fi

cd "$CHECKOUT"
exec "$NODE" --import tsx/esm --test "项目/nvidia-smart-quota-router/tests/"
