// updater.js — AI Copilot 自动更新器（主进程，适配未签名 DMG 分发）
// 升级机制还原自 v0.7.0（经用户验证「在线升级正常」的版本）：
//   · 拉取 GitHub raw 上的 latest.json → 比对版本
//   · 有通用增量包(patchUrl)则下载该 zip，解压覆盖 Resources/app（任何老版本都适用）
//   · 否则下载完整 DMG → 挂载 → 拷贝新 .app 到 staging
//   · 写独立 bash 脚本在后台完成「整包替换」；重启改由主进程 app.relaunch() 托管
//     （退出后替换，规避 macOS 禁止 app 运行时覆盖自身 bundle 的限制；
//      用 relaunch() 而非手写 open，避免 open 把还没退出的旧实例「激活」导致重启后仍是旧版本）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { app } = require('electron');
const { readZipEntries } = require('./office-replace');

// ===== 配置（如需改仓库/分支，只动这里）=====
const REPO = 'ddxmu/AI-Copilot';
const MANIFEST_BRANCH = 'main';
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/${MANIFEST_BRANCH}/latest.json`;

// 下载参数
const STALL_TIMEOUT_MS = 45000;      // 45 秒没收到数据视为假死
const MAX_RETRIES = 2;               // 含首次最多 3 次
const PROGRESS_THROTTLE_MS = 250;    // 进度事件最小间隔

function userData() { return app.getPath('userData'); }
function currentAppPath() { return path.resolve(app.getPath('exe'), '..', '..', '..'); }
function updateDir() { return path.join(userData(), '.update'); }

// 取得「真实」当前版本：直接读 Resources/app/package.json 的 version 字段。
// 注意：本应用打包后 Info.plist 的 CFBundleVersion 失真（恒为 0.7.2，不随版本更新），
// 若用 app.getVersion() 会让版本判断永远停留在 0.7.2，导致增量永远不匹配、升级紊乱。
function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(currentAppPath(), 'Contents', 'Resources', 'app', 'package.json'), 'utf8'));
    return pkg.version || app.getVersion();
  } catch (e) {
    return app.getVersion();
  }
}

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
    // 加缓存戳，避免 raw.githubusercontent.com CDN 缓存导致不能及时读到最新 latest.json
    const sep = url.includes('?') ? '&' : '?';
    const urlWithCb = `${url}${sep}_cb=${Date.now()}`;
    const req = mod.get(urlWithCb, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(new URL(res.headers.location, url).href).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
  });
}

function formatBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function downloadFile(url, dest, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onProgress, onStage } = opts;
    let attempt = 0;
    let lastWritten = 0;
    let lastSpeedTime = Date.now();

    const tryDownload = (startByte = 0) => {
      attempt += 1;
      let written = startByte;
      let lastReport = 0;
      let stallTimer = null;
      let out = null;
      let reqRef = null;
      let total = 0;

      const calcSpeed = () => {
        const now = Date.now();
        const dt = (now - lastSpeedTime) / 1000;
        const dw = written - lastWritten;
        if (dt > 1) { lastSpeedTime = now; lastWritten = written; }
        return dt > 0 ? Math.round(dw / dt) : 0;
      };

      const report = (force = false) => {
        const now = Date.now();
        if (!force && now - lastReport < PROGRESS_THROTTLE_MS) return;
        lastReport = now;
        const percent = total ? Math.min(100, Math.floor((written / total) * 100)) : 0;
        const speed = calcSpeed();
        if (onProgress) onProgress({ percent, written, total, speedBps: speed });
        if (onStage) {
          const speedStr = speed > 0 ? ` · ${formatBytes(speed)}/s` : '';
          onStage(`下载更新包… ${formatBytes(written)} / ${formatBytes(total)} (${percent}%)${speedStr}`);
        }
      };

      const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
      const resetStall = () => {
        clearStall();
        stallTimer = setTimeout(() => {
          if (reqRef) reqRef.destroy(new Error(`下载停滞超过 ${STALL_TIMEOUT_MS / 1000} 秒`));
        }, STALL_TIMEOUT_MS);
      };

      const onFail = (err) => {
        clearStall();
        if (out) { try { out.destroy(); } catch (e) {} out = null; }
        if (attempt <= MAX_RETRIES) {
          const resumeFrom = written > startByte ? written : startByte;
          if (onStage) onStage(`下载中断，${attempt}/${MAX_RETRIES} 次重试…`);
          setTimeout(() => tryDownload(resumeFrom), 1000);
        } else {
          reject(err);
        }
      };

      const doGet = (u, redirects) => {
        if (redirects > 10) return onFail(new Error('重定向次数过多'));
        const mod = u.startsWith('https') ? https : http;
        const headers = {};
        if (startByte > 0) headers.Range = `bytes=${startByte}-`;
        const req = mod.get(u, { headers, timeout: 30000 }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            return doGet(new URL(res.headers.location, u).href, redirects + 1);
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            return onFail(new Error('下载失败 HTTP ' + res.statusCode));
          }
          total = parseInt(res.headers['content-length'] || '0', 10) + startByte;
          out = fs.createWriteStream(dest, startByte > 0 ? { flags: 'a' } : {});

          res.on('data', (chunk) => {
            written += chunk.length;
            out.write(chunk);
            resetStall();
            report();
          });
          res.on('end', () => { clearStall(); out.end(); });
          res.on('error', onFail);
          out.on('finish', () => { clearStall(); report(true); resolve(dest); });
          out.on('error', onFail);
          resetStall();
          report(true);
        });
        req.on('error', onFail);
        req.on('timeout', () => { onFail(new Error('连接超时')); });
        reqRef = req;
      };
      doGet(url, 0);
    };

    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch (e) {}
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    tryDownload(existing > 1048576 ? existing : 0);
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

// 等待后台 bash 复制完成（写入 doneMarker）后，由主进程 app.relaunch()+app.quit()
// 接管重启。relaunch() 是 Electron 内部向系统注册的「退出后重新启动」，
// 不会像手写 open 那样把尚未退出的旧实例「激活」，从而消除重启后仍显示旧版本的竞态。
function waitAndRelaunch(doneMarker, done) {
  const start = Date.now();
  const timer = setInterval(() => {
    let ok = false;
    try { ok = fs.existsSync(doneMarker); } catch (e) { ok = false; }
    if (ok || Date.now() - start > 20000) {        // 复制完成 or 20s 超时兜底
      clearInterval(timer);
      try { fs.unlinkSync(doneMarker); } catch (e) { /* ignore */ }
      try { app.relaunch(); } catch (e) { /* ignore */ }
      app.quit();
      if (done) done();
    }
  }, 150);
}

// 写独立安装脚本，脱离主进程在后台完成整包替换；重启由 waitAndRelaunch 托管（v0.7.0 机制升级版）
function relaunchAndApply(staging) {
  return new Promise((resolve) => {
    const target = currentAppPath();
    const updateRoot = path.dirname(staging);
    const doneMarker = path.join(os.tmpdir(), 'aic-apply-done');
    const script = `#!/bin/bash
