// updater.js — AI Copilot 自动更新器（主进程，适配未签名 DMG 分发）
// 流程：拉取 GitHub raw 上的 latest.json → 比对版本 → 下载 Release DMG →
//       挂载 → 拷贝新 .app 到 staging → 写独立 apply 脚本 → relaunch 自安装
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn, execFileSync } = require('child_process');
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
    // 加缓存戳，避免 raw.githubusercontent.com CDN 缓存导致不能及时读到最新 latest.json
    const sep = url.includes('?') ? '&' : '?';
    const urlWithCb = `${url}${sep}_cb=${Date.now()}`;
    const req = mod.get(urlWithCb, { timeout: 20000 }, (res) => {
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

// 写独立安装脚本，脱离主进程在 app 退出后完成替换并重启
function relaunchAndApply(staging) {
  return new Promise((resolve) => {
    const target = currentAppPath();
    const updateRoot = path.dirname(staging);
    const script = `#!/bin/bash
# 等待 app 退出后再替换（避免 rm 运行中的 app 导致崩溃）
while pgrep -f "${target}/Contents/MacOS" >/dev/null 2>&1; do sleep 0.3; done
sleep 1
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
      deltaUrl: m.deltaUrl || '',
      deltaSha256: m.deltaSha256 || '',
      deltaFromVersion: m.deltaFromVersion || '',
      deltas: Array.isArray(m.deltas) ? m.deltas : [],
    };
  } catch (e) {
    return { updateAvailable: false, currentVersion: cur, error: e.message };
  }
}

// 增量应用：解压 delta zip 到 staging，同步覆盖 Resources/app 后重启
// 关键修复：不再依赖 detached bash（app.quit() 后子进程会被杀，apply.sh 从未执行），
// 改为在 app 退出前同步 cp 覆盖文件，然后 app.relaunch() + app.exit(0) 重启
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
    const dest = path.join(stagingDir, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
  }

  const target = currentAppPath();
  const appResDir = path.join(target, 'Contents', 'Resources', 'app');
  const updateRoot = updateDir();

  // 同步覆盖变更文件（app 仍在运行，macOS 允许覆盖；下次启动加载新文件）
  let cpOk = false;
  try {
    execFileSync('cp', ['-Rf', stagingDir + '/.', appResDir + '/']);
    cpOk = true;
  } catch (e) { /* 同步 cp 失败则回退到 detached bash */ }

  if (cpOk) {
    // 同步删除已移除文件
    for (const f of deletedFiles) {
      try { fs.unlinkSync(path.join(appResDir, f)); } catch (e) { /* ignore */ }
    }
    // 清理 quarantine 属性
    try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', target]); } catch (e) { /* ignore */ }
    // 清理更新目录
    try { fs.rmSync(updateRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    // 重启 app（relaunch + exit，不依赖 detached bash）
    app.relaunch();
    app.exit(0);
    return;
  }

  // 回退方案：detached bash（旧机制，仅在同步 cp 失败时使用）
  const deleteCmds = deletedFiles.map((f) => `rm -f "${appResDir}/${f}" 2>/dev/null`).join('\n');
  const script = `#!/bin/bash
# 等待 app 退出后再执行
while pgrep -f "${target}/Contents/MacOS" >/dev/null 2>&1; do sleep 0.3; done
sleep 1
cp -Rf "${stagingDir}/." "${appResDir}/"
${deleteCmds}
xattr -dr com.apple.quarantine "${target}" 2>/dev/null
rm -rf "${updateRoot}"
open "${target}"
`;
  const sp = path.join(updateDir(), 'apply.sh');
  fs.writeFileSync(sp, script);
  fs.chmodSync(sp, 0o755);
  const child = spawn('bash', [sp], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => { app.quit(); }, 400);
}

// cb: { onProgress({percent,written,total,speedBps}), onStage(text) }
// manifest 可以是字符串（dmgUrl，兼容旧调用）或对象（含 deltaUrl 等字段）
async function downloadAndInstall(manifest, cb = {}) {
  fs.mkdirSync(updateDir(), { recursive: true });

  // 判断走增量还是完整包
  const cur = app.getVersion();
  const info = typeof manifest === 'string' ? { dmgUrl: manifest } : manifest;

  // 构造可用增量包列表：优先 latest.json 的 deltas 数组（多版本），
  // 兼容旧版单一 deltaUrl/deltaFromVersion 字段
  const allDeltas = Array.isArray(info.deltas) ? info.deltas.slice() : [];
  if (info.deltaUrl && info.deltaFromVersion) {
    allDeltas.push({ from: info.deltaFromVersion, url: info.deltaUrl, sha256: info.deltaSha256 });
  }
  // 选一个与当前运行版本精确匹配的增量包（不管当前是第几版，都能用 tiny delta）
  const chosen = allDeltas.find(
    (d) => d && d.from && d.url && compareVersions(d.from, cur) === 0
  );

  if (chosen) {
    // === 增量更新路径 ===
    const safeFrom = String(chosen.from).replace(/[^0-9.]/g, '') || 'latest';
    const deltaPath = path.join(updateDir(), `delta-${safeFrom}.zip`);
    if (cb.onStage) cb.onStage('下载增量更新包…');
    await downloadFile(chosen.url, deltaPath, {
      onProgress: (p) => cb.onProgress && cb.onProgress(p),
      onStage: (s) => cb.onStage && cb.onStage(s),
    });
    // 可选：sha256 校验
    if (chosen.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(deltaPath)).digest('hex');
      if (actual.toLowerCase() !== String(chosen.sha256).toLowerCase()) {
        throw new Error('增量包校验失败（sha256 不匹配），已取消更新');
      }
    }
    if (cb.onStage) cb.onStage('应用增量更新…');
    applyDeltaAndRelaunch(deltaPath, cb); // 内部会 app.quit
    return;
  }

  // === 完整 DMG 更新路径（回退） ===
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
