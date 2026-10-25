// WorkBuddy 桌面客户端 at-rest 凭证解密（0.3.43）。
//
// 桌面客户端 5.6.0 起把 auth.accessToken / refreshToken 存成字段包装：
//   { "$wbEncrypted": 1, "envelope": "<base64 JSON>" }
// envelope = {suite, keyId, nonce, authTag, ciphertext}，AES-256-GCM（12B nonce
// + 16B tag），AAD 是 scheme/suite/keyId/framing 的长度前缀转录——密文只能为
// 被封时的字段形状打开。
//
// 字段密钥不是用户秘密：它是编译进 app 自己的 Electron native 模块
// （electron_browser_workbuddy_storage）的构建期常量。app 通过 loggerGet()
// 拿到它，并对返回的 base64 **字符串**（不解码）做 SHA-256 得 32 字节密钥；
// keyId 是密钥 SHA-256 的前 16 个 hex。
//
// 本模块通过**让已安装的 app 自己交出 payload** 重建同一把密钥：用
// ELECTRON_RUN_AS_NODE=1 把 WorkBuddy.exe 当普通 Node 跑，调用它自带的
// native binding——问的正是写文件的那个构建，插件永远不需要内置任何
// 构建期常量副本。子进程无 stdin、有硬超时，只读 stdout。
//
// 溯源：移植自 XDTrees/dsh-xdpool 的 src/at-rest.ts（MIT），其原始出处是
// dingminhua/dsh-connect-workbuddy 的同名模块（MIT，Copyright (c) 2026
// LaoDing）——该模块最先定位并修复了「5.6.0 起凭据加密」问题。本移植按
// 本项目风格精简为 ESM，保留全部判定逻辑（AAD 转录、keyId 校验、Windows
// 控制台编码尝试、注册表定位、负缓存、单构建失败不毒化）。
import { execFile, execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一个 `$wbEncrypted` 字段包装，本模块唯一打开的形状。 */
export function isEncryptedFieldWrapper(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const wrapper = value;
  const keys = Object.keys(wrapper).sort();
  return keys.length === 2
    && keys[0] === '$wbEncrypted'
    && keys[1] === 'envelope'
    && wrapper.$wbEncrypted === 1
    && typeof wrapper.envelope === 'string';
}

/** envelope framing 名 → AAD 单字节码；凭证字段只用 field。 */
const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
/** 转录进 AAD 的标准格式标识。 */
const STANDARD_FORMAT_ID = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
const AAD_DOMAIN = Buffer.from('WB-AAD\0', 'ascii');
const SYMMETRIC_SCHEME = 'sym-v1';
/** 覆盖桌面客户端可执行文件路径的环境变量。 */
export const WORKBUDDY_APP_EXECUTABLE_ENV = 'WORKBUDDY_APP_EXECUTABLE';
/** 给 app 30 秒作答：冷机首次 spawn 光自身就要几秒（实测 4.5s）。成功后进程内缓存，代价只付一次。 */
const KEY_FETCH_TIMEOUT_MS = 30_000;
/** 密钥全扫失败后的负缓存时长：别让每次读凭证都 spawn 一遍找不到的 app。 */
const KEY_FAILURE_BACKOFF_MS = 60_000;

const encodeUint32 = (value) => {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const encodeLengthPrefixed = (value) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeUint32(bytes.length), bytes]);
};

/** 一个 sym-v1 FIELD 信封的 AAD：形状错一个字节 GCM 就打不开，这正是防混淆设计。 */
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
  if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error('workbuddy: envelope keyId is malformed');
  return Buffer.concat([
    AAD_DOMAIN,
    Buffer.from([1]),
    encodeLengthPrefixed(STANDARD_FORMAT_ID.field),
    encodeLengthPrefixed(scheme),
    encodeUint32(suite),
    encodeLengthPrefixed(keyId),
    Buffer.from([FRAMING_CODE.field]),
    Buffer.from([0]), // field framing 无 sequence
    Buffer.from([0]), // final === undefined
  ]);
}