sleep 1
rm -rf "${target}"
cp -R "${staging}" "${target}"
xattr -dr com.apple.quarantine "${target}" 2>/dev/null
rm -rf "${updateRoot}"
touch "${doneMarker}"
`;
    const sp = path.join(updateDir(), 'apply.sh');
    fs.mkdirSync(updateDir(), { recursive: true });
    fs.writeFileSync(sp, script);
    fs.chmodSync(sp, 0o755);
    const child = spawn('bash', [sp], { detached: true, stdio: 'ignore' });
    child.unref();
    waitAndRelaunch(doneMarker, resolve);
  });
}

// ===== 对外 API =====
async function checkForUpdates() {
  const cur = getCurrentVersion();
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
      patchUrl: m.patchUrl || '',
      patchSha256: m.patchSha256 || '',
      deltaUrl: m.deltaUrl || '',
      deltaSha256: m.deltaSha256 || '',
      deltaFromVersion: m.deltaFromVersion || '',
    };
  } catch (e) {
    return { updateAvailable: false, currentVersion: cur, error: e.message };
  }
}

// 增量应用：解压 patch zip 到 staging，写 bash 脚本在后台覆盖 Resources/app；
// 重启由 waitAndRelaunch 托管（app.relaunch + app.quit，规避 open 激活旧实例竞态）
function applyDeltaAndRelaunch(deltaZipPath, cb) {
  const stagingDir = path.join(updateDir(), 'staging');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const buf = fs.readFileSync(deltaZipPath);
  const entries = readZipEntries(buf);
  const deletedFiles = [];
  for (const e of entries) {
    if (e.name === '__deleted.txt') {
      e.data.toString('utf8').split('\n').forEach((l) => { if (l.trim()) deletedFiles.push(l.trim()); });
      continue;
    }
    if (e.name === '__delta_info.json') continue;
    if (e.name.endsWith('/')) continue; // 跳过目录条目（如 renderer/），否则 fs.writeFileSync 会向目录路径 open 报 ENOENT
    const dest = path.join(stagingDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }

  const target = currentAppPath();
  const appResDir = path.join(target, 'Contents', 'Resources', 'app');
  const updateRoot = updateDir();
  const doneMarker = path.join(os.tmpdir(), 'aic-apply-done');
  const deleteCmds = deletedFiles.map((f) => `rm -f "${appResDir}/${f}" 2>/dev/null`).join('\n');
  const script = `#!/bin/bash
