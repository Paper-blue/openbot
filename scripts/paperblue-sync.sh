#!/usr/bin/env bash
# Merge upstream OpenBot into our maintenance branch, then rebuild the app.
#
#   scripts/paperblue-sync.sh            merge and build
#   scripts/paperblue-sync.sh --plan     print the steps, change nothing
#   OPENBOT_SKIP_BUILD=1 scripts/paperblue-sync.sh   merge only
#
# See PAPERBLUE-FORK.md for what our branch carries and how to resolve a conflict.
set -euo pipefail

branch="${OPENBOT_MAINTENANCE_BRANCH:-maintenance}"
upstream_ref="${OPENBOT_UPSTREAM_REF:-upstream/main}"
plan=0
[ "${1:-}" = "--plan" ] && plan=1

# git and the package registry work directly here; the local proxy drops some of these hosts.
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
  unset "$name" 2>/dev/null || true
done

step() { printf '\n== %s\n' "$1"; }

require_clean_tree() {
  if ! git diff-index --quiet HEAD --; then
    echo "工作区有未提交的改动。先提交或 stash，再合并上游。" >&2
    exit 1
  fi
}

require_branch() {
  local current
  current=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current" != "$branch" ]; then
    echo "当前在 $current 分支。先 git switch $branch 再运行。" >&2
    exit 1
  fi
}

step "检查仓库状态"
if [ "$plan" = 1 ]; then
  echo "would: git diff-index --quiet HEAD --   (工作区必须干净)"
  echo "would: git rev-parse --abbrev-ref HEAD  (必须是 $branch)"
  echo "would: git fetch upstream --prune"
  echo "would: git merge --no-ff $upstream_ref"
  echo "would: bun install --frozen-lockfile   (只有 bun.lock 变动时才需要)"
  echo "would: bun run package                 (构建未签名的 macOS .app)"
  echo "would: 跑 PAPERBLUE-FORK.md 里的验收清单"
  exit 0
fi
require_clean_tree
require_branch
echo "在 $branch 分支，工作区干净。"

step "取上游"
git fetch upstream --prune
behind=$(git rev-list --count "HEAD..$upstream_ref")
echo "$upstream_ref 比我们多 $behind 个提交。"
if [ "$behind" = 0 ]; then
  echo "已是最新，不需要合并。"
  exit 0
fi
git --no-pager log --oneline "HEAD..$upstream_ref" | head -15

step "合并"
if ! git merge --no-ff "$upstream_ref"; then
  cat >&2 <<'EOF'

上游与我们的补丁冲突，合并没有完成。

补丁点（见 PAPERBLUE-FORK.md）：
  packages/ui/src/features/account/AppLoadingScreen.tsx       加载页默认走 calm 场景
  src/main/index.ts                                           disable-features 的调用点
  src/main/private-network-chromium-features.ts               private 路由下关掉 mDNS 混淆

解法：以上游的实现为底，把我们的行为重新加回去（两个补丁都只有几行）。
完成后 git add <file> && git commit；不想继续就 git merge --abort。
EOF
  exit 1
fi
echo "合并完成：$(git rev-parse --short HEAD)"

if [ "${OPENBOT_SKIP_BUILD:-0}" = 1 ]; then
  echo "OPENBOT_SKIP_BUILD=1，跳过构建。"
  exit 0
fi

step "安装依赖"
bun install --frozen-lockfile

step "构建 macOS 应用"
bun run package

cat <<'EOF'

== 验收清单（PAPERBLUE-FORK.md 有详细版）
  1. 新的 OpenBot.app 能启动，仓库与对话正常。
  2. 切换服务器时加载页是单只毛绒 + 状态文字，不是满屏毛绒。
  3. 主机在 private 路由下连接可用，能力协商在几秒内完成。
  4. 导入助手能打开文件选择框。
EOF
