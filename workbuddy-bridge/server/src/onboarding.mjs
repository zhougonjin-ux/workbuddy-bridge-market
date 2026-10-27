// 首次使用向导：把「装 Node → 加账号 → 接选择器 → 拿 key」变成可勾选清单。
//
// 拆成独立模块而不是塞在 console-api 的单函数里：这部分是「产品引导」，
// 与账号/模型/任务的管理接口没有共享状态，单独放才能写纯函数测试。
import fs from 'node:fs';
import { siteKeys, primaryKey } from './config.mjs';
import { listAccounts } from './pool.mjs';
import { providerConfigTarget, PROVIDER_ID, CODEARTS_PROVIDER_ID } from './pickersync.mjs';

/**
 * 纯函数：根据四项事实生成清单。抽出来是为了能测「缺什么就显示什么」，
 * 不用起服务、不用碰真实数据目录。
 */
export function buildOnboardingSteps({ major, nodeVersion, accountCount, providerOk, keyOk }) {
  const steps = [
    {
      id: 'node',
      ok: major >= 20,
      title: 'Node.js 运行时',
      detail: `v${nodeVersion}${major >= 20 ? '' : '（需要 ≥ 20）'}`,
      action: major >= 20 ? '' : '到 nodejs.org 安装 LTS，装完重启 ZCode',
      href: '',
    },
    {
      id: 'account',
      ok: accountCount > 0,
      title: 'WorkBuddy 账号',
      detail: accountCount > 0 ? `已入池 ${accountCount} 个` : '还没有可用账号',
      action: accountCount > 0 ? '' : '扫码登录，或运行 /wbp-import 导入本机已登录客户端',
      href: '#/login',
    },
    {
      id: 'provider',
      ok: providerOk,
      title: '接入 ZCode 模型选择器',
      detail: providerOk ? '已写入 provider_config.json' : '尚未写入',
      action: providerOk ? '' : '点「资源池 → 模型 → ⟳ 手动同步」，或重开一次会话触发钩子',
      href: '#/models',
    },
    {
      id: 'key',
      ok: keyOk,
      title: '本机 API Key',
      detail: keyOk ? '已配置（请求需要鉴权）' : '未配置（本机任何程序都能调用）',
      action: keyOk ? '' : '到「系统设置」生成一个 key，再复制给 ZCode',
      href: '#/settings',
    },
  ];
  const done = steps.filter((s) => s.ok).length;
  return { steps, done, total: steps.length, allDone: done === steps.length };
}

/** provider_config.json 里是否已经有我们写的供应商条目（只读，不触发同步）。 */
export function providerRegistered(target = providerConfigTarget()) {
  try {
    const raw = fs.readFileSync(target, 'utf8');
    return raw.includes(`"${PROVIDER_ID}"`) || raw.includes(`"${CODEARTS_PROVIDER_ID}"`);
  } catch {
    return false;
  }
}

/** 服务端组合：读当前配置与数据目录，返回给控制台。 */
export function onboardingStatus(cfg) {
  const major = Number(String(process.versions.node).split('.')[0]) || 0;
  const accountCount = siteKeys(cfg)
    .flatMap((site) => listAccounts(site))
    .filter((a) => a.enabled !== false).length;
  const base = buildOnboardingSteps({
    major,
    nodeVersion: process.versions.node,
    accountCount,
    providerOk: providerRegistered(),
    keyOk: Boolean(primaryKey(cfg)),
  });
  return { ok: true, ...base, port: cfg.port, tasksRiskAccepted: cfg.tasks?.riskAccepted === true };
}