#!/usr/bin/env bash
#
# ESM 语法检查（逐个源文件解析）。
#
# 为什么不能只用 `node --check src/**/*.js`：
#   `node --check` 是否按 ES module 解析，取决于最近的 package.json 的 "type"。
#   一旦被当成 CommonJS，含 import 语句的文件会**静默返回成功** ——
#   连 `const A = 1; const A = 2;` 这种重复声明都查不出来（Node 22 实测踩过）。
#   仓库根目录的 package.json 已声明 "type": "module"，所以这里可以直接检查。
#
# 用法：bash tools/check.sh   （或 npm run check）
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
n=0

while IFS= read -r f; do
  n=$((n + 1))
  if ! err="$(node --check "$f" 2>&1)"; then
    fail=$((fail + 1))
    echo "✗ ${f#"$root"/}"
    printf '%s\n' "$err" | sed -n '1,3p' | sed 's/^/    /'
  fi
done < <(find "$root/src" -name '*.js' | sort)

if [ "$fail" -eq 0 ]; then
  echo "✓ $n 个源文件按 ES module 解析全部通过"
else
  echo
  echo "✗ $fail/$n 个文件存在语法错误"
  exit 1
fi
