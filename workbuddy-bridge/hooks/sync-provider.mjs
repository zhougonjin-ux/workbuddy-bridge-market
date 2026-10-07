// SessionStart 钩子：把 WorkBuddy 供应商注册进 ZCode 的模型选择器（幂等，绝不阻塞会话）。
//
// 这是「快路径」：会话启动时立刻同步一次。常规的持续同步由服务端定时循环做
// （server/src/pickersync.mjs 的 startProviderConfigSync），两边共用同一份实现。
//
// 行为：
//   1) 读数据目录（~/.zcode/workbuddy-bridge）里的 config.json 拿端口和 apiKey
//   2) 调 runProviderConfigSync：拉 /v1/models → 合并写入 ~/.zcode/v2/provider_config.json
//      （代理没起来就退回 config.models；一个模型都拿不到且没注册过就等下次）
// 任何异常都静默退出（exit 0），绝不影响 ZCode 会话启动。
// 数据目录放 sync-provider.json {"enabled":false} 可关闭本钩子。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProviderConfigSync } from '../server/src/pickersync.mjs';

const main = async () => {
  try {
    const dataDir = process.env.WB_CONFIG_DIR || path.join(os.homedir(), '.zcode', 'workbuddy-bridge');

    // 同步开关（默认开）
    try {
      const gate = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync-provider.json'), 'utf8'));
      if (gate.enabled === false) return;
    } catch {
      /* 没有开关文件 = 默认开 */
    }

    let port = 8788;
    let apiKey = null;
    let fallbackModels = [];
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
      if (Number.isInteger(cfg.port) && cfg.port > 0) port = cfg.port;
      // apiKey 支持字符串或字符串数组（config 一等格式，多客户端多密钥）：数组时取第一个有效值
      if (typeof cfg.apiKey === 'string' && cfg.apiKey) apiKey = cfg.apiKey;
      else if (Array.isArray(cfg.apiKey)) apiKey = cfg.apiKey.find((k) => typeof k === 'string' && k) || null;
      if (Array.isArray(cfg.models)) {
        fallbackModels = cfg.models
          .map((m) => (typeof m === 'string' ? m : m?.id))
          .filter((id) => typeof id === 'string' && id);
      }
    } catch {
      /* 还没生成过配置：没有 apiKey 就没事可做 */
    }
    if (!apiKey) return;

    await runProviderConfigSync({ port, apiKey, fallbackModels });
  } catch {
    /* 吞掉一切，hook 失败不该影响会话 */
  } finally {
    process.exit(0);
  }
};

main();
