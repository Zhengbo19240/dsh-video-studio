#!/usr/bin/env bash
# DSH 视频套件安装脚本（macOS / Linux）
#
# 用法（在仓库根目录）：
#   bash ./scripts/install.sh              # 默认装到 desktop profile
#   PROFILE=tui bash ./scripts/install.sh  # 指定 profile
#   WITH_PRESET=0 bash ./scripts/install.sh
#
set -euo pipefail

PROFILE="${PROFILE:-desktop}"
WITH_PRESET="${WITH_PRESET:-1}"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "仓库: $repo"
echo "profile: $PROFILE"
echo

command -v dsh >/dev/null 2>&1 || { echo "找不到 dsh 命令，先在 PATH 里装好 DeepSeek Harness"; exit 1; }

install_one() {
  local pkg="$1" dir="$2"
  [ -d "$dir" ] || { echo "缺目录: $dir"; exit 1; }
  echo "→ 安装 $pkg"
  dsh plugin --profile "$PROFILE" add "link:$dir"
}

install_one dsh-video-workbench "$repo/packages/video-table"
install_one dsh-video-brief     "$repo/packages/video-brief"
if [ "$WITH_PRESET" = "1" ]; then
  install_one dsh-video-preset  "$repo/packages/video-preset"
fi

cat <<'EOF'

插件已装。还差数据这一步（不做的话动效库和音效库是空的）：

  动效库：把 packages/motion-lib 复制到 ~/.dsh/motion-lib
          或设环境变量 DSH_MOTION_LIB 指向它
  音效库：npm run sounds:download   （下载到 ~/.dsh/sound-library）
          或设环境变量 DSH_SOUND_LIB

然后重启 DSH，在对话里说「打开视频工作台」。
EOF
