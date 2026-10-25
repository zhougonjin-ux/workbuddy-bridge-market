// 终端二维码渲染（0.3.40）：CLI（login.mjs）与 MCP（wb_login_start）共用。
// 手机微信「扫一扫」直接扫终端屏幕即可，不必再复制链接到浏览器。
//
// 编码器复用控制台 vendored 的 qrcode-generator（MIT，kazuhiko arase）—— 它是
// 纯 JS 无 DOM 依赖，但以 UMD/IIFE 形式挂全局，ESM import 拿不到导出，
// 所以用 new Function 执行后取全局 qrcode 函数（同一份文件控制台 <script> 也在用）。
//
// 渲染用 UTF-8 半块字符（█▀▄ 空格）：一行覆盖两行模块，高度省一半。
// 极性跟 qrcode-terminal 惯例 —— 暗模块用实心块（终端前景色）、亮模块用空格
// （终端背景色），现代扫码器（微信/系统相机）对这种反相二维码普遍自适应；
// 调用方必须同时打印授权链接兜底，QR 只是便利项，不承担唯一职责。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let qrcodeFn = null;

function loadQrcode() {
  if (qrcodeFn) return qrcodeFn;
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'console', 'qrcode.min.js');
  const src = fs.readFileSync(file, 'utf8');
  qrcodeFn = new Function(`${src}\n;return typeof qrcode !== 'undefined' ? qrcode : null;`)();
  if (typeof qrcodeFn !== 'function') throw new Error('qrcode-generator 加载失败（console/qrcode.min.js 缺失或损坏）');
  return qrcodeFn;
}

/**
 * 把文本渲染成终端二维码。返回多行字符串（不含尾随空白行）。
 * typeNumber 0 = 自动选最小可容纳版本；纠错级 M 兼顾扫描率与密度。
 * margin 是四周静区的模块数（QR 规范建议 ≥4，终端里 2 够用且省行数）。
 */
export function terminalQR(text, { margin = 2 } = {}) {
  const qrcode = loadQrcode();
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const cell = (r, c) => (r >= 0 && r < n && c >= 0 && c < n ? qr.isDark(r, c) : false);
  const lines = [];
  for (let row = -margin; row < n + margin; row += 2) {
    let line = '';
    for (let col = -margin; col < n + margin; col++) {
      // 半块字符的「亮」部分对应暗模块（反相渲染，见文件头注释）：
      // 上暗下暗=█；上暗下亮=▀；上亮下暗=▄；上亮下亮=空格
      const top = cell(row, col);
      const bottom = cell(row + 1, col);
      const dark = top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
      line += dark;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  // 去掉头部/尾部的全空行（静区行在终端里没意义，反而占高度）
  while (lines.length && !/\S/.test(lines[0])) lines.shift();
  while (lines.length && !/\S/.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}
