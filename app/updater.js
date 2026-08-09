// updater.js — AI Copilot 自动更新器（主进程，适配未签名 DMG 分发）
// 流程：拉取 GitHub raw 上的 latest.json → 比对版本 → 下载 Release → 应用 → 重启
//
// 设计要点（修复历史升级失效）：
// 1) 版本判断必须读 Resources/app/package.json，不能读 app.getVersion()——
//    macOS 打包后 app.getVersion() 返回 Info.plist 的 CFBundleVersion（本应用恒为 0.7.2，
//    增量更新不覆盖 Info.plist），否则版本判断错乱、增量永远不匹配、永远走完整包。
// 2) 应用更新必须在主进程内「同步」完成（cp 覆盖文件），再用 app.relaunch()+app.exit(0) 重启。
//    任何 detached bash / launchctl 子进程都会在 app 退出时被一起杀掉，导致 apply 永不执行。
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
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
// Resources/app 目录（源码所在，增量更新只覆盖这里）
function appResDirPath() { return path.join(currentAppPath(), 'Contents', 'Resources', 'app'); }

// 诊断日志（写入 userData/.update/updater.log，便于日后排查升级问题）
function log(...args) {
  try {
    const line = `[${new Date().toISOString()}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    fs.mkdirSync(updateDir(), { recursive: true });
    fs.appendFileSync(path.join(updateDir(), 'updater.log'), line);
  } catch (e) { /* 日志失败不影响升级 */ }
}

// 取得「真实」当前版本：直接读 Resources/app/package.json 的 version 字段
// （见文件头说明：app.getVersion() 在本应用不可信）
function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appResDirPath(), 'package.json'), 'utf8'));
    return pkg.version || app.getVersion();
  } catch (e) {
    return app.getVersion();
  }
}

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
        const headers = { 'User-Agent': 'AI-Copilot-Updater/1.0' };
        // 仅对原始请求（未发生重定向）携带 Range；GitHub 302 后的 SAS URL 带 Range 可能 403/416
        if (redirects === 0 && startByte > 0) headers.Range = `bytes=${startByte}-`;
        const req = mod.get(u, { headers, timeout: 30000 }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            return doGet(new URL(res.headers.location, u).href, redirects + 1);
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            res.resume();
            log('downloadFile HTTP 错误', res.statusCode, 'URL:', u);
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
    // 注意：必须用异步 execFile（带回调）。此前误写成 execFileSync 传回调，
    // 导致回调永不执行、Promise 永久挂起，完整包路径直接卡死。
    execFile('hdiutil', ['attach', '-nobrowse', '-noautoopen', dmg], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const line = String(stdout).split('\n').find((l) => l.includes('/Volumes/'));
      const vol = line ? line.trim().split(/\t/).pop().trim() : null;
      if (!vol || !fs.existsSync(vol)) return reject(new Error('找不到 DMG 挂载点'));
      resolve(vol);
    });
  });
}

function detachDmg(vol) {
  return new Promise((resolve) => {
    try { execFileSync('hdiutil', ['detach', '-force', vol]); } catch (e) {}
    resolve();
  });
}

function copyApp(src, dest) {
  return new Promise((resolve, reject) => {
    fs.rmSync(dest, { recursive: true, force: true });
    // 用 -X 跳过扩展属性，避免运行中 .app 的 com.apple.provenance 导致 Operation not permitted
    execFile('cp', ['-RX', src, dest], (err) => (err ? reject(err) : resolve()));
  });
}

// 用 Node.js 逐文件复制（fallback，避开 cp 复制扩展属性时的权限问题）
function copyTreeNodeSync(src, dst) {
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      copyTreeNodeSync(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 把 src 目录内容覆盖到 dst 目录；优先用 cp -RfX（不复制扩展属性），
// 失败则回退 Node.js 逐文件复制，避免 com.apple.provenance 等导致 Operation not permitted
function copyIntoSync(src, dst) {
  try {
    execFileSync('cp', ['-RfX', src + '/.', dst + '/']);
  } catch (e) {
    log('cp -RfX 失败，回退 Node.js 复制:', e.message);
    copyTreeNodeSync(src, dst);
  }
}

// 把 Info.plist 的版本号同步为真实版本（增量更新只覆盖 Resources/app，
// 否则 Info.plist 会永远停留在打包模板的旧版本号，导致系统「关于」显示错乱）
function syncInfoPlistVersion(appPath, version) {
  if (!version) return;
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(plist)) return;
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    try {
      execFileSync('plutil', ['-replace', key, '-string', version, plist]);
    } catch (e) { log('syncInfoPlistVersion 失败', key, e.message); }
  }
}

// 应用增量包：解压 delta zip → 同步覆盖 Resources/app → 删除被移除文件 → 重启
// 全程在主进程内同步执行，不依赖任何子进程，避免 app 退出时 apply 被中断。
function applyDeltaAndRelaunch(deltaZipPath) {
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
  const appResDir = appResDirPath();
  const beforeVer = getCurrentVersion();
  log('applyDelta: 准备覆盖', appResDir, '| 当前版本', beforeVer, '| 删除列表', deletedFiles);

  // 同步覆盖变更文件（app 仍在运行，Resources/app 里都是普通数据文件，可安全覆盖）
  // 用 copyIntoSync 处理扩展属性（com.apple.provenance）导致的 cp 失败
  copyIntoSync(stagingDir, appResDir);

  // 同步删除已移除文件
  for (const f of deletedFiles) {
    try { fs.unlinkSync(path.join(appResDir, f)); } catch (e) { /* ignore */ }
  }

  // 校验：覆盖后版本号必须真的变了，否则说明 apply 没生效，直接报错而不是静默重启
  const afterVer = getCurrentVersion();
  if (compareVersions(afterVer, beforeVer) <= 0) {
    log('applyDelta: ❌ 覆盖后版本仍为', afterVer, '，apply 未生效');
    throw new Error(`增量更新未生效（版本仍为 ${afterVer}），请改用完整安装包`);
  }

  // 关键：把 Info.plist 版本号同步为新版本，避免系统信息与实际版本不一致
  syncInfoPlistVersion(target, afterVer);

  // 清理 quarantine 属性 + 更新目录
  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', target]); } catch (e) { /* ignore */ }
  try { fs.rmSync(updateDir(), { recursive: true, force: true }); } catch (e) { /* ignore */ }

  log('applyDelta: ✅ 覆盖完成', beforeVer, '→', afterVer, '，即将重启');
  // 重启 app（relaunch + exit，全部在主进程内完成）
  app.relaunch();
  app.exit(0);
}

// 完整 DMG 安装：下载 → 挂载 → 拷到 staging → 同步覆盖到目标 .app → 重启
// 同样在主进程内同步完成，不依赖 detached 子进程。
function relaunchAndApply(staging) {
  const target = currentAppPath();
  const beforeVer = getCurrentVersion();
  log('relaunchAndApply: 准备覆盖', target, '<-', staging, '| 当前版本', beforeVer);

  // 先尝试整包原地覆盖（不删目标目录，避免破坏运行中进程的 inode）
  let fullOk = true;
  try {
    // 用 -X 跳过扩展属性，避免 com.apple.provenance 导致 Operation not permitted
    execFileSync('cp', ['-RfX', staging + '/.', target + '/']);
  } catch (e) {
    // 运行中的可执行文件/框架会返回 ETXTBSY，整包覆盖失败属预期情况
    fullOk = false;
    log('relaunchAndApply: 整包覆盖失败（多为可执行文件被占用），回退为只覆盖 Resources/app +Info.plist：', e.message);
  }

  if (!fullOk) {
    // 回退：只覆盖 Resources/app（纯数据文件，可安全覆盖）与 Info.plist
    const srcRes = path.join(staging, 'Contents', 'Resources', 'app');
    const dstRes = appResDirPath();
    if (fs.existsSync(srcRes)) {
      copyIntoSync(srcRes, dstRes);
    }
    const srcPlist = path.join(staging, 'Contents', 'Info.plist');
    const dstPlist = path.join(target, 'Contents', 'Info.plist');
    try { if (fs.existsSync(srcPlist)) fs.copyFileSync(srcPlist, dstPlist); } catch (e) { /* ignore */ }
  }

  const afterVer = getCurrentVersion();
  if (compareVersions(afterVer, beforeVer) <= 0) {
    log('relaunchAndApply: ❌ 覆盖后版本仍为', afterVer);
    throw new Error(`更新未生效（版本仍为 ${afterVer}），请手动安装 DMG`);
  }
  syncInfoPlistVersion(target, afterVer);

  try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', target]); } catch (e) { /* ignore */ }
  try { fs.rmSync(updateDir(), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  log('relaunchAndApply: ✅ 覆盖完成', beforeVer, '→', afterVer, '，即将重启');
  app.relaunch();
  app.exit(0);
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
      deltaUrl: m.deltaUrl || '',
      deltaSha256: m.deltaSha256 || '',
      deltaFromVersion: m.deltaFromVersion || '',
      deltas: Array.isArray(m.deltas) ? m.deltas : [],
    };
  } catch (e) {
    return { updateAvailable: false, currentVersion: cur, error: e.message };
  }
}

// cb: { onProgress({percent,written,total,speedBps}), onStage(text), onError(msg) }
// manifest 可以是字符串（dmgUrl，兼容旧调用）或对象（含 deltaUrl 等字段）
async function downloadAndInstall(manifest, cb = {}) {
  fs.mkdirSync(updateDir(), { recursive: true });

  // 判断走增量还是完整包
  const cur = getCurrentVersion();
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
    // sha256 校验
    if (chosen.sha256) {
      const actual = crypto.createHash('sha256').update(fs.readFileSync(deltaPath)).digest('hex');
      if (actual.toLowerCase() !== String(chosen.sha256).toLowerCase()) {
        const msg = '增量包校验失败（sha256 不匹配），已取消更新';
        if (cb.onError) cb.onError(msg);
        throw new Error(msg);
      }
    }
    if (cb.onStage) cb.onStage('应用增量更新…');
    try {
      applyDeltaAndRelaunch(deltaPath); // 成功则内部 app.exit(0)，不会返回
      return;
    } catch (e) {
      // 增量应用失败（如权限/文件占用）→ 不中断，自动回退到完整包
      log('增量应用失败，回退完整包：', e.message);
      if (cb.onStage) cb.onStage('增量更新失败，改用完整安装包…');
    }
  }

  // === 完整 DMG 更新路径（回退） ===
  if (!info.dmgUrl) {
    const msg = '未找到可用的更新包（既无增量也无完整包）';
    if (cb.onError) cb.onError(msg);
    throw new Error(msg);
  }
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
  relaunchAndApply(staging); // 内部会 app.exit(0)
}

module.exports = { checkForUpdates, downloadAndInstall, REPO, MANIFEST_URL };
