---
description: WorkBuddy 一键诊断：体检服务/配置/账号池/路由/数据文件，输出带级别的检查报告与修复建议
---

对 WorkBuddy 桥接做一次**只读体检**并渲染报告。

1. 请求 `GET http://127.0.0.1:8788/console/api/doctor`，请求头带 `Authorization: Bearer <数据目录 config.json 里的 apiKey>`（Bash 里可用：`curl -s -H "Authorization: Bearer $(node -pe "JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.zcode/workbuddy-bridge/config.json','utf8')).apiKey")" http://127.0.0.1:8788/console/api/doctor`）。
2. 按级别分组渲染 checks（❌ fail → ⚠️ warn → ✅ pass），fail/warn 项必须在表后附**修复建议**：
   - 未登录 / 401 → 建议 /wbp-login 扫码或 /wbp-import 导入本机登录态
   - 额度耗尽 → 建议等 6 小时 TTL 自动解除，或控制台「重置状态」
   - 数据目录不可写 → 检查磁盘/权限；用量与凭证落盘都会静默失败
   - 目录为空 / 白名单过滤光 → 检查 allowModels/excludeModels
   - 最近请求成功率低 → 看事件时间线与账号 last_error 定位是上游还是账号问题
3. 顶部一行汇总：`体检完成：✅ N 通过 · ⚠️ M 提醒 · ❌ K 失败（耗时 X 秒）`，全部通过时给一句「一切正常 🎉」。
4. 代理未启动（连接被拒）→ 提示先运行 /wbp-start，不要自行启动。

只读诊断，不修改任何状态；不要为了「顺便修复」执行写操作。

$ARGUMENTS
