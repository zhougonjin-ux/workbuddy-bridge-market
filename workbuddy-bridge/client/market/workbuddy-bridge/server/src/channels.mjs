// 渠道能力矩阵（0.4.0）：把「哪些厂商能接、怎么接、为什么接不了」变成可查询的静态事实，
// 而不是散落在控制台/客户端里的置灰文案。
//
// status 取值：
//   ready        已内置登录（扫码/浏览器授权），点一下就能加号
//   importable   没有内置登录，但能从本机客户端配置里导入已登录的 token
//   aggregate    只能用自己的 API key，走「聚合渠道」泳道（agg:<name>/<model>）
//   unsupported  上游只提供客户端 OAuth、没有公开 API；第三方无法合规接入
//
// 这张表是产品口径的单一来源：控制台/客户端的灰卡文案与「去聚合渠道」按钮都由它驱动。

export const CHANNELS = [
  {
    id: 'codearts',
    name: 'CodeArts（华为云）',
    status: 'ready',
    login: 'oauth',
    note: '内置华为云 OAuth + PKCE + DPoP，浏览器授权后自动入号池',
  },
  {
    id: 'cn-cli',
    name: 'WorkBuddy 国内版',
    status: 'ready',
    login: 'device',
    note: '内置设备授权扫码；也可用「导入本机账号」免扫码',
  },
  {
    id: 'intl-cli',
    name: 'WorkBuddy 国际版',
    status: 'ready',
    login: 'device',
    note: '内置设备授权；国际版接口抖动较多，已做连接级重试',
  },
  {
    id: 'intl-work',
    name: 'WorkBuddy 国际工作版',
    status: 'ready',
    login: 'device',
    note: '内置设备授权',
  },
  {
    id: 'lobster',
    name: 'LobsterAI',
    status: 'unsupported',
    login: 'oauth-client-only',
    note: '上游只有客户端扫码登录，没有公开 API；接入需要逆向其加密协议，暂不做',
    alternatives: ['在本机登录 LobsterAI 后，等待上游开放 API', '把常用模型换到已接入的站点或聚合渠道'],
  },
  {
    id: 'qoder',
    name: 'Qoder',
    status: 'unsupported',
    login: 'oauth-client-only',
    note: '客户端 OAuth + 私有网关，无公开 endpoint',
    alternatives: ['用 Qoder 官方客户端；桥接无法复用其登录态'],
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    status: 'unsupported',
    login: 'oauth-client-only',
    note: '同上（国内版网关）',
    alternatives: ['用 Qoder 官方客户端；桥接无法复用其登录态'],
  },
  {
    id: 'trae',
    name: 'TRAE',
    status: 'unsupported',
    login: 'oauth-client-only',
    note: 'TRAE 只有客户端登录；其 Claude 型自定义模型可走 Anthropic 协议，但需要一个可用的上游 key',
    alternatives: ['若有 TRAE 提供的 API key，可用聚合渠道（OpenAI 兼容）接入'],
  },
  {
    id: 'cline',
    name: 'Cline / ClinePass',
    status: 'aggregate',
    login: 'apikey',
    note: 'ClinePass 订阅密钥直接走聚合渠道',
    alternatives: ['聚合渠道 → 选 ClinePass 预设 → 填 key'],
  },
];

/** 给控制台/客户端用的矩阵（附统计）。 */
export function channelMatrix() {
  const list = CHANNELS.map((c) => ({ ...c, alternatives: c.alternatives || [] }));
  const by = (s) => list.filter((c) => c.status === s).length;
  return {
    channels: list,
    summary: {
      total: list.length,
      ready: by('ready'),
      importable: by('importable'),
      aggregate: by('aggregate'),
      unsupported: by('unsupported'),
    },
  };
}