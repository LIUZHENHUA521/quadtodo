#!/usr/bin/env bash
# 把当前 coder worktree 分支合并回主仓库的 main 分支，并 rebuild web。
# 需要在主工作区 (/Users/liuzhenhua/Desktop/code/crazyCombo/quadtodo) 执行；
# 脚本自己会 cd，直接 bash .quadtodo-worktrees/.../scripts/merge-to-main.sh 也行。

set -euo pipefail

# 脚本可被放在任意 worktree 中，解析出"主仓库根目录"（common dir 的父目录）
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR="$(git -C "$THIS_DIR" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in
  /*) ;;
  *)  GIT_COMMON_DIR="$THIS_DIR/$GIT_COMMON_DIR" ;;
esac
MAIN_DIR="$(cd "$GIT_COMMON_DIR/.." && pwd)"

# 当前分支名（在被 merge 的那个 worktree 里读取）
SOURCE_BRANCH="$(git -C "$THIS_DIR" rev-parse --abbrev-ref HEAD)"
if [ "$SOURCE_BRANCH" = "main" ] || [ -z "$SOURCE_BRANCH" ]; then
  echo "error: 源分支看起来已经在 main，停止" >&2
  exit 1
fi

echo ">>> Merge source:  $SOURCE_BRANCH"
echo ">>> Main worktree: $MAIN_DIR"

cd "$MAIN_DIR"

# main 工作区必须干净，否则中断
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: main 工作区有未提交改动，先处理完再跑" >&2
  git status --short
  exit 1
fi

# 确认确实在 main
CURRENT_MAIN_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_MAIN_BRANCH" != "main" ]; then
  echo "error: 主工作区当前在 '$CURRENT_MAIN_BRANCH'，不是 main" >&2
  exit 1
fi

# non-ff merge，保留分支痕迹；有冲突自动中断
git merge --no-ff "$SOURCE_BRANCH" \
  -m "Merge $SOURCE_BRANCH"

echo ">>> merge 完成，HEAD=$(git rev-parse --short HEAD)"

# rebuild 前端（如无 web 目录就跳过）
if [ -d "$MAIN_DIR/web" ] && [ -f "$MAIN_DIR/web/package.json" ]; then
  echo ">>> rebuild web..."
  (cd "$MAIN_DIR/web" && npm run build)
else
  echo ">>> 无 web/ 目录，跳过 build"
fi

echo ">>> 全部完成。"
