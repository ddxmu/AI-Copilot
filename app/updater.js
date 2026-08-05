// updater.js — AI Copilot 自动更新器（主进程，适配未签名 DMG 分发）
// 流程：拉取 GitHub raw 上的 latest.json → 比对版本 → 下载 Release DMG →
//       挂载 → 拷贝新 .app 到 staging → 写独立 apply 脚本 → relaunch 自安装
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app } = require('electron');

// ===== 配置（如需改仓库/分支，只动这里）=====
const REPO = 'ddxmu/AI-Copilot';
const MANIFEST_BRANCH = 'main';
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/${MANIFEST_BRANCH}/latest.json`;

function userData() { return app.getPath('userData'); }
function currentAppPath() { return path.resolve(app.getPath('exe'), '..', '..', '..'); }
function updateDir() { return path.join(userData(), '.update'); }

// ===== 工具 =====
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const doGet = (u, redirects) => {
      if (redirects > 10) return reject(new Error('重定向次数过多'));
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return doGet(new URL(res.headers.location, u).href, redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let written = 0;
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        res.on('data', (c) => {
          written += c.length;
          if (total && onProgress) onProgress(Math.floor((written / total) * 100));
        });
        out.on('finish', () => resolve(dest));
        out.on('error', reject);
      });
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

function attachDmg(dmg) {
  return new Promise((resolve, reject) => {
    execFile('hdiutil', ['attach', '-nobrowse', '-noautoopen', dmg], (err, stdout) => {
      if (err) return reject(err);
      const line = stdout.split('\n').find((l) => l.includes('/Volumes/'));
      const vol = line ? line.trim().split(/\s+/).pop() : null;
      if (!vol || !fs.existsSync(vol)) return reject(new Error('找不到 DMG 挂载点'));
      resolve(vol);
    });
  });
}

function detachDmg(vol) {
  return new Promise((resolve) => {
    execFile('hdiutil', ['detach', '-force', vol], () => resolve());
  });
}

function copyApp(src, dest) {
  return new Promise((resolve, reject) => {
    fs.rmSync(dest, { recursive: true, force: true });
    execFile('cp', ['-R', src, dest], (err) => (err ? reject(err) : resolve()));
  });
}

// 写独立安装脚本，脱离主进程在 app 退出后完成替换并重启
function relaunchAndApply(staging) {
  return new Promise((resolve) => {
    const target = currentAppPath();
    const updateRoot = path.dirname(staging);
    const script = `#!/bin/bash
sleep 2
rm -rf "${target}"
cp -R "${staging}" "${target}"
xattr -dr com.apple.quarantine "${target}" 2>/dev/null
rm -rf "${updateRoot}"
open "${target}"
`;
    const sp = path.join(updateDir(), 'apply.sh');
    fs.mkdirSync(updateDir(), { recursive: true });
    fs.writeFileSync(sp, script);
    fs.chmodSync(sp, 0o755);
    const child = spawn('bash', [sp], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { app.quit(); resolve(); }, 400);
  });
}

// ===== 对外 API =====
async function checkForUpdates() {
  const cur = app.getVersion();
  try {
    const m = await fetchJson(MANIFEST_URL);
    return {
      updateAvailable: compareVersions(m.version, cur) > 0,
      currentVersion: cur,
      version: m.version || '',
      notes: m.notes || '',
      pubDate: m.pubDate || '',
      dmgUrl: m.dmgUrl || '',
      sha256: m.sha256 || '',
    };
  } catch (e) {
    return { updateAvailable: false, currentVersion: cur, error: e.message };
  }
}

// cb: { onProgress(percent), onStage(text) }
async function downloadAndInstall(dmgUrl, cb = {}) {
  const tmpDmg = path.join(updateDir(), 'update.dmg');
  fs.mkdirSync(updateDir(), { recursive: true });
  cb.onStage && cb.onStage('下载更新包…');
  await downloadFile(dmgUrl, tmpDmg, (p) => cb.onProgress && cb.onProgress(p));
  cb.onStage && cb.onStage('挂载磁盘映像…');
  const vol = await attachDmg(tmpDmg);
  const srcApp = path.join(vol, 'AI Copilot.app');
  const staging = path.join(updateDir(), 'AI Copilot.app');
  cb.onStage && cb.onStage('复制新版本…');
  await copyApp(srcApp, staging);
  await detachDmg(vol);
  cb.onStage && cb.onStage('准备安装…');
  await relaunchAndApply(staging); // 内部会 app.quit，不会正常返回
}

module.exports = { checkForUpdates, downloadAndInstall, REPO, MANIFEST_URL };
