#!/usr/bin/env node
/**
 * 把 web/ 前端 + cloudflare/worker.js 打包成 Cloudflare Pages 的发布目录 dist/
 * ----------------------------------------------------------------
 * Pages 的「高级模式」：发布目录里放一个 _worker.js，它就接管所有请求，
 * 静态文件通过 env.ASSETS 取。我们的 worker.js 本来就是这么写的，直接复制即可。
 *
 * 用法：node cloudflare/build-pages.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const WORKER = path.join(__dirname, 'worker.js');
const DIST = path.join(ROOT, 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. 静态文件
let n = 0;
for (const name of fs.readdirSync(WEB)) {
  const src = path.join(WEB, name);
  if (fs.statSync(src).isFile()) {
    fs.copyFileSync(src, path.join(DIST, name));
    n++;
  }
}

// 2. 后端：改名成 _worker.js（Pages 高级模式的约定文件名）
const worker = fs.readFileSync(WORKER, 'utf8');
fs.writeFileSync(path.join(DIST, '_worker.js'),
  worker.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '')   // 去掉文件头注释，避免被误认为构建产物
        , 'utf8');

console.log('已生成 dist/：静态文件 ' + n + ' 个 + _worker.js');
console.log('接下来执行：npx wrangler pages deploy dist --project-name=lab-inventory-qwm9527 --branch=main');
