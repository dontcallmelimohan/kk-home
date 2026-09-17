#!/bin/bash
# kk-home 服务器端部署脚本。在仓库根目录执行：./deploy.sh
#
# 上一版有三个坑，都改了：
#   1. 那个文件里存的是 `cat > deploy.sh <<'EOF' ... EOF` 这整段命令原文，
#      不是脚本本身。跑它的第一次只会把文件自我重写一遍，什么都没部署；
#      而且是 bash 一边读一边被覆盖，行为碰运气。
#   2. `git pull` 失败也照样往下走，最后用旧代码重启 —— 看起来「部署成功」，
#      线上其实一个字都没变。data/ 被提交进了仓库，而它是站点运行时
#      一直在写的数据（后台发文章、留言板、体重记录），服务器本地一改，
#      pull 就会被 git 拒绝。这正是「改了代码但线上没反应」的来源。
#   3. `pm2 logs 0 --lines 10` 少了 --nostream，它是流式 tail 不会退出，
#      脚本会永远卡在最后一步。
set -euo pipefail

cd "$(dirname "$0")"

APP="${APP:-wenwen-blog}"   # pm2 里的进程名，用 `pm2 list` 查
PORT="${PORT:-3000}"

echo "===== 1/4 拉取代码 ====="
git pull --ff-only

echo "===== 2/4 依赖 ====="
# 本站零依赖，只用 Node 内置模块，没有 npm install 这一步。
node -e '
const p = require("./package.json");
const deps = Object.keys(p.dependencies || {});
if (deps.length) {
  console.error("检测到依赖，请先手动 npm install：" + deps.join(", "));
  process.exit(1);
}
console.log("  零依赖，跳过 npm install");
'

echo "===== 3/4 重启服务 ====="
pm2 restart "$APP" --update-env

echo "===== 4/4 部署后自检 ====="
sleep 1
if ! curl -fsS "http://127.0.0.1:$PORT/api/health"; then
  echo
  echo "❌ 健康检查没过，去看日志：pm2 logs $APP --lines 50"
  exit 1
fi
echo
# 页面能打开 ≠ 页内资源取得到。上次 2048 就是页面 200、CSS 和脚本全 404，
# 所以这里把静态资源的真实地址也打一遍。
for p in /lab /lab/2048 /lab/2048/style/main.css /lab/2048/js/game_manager.js; do
  printf '  %s  %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$p")" "$p"
done

echo "===== 最近日志 ====="
pm2 logs "$APP" --lines 10 --nostream
