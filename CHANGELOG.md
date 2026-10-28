# 更新日志

## 0.4.0（2026-10-28）

### 桌面客户端

- **一键更新插件**：客户端设置页「一键更新插件」→ 服务端下载 GitHub tarball（4 个源自动回退）→
  校验版本 → 整目录备份 `.bak-<时间戳>` → 覆盖 → 自动重启服务。失败会给出可读原因，不会半装。
- **看门狗**：每 60 秒探活；连续两次失败自动拉起服务，托盘图标按 0=停止 / 1=运行 / 2=异常 三态着色。
- **用量页**：时间范围（1/7/30 天）+ 模型/站点关键字筛选、每日调用趋势柱状图、汇总行；
  数据来自新接口 `/console/api/usage/filter`。
- **事件页**：服务端 `/console/api/events` 的结构化时间线（时间/类型/内容），排障时不用再开网页。
- **账号导入导出**：勾选账号 → 导出为 JSON（含 token，界面有提示）；选择 JSON → 导入（同 uid 自动覆盖）。
- **深色模式**：设置页一键切换，递归重着色基础底色与正文色，强调色保持不变；随窗口状态一起持久化。
- **登录页灰卡可操作**：未内置登录的厂商（LobsterAI / Qoder / Qoder CN / TRAE / Cline）不再是无响应按钮，
  改为「如何接入」说明 + 一键跳到聚合渠道。

### 服务端

- **局域网访问**（`lan.enabled`，默认关闭）：监听 `0.0.0.0`，控制台允许同端口私网来源（RFC1918 / `.local`），
  可在 `lan.allowOrigins` 追加额外来源；`/v1/*` 始终要求 apiKey。启动日志会列出可用局域网地址与安全提示。
- **项目级配置**（`projects.enabled` + `projects.map`）：按 `X-WB-Project` 头或 `project` 字段覆盖默认站点/模型；
  只覆盖站点与默认模型，不改进程级调度策略（避免并发请求互相踩）。
- **模型 ID 去后缀**（`pickerStripSuffix`，默认关闭）：`/v1/models` 额外列出一个裸 ID 条目并登记内存别名，
  原 ID 保留；已知后缀仅 `-free/-thinking/-reasoner/-preview` 与 CodeArts 的 `-NNNN` 版本号。
- **单账号导出/导入**：`GET /console/api/account/export`、`POST /console/api/account/import`。
- **渠道能力矩阵**：`GET /console/api/channels`，状态分 ready / importable / aggregate / unsupported，
  并给每家的替代接法。
- **聚合渠道预设 70 → 73**：新增 Ollama、LM Studio、LLaMA.cpp（`http://localhost:*`，密钥可随意填）。
- **/bridge 增加 `lan.enabled` 与 `pickerStripSuffix`**，供客户端设置页回填。

### 工程

- `npm run check:routes`：扫描服务端路由与控制台/客户端调用点，抓前后端路径漂移。
- `npm run e2e`：临时配置目录 + 独立端口起隔离实例，覆盖 health / 控制台 HTML / 鉴权 401 /
  `/v1/models` / 新接口 / 非本机 Origin 403 / 未知路径 404 / 优雅关闭，共 12 项断言。
- `npm run coverage`：加最低阈值（行 45%、分支 60%），CI 低于阈值直接失败。
- CI 增加路由一致性与端到端冒烟两步。
- `.gitignore` 补 `.opencode/`、`.diag-extract.mjs`。

### 已知限制

- LobsterAI / Qoder / Qoder CN / TRAE 上游只有客户端 OAuth，没有公开 API，**未做逆向接入**；
  渠道矩阵与客户端会给出替代方案（自有 key → 聚合渠道）。
- 控制台 `app.js` 仍是单文件大脚本；`console-api.mjs` 仍是 83 条 `if` 路由链。
  这次只加了「路由一致性检查」这一可验证的护栏，没有做大规模重构——重构需要配套的浏览器回归测试，
  否则收益不抵风险。
- 二维码过期倒计时未做（登录页会直接展示上游返回的状态与错误，过期后重新发起即可）。