sleep 1
# 覆盖变更文件
cp -Rf "${stagingDir}/." "${appResDir}/"
# 删除已移除文件
${deleteCmds}
xattr -dr com.apple.quarantine "${target}" 2>/dev/null
rm -rf "${updateRoot}"
touch "${doneMarker}"
`;
  const sp = path.join(updateDir(), 'apply.sh');
  fs.writeFileSync(sp, script);
  fs.chmodSync(sp, 0o755);
  const child = spawn('bash', [sp], { detached: true, stdio: 'ignore' });
  child.unref();
  waitAndRelaunch(doneMarker, () => { if (cb && cb.onStage) cb.onStage('即将重启…'); });
}

// cb: { onProgress({percent,written,total,speedBps}), onStage(text) }
// manifest 可以是字符串（dmgUrl，兼容旧调用）或对象（含 patchUrl/deltaUrl 等字段）
async function downloadAndInstall(manifest, cb = {}) {
  fs.mkdirSync(updateDir(), { recursive: true });
  const cur = getCurrentVersion();
  const info = typeof manifest === 'string' ? { dmgUrl: manifest } : manifest;

  // 通用增量包（patchUrl）：同一份 zip 适用于任何老版本，
  // 下载后解压覆盖 Resources/app 即升到最新（发布时即打包完整 app 目录快照）。
  if (info.patchUrl) {
    const patchPath = path.join(updateDir(), 'patch.zip');
    if (cb.onStage) cb.onStage('下载增量更新包…');
    await downloadFile(info.patchUrl, patchPath, {
      onProgress: (p) => cb.onProgress && cb.onProgress(p),
      onStage: (s) => cb.onStage && cb.onStage(s),
    });
    if (info.patchSha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(patchPath)).digest('hex');
      if (actual.toLowerCase() !== String(info.patchSha256).toLowerCase()) {
        const msg = '增量包校验失败（sha256 不匹配），已取消更新';
        if (cb.onError) cb.onError(msg);
        throw new Error(msg);
      }
    }
    if (cb.onStage) cb.onStage('应用增量更新…');
    applyDeltaAndRelaunch(patchPath, cb); // 内部会 app.quit
    return;
  }

  // 兼容旧版 manifest 的单一 delta 字段（若有）
  const canDelta = info.deltaUrl && info.deltaFromVersion &&
    compareVersions(info.deltaFromVersion, cur) === 0;
  if (canDelta) {
    const deltaPath = path.join(updateDir(), 'delta.zip');
    if (cb.onStage) cb.onStage('下载增量更新包…');
    await downloadFile(info.deltaUrl, deltaPath, {
      onProgress: (p) => cb.onProgress && cb.onProgress(p),
      onStage: (s) => cb.onStage && cb.onStage(s),
    });
    if (cb.onStage) cb.onStage('应用增量更新…');
    applyDeltaAndRelaunch(deltaPath, cb);
    return;
  }

  // === 完整 DMG 更新路径（任何老版本兜底）===
  const tmpDmg = path.join(updateDir(), 'update.dmg');
  if (cb.onStage) cb.onStage('下载完整安装包…');
  await downloadFile(info.dmgUrl, tmpDmg, {
    onProgress: (p) => cb.onProgress && cb.onProgress(p),
    onStage: (s) => cb.onStage && cb.onStage(s),
  });
  if (cb.onStage) cb.onStage('挂载磁盘映像…');
  const vol = await attachDmg(tmpDmg);
  const srcApp = path.join(vol, 'AI Copilot.app');
  const staging = path.join(updateDir(), 'AI Copilot.app');
  if (cb.onStage) cb.onStage('复制新版本…');
  await copyApp(srcApp, staging);
  await detachDmg(vol);
  if (cb.onStage) cb.onStage('准备安装…');
  await relaunchAndApply(staging); // 内部会 app.quit，不会正常返回
}

module.exports = { checkForUpdates, downloadAndInstall, REPO, MANIFEST_URL };
