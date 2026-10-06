#!/bin/sh
# 一键刷新看板：重新抓数据 → 重算统计 → 渲染自检
# 用法：sh update.sh     （在本目录下执行即可）
set -e
cd "$(dirname "$0")"
echo "① 抓取数据"
node scripts/fetch.mjs
echo
echo "② 重算统计"
node scripts/build.mjs
echo
echo "③ 渲染自检"
node scripts/verify.mjs
echo
echo "完成。刷新 index.html 即可看到新数据。"
