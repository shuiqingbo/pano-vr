#!/usr/bin/env bash
# 一键跑全部检查。
#   ./tools/run-checks.sh
#
# 包含：
#   1. 几何与代码一致性检查（Node）
#   2. 相机控制行为检查（Node + 真实 Three.js/OrbitControls）
#   3. Three.js 建场与着色器检查（Node）
#   4. 切面接缝检查（Python，读取真实 JPEG）
#   5. 视场角换算检查（Node，保证各屏幕都能看全）
#   6. 场景切换检查（Node，真实执行 app.js 的 loadScene）
#   7. 工具站前后端契约检查（Node）
set -uo pipefail

cd "$(dirname "$0")/.."

# 用系统自带的 python3 / node 即可。
# 如果设置了 DSH_PY / DSH_NODE 环境变量，则优先用它们
# （开发机上用的是内置运行时，其他人 clone 下来不需要管这些）。
PY="${DSH_PY:-python3}"
NODE="${DSH_NODE:-node}"

# 环境变量给了但路径不通时，回退到系统命令
command -v "$PY" >/dev/null 2>&1 || PY=python3
command -v "$NODE" >/dev/null 2>&1 || NODE=node

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "错误：找不到 python3，请先安装 Python 3" >&2
  exit 1
fi
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "错误：找不到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

# 提前检查 Python 依赖，避免跑到第 4 步才甩一堆 ImportError。
# 注意要写 `from PIL import Image`：只 `import PIL` 不会触发 _imaging 加载，
# 在 Pillow 装坏了的机器上会误判为可用。
if ! "$PY" -c "import numpy; from PIL import Image" >/dev/null 2>&1; then
  echo "错误：Python 缺少依赖，或 Pillow 不可用（需要 numpy / pillow）" >&2
  echo "    请先安装：  pip install pillow numpy" >&2
  # 注意用 ${PY}：后面紧跟全角括号时，$PY）会被当成变量名 PY）
  echo "    （当前解释器：${PY}）" >&2
  exit 1
fi

rc=0
step() {
  echo
  echo "════════════════════════════════════════════"
  echo " $1"
  echo "════════════════════════════════════════════"
}

step "1/7  几何与代码一致性"
"$NODE" tools/verify-logic.mjs || rc=1

step "2/7  相机控制行为"
"$NODE" tools/verify-controls.mjs || rc=1

step "3/7  Three.js 建场与着色器"
"$NODE" tools/verify-render.mjs || rc=1

step "4/7  切面接缝（真实 JPEG）"
"$PY" tools/check-seams.py || rc=1

step "5/7  视场角换算"
"$NODE" tools/verify-fov.mjs || rc=1

step "6/7  场景切换"
"$NODE" tools/verify-switch.mjs || rc=1

step "7/7  工具站前后端契约"
"$NODE" tools/verify-site.mjs || rc=1

echo
if [ "$rc" -eq 0 ]; then
  echo "全部检查通过 ✓"
else
  echo "存在失败项 ✗"
fi
exit "$rc"