/** 派生密钥的 at-rest keyId：SHA-256 前 16 hex。信封的 keyId 与它对不上就大声失败。 */
export function deriveAtRestKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** 从 app 的密钥 payload JSON 派生 32 字节字段密钥。注意 hash 的是 base64 字符串本身。 */
export function deriveAtRestKey(payloadJson) {
  let payload;
  try { payload = JSON.parse(payloadJson); } catch { throw new Error('workbuddy: at-rest key payload is not valid JSON'); }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('workbuddy: at-rest key payload is not an object');
  }
  const secret = payload.atRestSecretKey;
  if (typeof secret !== 'string' || secret === '') {
    throw new Error('workbuddy: at-rest key payload carries no atRestSecretKey');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 用派生密钥打开一个加密字段。GCM tag 不匹配=转录或密钥错误，必须响亮失败而非截断 token。 */
export function openEncryptedField(field, key) {
  let envelope;
  try { envelope = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8')); } catch { throw new Error('workbuddy: encrypted field envelope is not valid JSON'); }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new Error('workbuddy: encrypted field envelope is not an object');
  }
  const { suite, keyId, nonce, authTag, ciphertext } = envelope;
  if (typeof suite !== 'number' || typeof keyId !== 'string') throw new Error('workbuddy: encrypted field envelope is missing suite or keyId');
  if (typeof nonce !== 'string' || typeof authTag !== 'string' || typeof ciphertext !== 'string') {
    throw new Error('workbuddy: encrypted field envelope is missing nonce, authTag or ciphertext');
  }
  const expectedKeyId = deriveAtRestKeyId(key);
  if (keyId !== expectedKeyId) throw new Error(`workbuddy: encrypted field belongs to key ${keyId}, not the available key ${expectedKeyId}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(fieldAad(keyId, suite));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** 信封要求的 keyId（读不动返回 undefined）：同机装国内+国际两个构建时按它选钥匙。 */
export function encryptedFieldKeyId(field) {
  try {
    const record = JSON.parse(Buffer.from(field.envelope, 'base64').toString('utf8'));
    return typeof record.keyId === 'string' ? record.keyId : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------- 定位桌面客户端可执行文件 ---------------- */

/**
 * Windows 控制台子进程可能输出的编码，按可能性排序。reg.exe 按**活动代码页**
 * 写出：中文 Windows（936）返回的路径里「腾讯」是 GBK 字节，按 UTF-8 解码必乱。
 * 每个编码都**试**而不是猜：第一个解出可用文本的赢。
 */
const WINDOWS_CONSOLE_ENCODINGS = ['utf-8', 'gbk', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'];

function decodeWindowsConsole(buf, accept) {
  for (const label of WINDOWS_CONSOLE_ENCODINGS) {
    let text;
    try { text = new TextDecoder(label, { fatal: false }).decode(buf); } catch { continue; }
    if (accept(text)) return text;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/** 去掉 DisplayIcon 的 `"<path>",<index>` 装饰。 */
const cleanIconPath = (raw) => raw.replace(/^"/u, '').replace(/",-?\d+$/u, '').replace(/,-?\d+$/u, '').trim();

const UNINSTALL_KEY_ROOTS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** 注册表是唯一权威答案：非默认盘符/改名目录/异名可执行文件，固定路径探测都看不见。 */
function windowsRegistryAppPaths() {
  if (process.platform !== 'win32') return [];
  const viaPowerShell = windowsRegistryAppPathsViaPowerShell();
  if (viaPowerShell.length > 0) return viaPowerShell;
  return windowsRegistryAppPathsViaReg();
}

/** PowerShell 读注册表：走 API 无代码页问题，中文路径完好。失败回落 reg.exe。 */
function windowsRegistryAppPathsViaPowerShell() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    "$roots=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',"
      + "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',"
      + "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
    'foreach($r in $roots){',
    '  Get-ItemProperty -Path $r | ForEach-Object {',
    "    $dn=[string]$_.DisplayName; $di=[string]$_.DisplayIcon; $il=[string]$_.InstallLocation",
    "    if($dn -match 'WorkBuddy|CodeBuddy' -or $di -match 'WorkBuddy|CodeBuddy'){",
    "      if($di -ne ''){ Write-Output $di }",
    "      if($il -ne ''){ Write-Output $il }",
    '    }',
    '  }',
    '}',
  ].join('\n');
  let stdout;
  try {
    stdout = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const out = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const cleaned = cleanIconPath(line.trim());
    if (cleaned !== '') out.push(cleaned);
  }
  return out;
}

/** reg.exe 兜底（无 PowerShell 的机器）：输出按字节捕获，用能解出存在路径的编码解码。 */
function windowsRegistryAppPathsViaReg() {
  const out = [];
  for (const root of UNINSTALL_KEY_ROOTS) {
    let listingBuf;
    try {
      listingBuf = execFileSync('reg', ['query', root, '/s', '/v', 'DisplayName'], {
        timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
      });
    } catch { continue; }
    const listing = decodeWindowsConsole(listingBuf, (text) => /WorkBuddy|CodeBuddy/iu.test(text));
    const keys = listing.split(/\r?\n(?=HKEY_)/u).filter((block) => /WorkBuddy|CodeBuddy/iu.test(block));
    for (const key of keys) {
      const keyPath = /^(HKEY_[^\r\n]+)/u.exec(key)?.[1]?.trim();
      if (keyPath === undefined) continue;
      for (const name of ['DisplayIcon', 'InstallLocation']) {
        let valueBuf;
        try {
          valueBuf = execFileSync('reg', ['query', keyPath, '/v', name], { timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 });
        } catch { continue; }
        const value = decodeWindowsConsole(valueBuf, (text) => /^(REG_SZ|REG_EXPAND_SZ)/im.test(text) && /[A-Za-z]:\\/.test(text));
        for (const line of value.split(/\r?\n/u)) {
          if (!line.includes(name)) continue;
          const m = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.*)$/u.exec(line.trim());
          if (!m) continue;
          const cleaned = cleanIconPath(m[1].trim());
          if (cleaned !== '') out.push(cleaned);
        }
      }
    }
  }
  return out;
}

/** 探测顺序里的可执行文件名：WorkBuddyAI.exe 是国际版构建，两者可并存，名字不能假设。 */
const APP_EXECUTABLE_NAMES = ['WorkBuddy.exe', 'WorkBuddyAI.exe'];

/** 常见安装根下的候选（注册表之外的第二梯队）。 */
function wellKnownCandidates() {
  const out = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    for (const root of [localAppData + '\\Programs', programFiles, programFilesX86]) {
      for (const name of APP_EXECUTABLE_NAMES) {
        out.push(join(root, 'WorkBuddy', name));
        out.push(join(root, 'WorkBuddyAI', name));
        out.push(join(root, 'CodeBuddy', name));
      }
    }
  }
  return out;
}

/** 找桌面客户端可执行文件：env 覆盖 → 注册表 → 常见路径。找不到返回 undefined。 */
export function findWorkbuddyAppExecutable() {
  const override = process.env[WORKBUDDY_APP_EXECUTABLE_ENV];
  if (override && override.trim() !== '') {
    try { if (existsSync(override.trim())) return override.trim(); } catch { /* 继续探测 */ }
  }
  const candidates = [];
  for (const raw of windowsRegistryAppPaths()) {
    // DisplayIcon 形如 `<exe>,0`；InstallLocation 是目录。两种都归一成 exe 候选。
    const p = /\.exe$/i.test(raw) ? raw : join(raw, 'WorkBuddy.exe');
    candidates.push(p);
    candidates.push(p.replace(/WorkBuddy\.exe$/i, 'WorkBuddyAI.exe'));
  }
  candidates.push(...wellKnownCandidates());
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return candidate; } catch { /* 试下一个 */ }
  }
  return undefined;
}

/**
 * 用 app 自己的二进制当 Node（ELECTRON_RUN_AS_NODE）调它的 native binding，
 * 拿密钥 payload。binding 是 app 自己公开的这个值的取用面，所以插件永远
 * 不需要携带构建期常量副本。子进程无 stdin、硬超时、只读 stdout。
 */
export function fetchAtRestKeyPayload(executable) {
  return new Promise((resolve, reject) => {
    const source = "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}"
      + 'catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}';
    execFile(
      executable,
      ['-e', source],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: KEY_FETCH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`workbuddy: the desktop app did not provide its at-rest key (${String(stderr || '').trim() || error.message})`));
          return;
        }
        const payload = String(stdout).trim();
        if (payload === '') {
          reject(new Error('workbuddy: the desktop app returned an empty at-rest key payload'));
          return;
        }
        resolve(payload);
      },
    );
  });
}

/** 进程内密钥缓存：keyId → key。多构建并存时按信封 keyId 选。永不落盘。 */
const atRestKeyById = new Map();
let inflightKeys = undefined;
let lastKeyFailureAtMs = 0;

/** 加载所有桌面构建的 keyId。单个构建失败只跳过自己，不毒化别的构建。 */
export async function ensureAtRestKeys() {
  if (atRestKeyById.size > 0) return true;
  if (Date.now() - lastKeyFailureAtMs < KEY_FAILURE_BACKOFF_MS) return false;
  inflightKeys ??= (async () => {
    const candidates = [findWorkbuddyAppExecutable()].filter((c) => c && (function () { try { return existsSync(c); } catch { return false; } })());
    if (candidates.length === 0) {
      lastKeyFailureAtMs = Date.now();
      return;
    }
    let anySuccess = false;
    await Promise.all(candidates.map(async (executable) => {
      try {
        const payload = await fetchAtRestKeyPayload(executable);
        const key = deriveAtRestKey(payload);
        atRestKeyById.set(deriveAtRestKeyId(key), key);
        anySuccess = true;
      } catch {
        // 单个构建答不上来不许影响其他构建。
      }
    }));
    if (!anySuccess) lastKeyFailureAtMs = Date.now();
  })().finally(() => { inflightKeys = undefined; });
  await inflightKeys;
  return atRestKeyById.size > 0;
}

/**
 * 打开一个加密字段，返回明文字符串；不可打开返回 null（调用方自行降级为指引）。
 * 按 payload 命名的 keyId 选钥匙，多构建并存也不怕。
 */
export async function openEncryptedFieldAuto(field) {
  if (!isEncryptedFieldWrapper(field)) return null;
  await ensureAtRestKeys();
  const named = encryptedFieldKeyId(field);
  const key = (named && atRestKeyById.get(named)) || [...atRestKeyById.values()][0];
  if (!key) return null;
  try {
    return openEncryptedField(field, key);
  } catch {
    return null;
  }
}

/** 列出桌面客户端的认证目录（CodeBuddyExtension：国内版与国际版客户端共用它）。 */
export function desktopAuthDirs() {
  const home = homedir();
  const dirs = {
    win32: ['AppData', 'Local', 'CodeBuddyExtension'],
    darwin: ['Library', 'Application Support', 'CodeBuddyExtension'],
  };
  const rel = dirs[process.platform] || ['.local', 'share', 'CodeBuddyExtension'];
  return [join(home, ...rel, 'Data', 'Public', 'auth')];
}

/** 认证目录里的全部凭证文件（live + 历史快照，新者在前；国际版是 workbuddy-desktop-ai.info）。 */
export function desktopAuthFiles() {
  const out = [];
  for (const dir of desktopAuthDirs()) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries.filter((n) => n.endsWith('.info'))) {
      out.push(join(dir, name));
    }
  }
  out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return out;
}
