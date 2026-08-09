// updater.js — AI Copilot macOS 更新器
// 更新包下载到 userData；真正写入 .app 的动作由 launchd 助手在旧进程退出后执行。
// 这样不会在运行中的应用里修改自身 bundle，也不会复用未经校验的下载缓存。
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { app } = require('electron');
const { readZipEntries } = require('./office-replace');

const REPO = 'ddxmu/AI-Copilot';
const MANIFEST_BRANCH = 'main';
const MANIFEST_URL = 'https://raw.githubusercontent.com/' + REPO + '/' + MANIFEST_BRANCH + '/latest.json';
const STALL_TIMEOUT_MS = 45000;
const MAX_RETRIES = 2;
const PROGRESS_THROTTLE_MS = 250;

function userData() { return app.getPath('userData'); }
function updateDir() { return path.join(userData(), '.update'); }
function pendingRoot() { return path.join(userData(), 'pending-update'); }
function currentAppPath() { return path.resolve(app.getPath('exe'), '..', '..', '..'); }
function appResDirPath() { return path.join(currentAppPath(), 'Contents', 'Resources', 'app'); }

function log(...args) {
  try {
    const text = args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ');
    fs.mkdirSync(updateDir(), { recursive: true });
    fs.appendFileSync(path.join(updateDir(), 'updater.log'), '[' + new Date().toISOString() + '] ' + text + '\n');
  } catch (e) { /* diagnostics must never block an update */ }
}

function getCurrentVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appResDirPath(), 'package.json'), 'utf8'));
    return pkg.version || app.getVersion();
  } catch (e) {
    return app.getVersion();
  }
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const right = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) > (right[i] || 0)) return 1;
    if ((left[i] || 0) < (right[i] || 0)) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const separator = url.includes('?') ? '&' : '?';
    const requestUrl = url + separator + '_cb=' + Date.now();
    const req = mod.get(requestUrl, { timeout: 20000, headers: { 'User-Agent': 'AI-Copilot-Updater/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        fetchJson(new URL(res.headers.location, url).href).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('更新清单请求失败 HTTP ' + res.statusCode));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('更新清单不是有效 JSON：' + err.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('更新清单请求超时')));
  });
}

function formatBytes(size) {
  if (size >= 1073741824) return (size / 1073741824).toFixed(2) + ' GB';
  if (size >= 1048576) return (size / 1048576).toFixed(1) + ' MB';
  if (size >= 1024) return (size / 1024).toFixed(1) + ' KB';
  return size + ' B';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadOnce(url, dest, opts) {
  return new Promise((resolve, reject) => {
    let done = false;
    let output = null;
    let stallTimer = null;
    let activeRequest = null;
    let written = 0;
    let total = 0;
    let lastReport = 0;
    let lastSpeedTime = Date.now();
    let lastSpeedBytes = 0;

    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clearStall();
      if (output) {
        try { output.destroy(); } catch (e) { /* ignore */ }
      }
      reject(err);
    };
    const complete = () => {
      if (done) return;
      done = true;
      clearStall();
      resolve(dest);
    };
    const resetStall = () => {
      clearStall();
      stallTimer = setTimeout(() => {
        if (activeRequest) activeRequest.destroy(new Error('下载停滞超过 ' + (STALL_TIMEOUT_MS / 1000) + ' 秒'));
      }, STALL_TIMEOUT_MS);
    };
    const report = (force) => {
      const now = Date.now();
      if (!force && now - lastReport < PROGRESS_THROTTLE_MS) return;
      lastReport = now;
      const seconds = (now - lastSpeedTime) / 1000;
      const delta = written - lastSpeedBytes;
      const speedBps = seconds > 0 ? Math.round(delta / seconds) : 0;
      if (seconds >= 1) {
        lastSpeedTime = now;
        lastSpeedBytes = written;
      }
      if (opts.onProgress) opts.onProgress({
        percent: total ? Math.min(100, Math.floor((written / total) * 100)) : 0,
        written,
        total,
        speedBps,
      });
      if (opts.onStage) {
        const percent = total ? Math.min(100, Math.floor((written / total) * 100)) : 0;
        const speed = speedBps > 0 ? ' · ' + formatBytes(speedBps) + '/s' : '';
        opts.onStage('下载更新包… ' + formatBytes(written) + ' / ' + formatBytes(total) + ' (' + percent + '%)' + speed);
      }
    };
    const requestUrl = (address, redirects) => {
      if (redirects > 10) {
        fail(new Error('更新包重定向次数过多'));
        return;
      }
      const mod = address.startsWith('https:') ? https : http;
      const req = mod.get(address, { timeout: 30000, headers: { 'User-Agent': 'AI-Copilot-Updater/2.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          requestUrl(new URL(res.headers.location, address).href, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error('更新包下载失败 HTTP ' + res.statusCode));
          return;
        }
        total = parseInt(res.headers['content-length'] || '0', 10);
        try {
          output = fs.createWriteStream(dest, { flags: 'w' });
        } catch (err) {
          fail(err);
          return;
        }
        output.on('error', fail);
        output.on('finish', () => {
          report(true);
          complete();
        });
        res.on('error', fail);
        res.on('data', (chunk) => {
          written += chunk.length;
          resetStall();
          report(false);
        });
        res.pipe(output);
        resetStall();
        report(true);
      });
      activeRequest = req;
      req.on('error', fail);
      req.on('timeout', () => req.destroy(new Error('更新包连接超时')));
    };
    requestUrl(url, 0);
  });
}

async function downloadFile(url, dest, opts = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      fs.rmSync(dest, { force: true });
      if (attempt > 0 && opts.onStage) opts.onStage('下载中断，正在重试（' + attempt + '/' + MAX_RETRIES + '）…');
      await downloadOnce(url, dest, opts);
      return dest;
    } catch (err) {
      lastError = err;
      try { fs.rmSync(dest, { force: true }); } catch (e) { /* ignore */ }
      if (attempt < MAX_RETRIES) await delay(1000);
    }
  }
  throw lastError || new Error('下载更新包失败');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let size = 0;
    do {
      size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (size > 0) hash.update(buffer.subarray(0, size));
    } while (size > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

async function downloadVerified(url, dest, expectedSha256, opts) {
  const expected = String(expectedSha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('发布清单缺少有效 sha256 校验值，已拒绝下载更新');
  }
  if (fs.existsSync(dest)) {
    try {
      if (sha256File(dest).toLowerCase() === expected) return dest;
    } catch (e) { /* discard invalid cache below */ }
    try { fs.rmSync(dest, { force: true }); } catch (e) { /* ignore */ }
  }
  await downloadFile(url, dest, opts);
  const actual = sha256File(dest).toLowerCase();
  if (actual !== expected) {
    try { fs.rmSync(dest, { force: true }); } catch (e) { /* ignore */ }
    throw new Error('更新包校验失败（sha256 不匹配），请稍后重试');
  }
  return dest;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new Error('更新包包含无效文件路径');
  }
  const raw = value.replace(/\\/g, '/');
  if (raw.startsWith('/')) throw new Error('更新包包含绝对路径：' + value);
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('更新包包含越界路径：' + value);
  }
  return normalized;
}

function safeJoin(root, relativePath) {
  const relative = safeRelativePath(relativePath);
  const base = path.resolve(root);
  const output = path.resolve(base, ...relative.split('/'));
  if (!output.startsWith(base + path.sep)) throw new Error('更新包路径越界：' + relativePath);
  return output;
}

function copyTreeSync(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyTreeSync(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    } else {
      throw new Error('更新暂存区包含不支持的文件类型：' + entry.name);
    }
  }
}

function listFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else if (entry.isFile()) files.push(safeRelativePath(relative));
    else throw new Error('更新暂存区包含不支持的文件类型：' + relative);
  }
  return files;
}

function pathIsInside(child, parent) {
  const relation = path.relative(path.resolve(parent), path.resolve(child));
  return relation === '' || (!relation.startsWith('..' + path.sep) && relation !== '..' && !path.isAbsolute(relation));
}

function assertAutomaticUpdateLocation() {
  if (process.platform !== 'darwin') throw new Error('当前平台不支持自动替换，请下载完整安装包');
  const appPath = currentAppPath();
  for (const key of ['desktop', 'documents', 'downloads']) {
    try {
      if (pathIsInside(appPath, app.getPath(key))) {
        throw new Error('AI Copilot 当前位于受保护目录（' + appPath + '）。请先将完整安装包中的 AI Copilot.app 拖到“应用程序”文件夹，再使用在线快速升级。');
      }
    } catch (err) {
      if (String(err.message || '').startsWith('AI Copilot 当前位于')) throw err;
    }
  }
  try {
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
  } catch (err) {
    throw new Error('应用所在目录不可写（' + appPath + '）。请下载完整安装包并安装到当前用户的“应用程序”文件夹。');
  }
  return appPath;
}

function createPendingDirectory(version) {
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/g, '_');
  const dir = path.join(pendingRoot(), 'v' + safeVersion + '-' + Date.now() + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function helperPreamble(pending, appPath, options = {}) {
  const logPath = path.join(pending, 'helper.log');
  const waitForPid = Number.isInteger(options.waitForPid) && options.waitForPid > 0
    ? options.waitForPid
    : process.pid;
  return [
    '#!/bin/sh',
    'set -u',
    'LOG=' + shellQuote(logPath),
    'APP_ROOT=' + shellQuote(appPath),
    'PENDING=' + shellQuote(pending),
    'exec >>"$LOG" 2>&1',
    'echo "AI Copilot update helper started: $(date)"',
    'while /bin/kill -0 ' + waitForPid + ' 2>/dev/null; do /bin/sleep 0.2; done',
    'echo "old process exited"',
    'fail() { echo "FAILED: $1"; /usr/bin/open -n "$APP_ROOT" >/dev/null 2>&1 || true; exit 1; }',
    'must() { "$@" || fail "$1"; }',
  ];
}

function makeDeltaHelperScript(pending, appPath, targetVersion, files, deletedFiles, options = {}) {
  const filesRoot = path.join(pending, 'files');
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app');
  const ordered = files.slice().sort((left, right) => {
    if (left === 'package.json') return 1;
    if (right === 'package.json') return -1;
    return left.localeCompare(right);
  });
  const lines = helperPreamble(pending, appPath, options);
  lines.push('APP_RES=' + shellQuote(appRoot));
  lines.push('TARGET_VERSION=' + shellQuote(targetVersion));
  lines.push('must /bin/mkdir -p "$APP_RES"');
  for (const relative of ordered) {
    const source = safeJoin(filesRoot, relative);
    const destination = safeJoin(appRoot, relative);
    lines.push('must /bin/mkdir -p ' + shellQuote(path.dirname(destination)));
    lines.push('must /bin/cp -fX ' + shellQuote(source) + ' ' + shellQuote(destination));
  }
  for (const relative of deletedFiles) {
    const destination = safeJoin(appRoot, relative);
    lines.push('if [ -e ' + shellQuote(destination) + ' ]; then must /bin/rm -f ' + shellQuote(destination) + '; fi');
  }
  lines.push('if [ -f "$APP_ROOT/Contents/Info.plist" ]; then');
  lines.push('  must /usr/bin/plutil -replace CFBundleShortVersionString -string "$TARGET_VERSION" "$APP_ROOT/Contents/Info.plist"');
  lines.push('  must /usr/bin/plutil -replace CFBundleVersion -string "$TARGET_VERSION" "$APP_ROOT/Contents/Info.plist"');
  lines.push('fi');
  lines.push('must /usr/bin/codesign --force --deep --sign - "$APP_ROOT"');
  lines.push('must /usr/bin/codesign --verify --deep --strict "$APP_ROOT"');
  lines.push('/usr/bin/xattr -dr com.apple.quarantine "$APP_ROOT" >/dev/null 2>&1 || true');
  lines.push('echo "delta update complete"');
  lines.push('must /bin/rm -rf "$PENDING"');
  if (options.reopen !== false) lines.push('must /usr/bin/open -n "$APP_ROOT"');
  return lines.join('\n') + '\n';
}

function makeFullHelperScript(pending, stagedApp, appPath, options = {}) {
  const backup = path.join(path.dirname(appPath), '.' + path.basename(appPath) + '.backup-' + Date.now());
  const lines = helperPreamble(pending, appPath, options);
  lines.push('STAGED_APP=' + shellQuote(stagedApp));
  lines.push('BACKUP=' + shellQuote(backup));
  lines.push('if [ -e "$BACKUP" ]; then must /bin/rm -rf "$BACKUP"; fi');
  lines.push('must /bin/mv "$APP_ROOT" "$BACKUP"');
  lines.push('if ! /usr/bin/ditto "$STAGED_APP" "$APP_ROOT"; then');
  lines.push('  /bin/rm -rf "$APP_ROOT" || true');
  lines.push('  /bin/mv "$BACKUP" "$APP_ROOT" || true');
  lines.push('  fail "ditto"');
  lines.push('fi');
  lines.push('if ! /usr/bin/codesign --verify --deep --strict "$APP_ROOT"; then');
  lines.push('  /bin/rm -rf "$APP_ROOT" || true');
  lines.push('  /bin/mv "$BACKUP" "$APP_ROOT" || true');
  lines.push('  fail "codesign"');
  lines.push('fi');
  lines.push('must /bin/rm -rf "$BACKUP"');
  lines.push('/usr/bin/xattr -dr com.apple.quarantine "$APP_ROOT" >/dev/null 2>&1 || true');
  lines.push('echo "full update complete"');
  lines.push('must /bin/rm -rf "$PENDING"');
  if (options.reopen !== false) lines.push('must /usr/bin/open -n "$APP_ROOT"');
  return lines.join('\n') + '\n';
}

function submitHelper(pending, script) {
  const scriptPath = path.join(pending, 'apply-update.sh');
  const logPath = path.join(pending, 'helper.log');
  const label = 'com.ddxmu.aicopilot.update.' + Date.now() + '.' + process.pid;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  execFileSync('/bin/launchctl', ['submit', '-l', label, '-o', logPath, '-e', logPath, '--', '/bin/sh', scriptPath], {
    stdio: 'ignore',
  });
  log('已安排独立更新助手', label, 'pending=', pending);
  return label;
}

function unpackDelta(deltaPath, targetVersion) {
  const staging = path.join(updateDir(), 'staging-' + Date.now());
  fs.mkdirSync(staging, { recursive: true });
  const deletedFiles = [];
  const seenDeleted = new Set();
  for (const entry of readZipEntries(fs.readFileSync(deltaPath))) {
    if (entry.name === '__delta_info.json') continue;
    if (entry.name === '__deleted.txt') {
      for (const line of entry.data.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const relative = safeRelativePath(line.trim());
        if (!seenDeleted.has(relative)) {
          seenDeleted.add(relative);
          deletedFiles.push(relative);
        }
      }
      continue;
    }
    if (entry.name.endsWith('/')) continue;
    const destination = safeJoin(staging, entry.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.data);
  }
  const stagedPackage = path.join(staging, 'package.json');
  if (!fs.existsSync(stagedPackage)) throw new Error('增量包缺少 package.json，已拒绝安装');
  const stagedVersion = JSON.parse(fs.readFileSync(stagedPackage, 'utf8')).version;
  if (compareVersions(stagedVersion, targetVersion) !== 0) {
    throw new Error('增量包版本不匹配（期望 ' + targetVersion + '，得到 ' + stagedVersion + '）');
  }
  return { staging, deletedFiles };
}

function scheduleDeltaUpdate(deltaPath, appPath, targetVersion, cb) {
  const unpacked = unpackDelta(deltaPath, targetVersion);
  const pending = createPendingDirectory(targetVersion);
  const filesRoot = path.join(pending, 'files');
  copyTreeSync(unpacked.staging, filesRoot);
  const files = listFiles(filesRoot);
  if (!files.includes('package.json')) throw new Error('增量暂存缺少 package.json');
  const script = makeDeltaHelperScript(pending, appPath, targetVersion, files, unpacked.deletedFiles);
  submitHelper(pending, script);
  if (cb.onStage) cb.onStage('更新已准备完成，正在退出并快速替换…');
  app.exit(0);
  return { scheduled: true, mode: 'delta' };
}

function attachDmg(dmgPath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', dmgPath], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const row = String(stdout).split('\n').find((line) => line.includes('/Volumes/'));
      const volume = row ? row.trim().split(/\t/).pop().trim() : '';
      if (!volume || !fs.existsSync(volume)) {
        reject(new Error('无法挂载完整安装包'));
        return;
      }
      resolve(volume);
    });
  });
}

function detachDmg(volume) {
  try { execFileSync('/usr/bin/hdiutil', ['detach', '-force', volume], { stdio: 'ignore' }); } catch (e) { /* cleanup only */ }
}

function copyBundle(source, destination) {
  return new Promise((resolve, reject) => {
    try { fs.rmSync(destination, { recursive: true, force: true }); } catch (e) { /* destination is isolated */ }
    execFile('/usr/bin/ditto', [source, destination], (err) => (err ? reject(err) : resolve()));
  });
}

async function scheduleFullUpdate(dmgPath, appPath, targetVersion, cb) {
  if (cb.onStage) cb.onStage('正在验证并准备完整安装包…');
  const volume = await attachDmg(dmgPath);
  try {
    const sourceApp = path.join(volume, 'AI Copilot.app');
    const packagePath = path.join(sourceApp, 'Contents', 'Resources', 'app', 'package.json');
    if (!fs.existsSync(packagePath)) throw new Error('完整安装包中没有 AI Copilot.app');
    const bundleVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
    if (compareVersions(bundleVersion, targetVersion) !== 0) {
      throw new Error('完整安装包版本不匹配（期望 ' + targetVersion + '，得到 ' + bundleVersion + '）');
    }
    const pending = createPendingDirectory(targetVersion);
    const stagedApp = path.join(pending, 'AI Copilot.app');
    if (cb.onStage) cb.onStage('正在暂存完整安装包…');
    await copyBundle(sourceApp, stagedApp);
    const script = makeFullHelperScript(pending, stagedApp, appPath);
    submitHelper(pending, script);
    if (cb.onStage) cb.onStage('完整安装包已准备完成，正在退出并替换…');
    app.exit(0);
    return { scheduled: true, mode: 'full' };
  } finally {
    detachDmg(volume);
  }
}

async function checkForUpdates() {
  const currentVersion = getCurrentVersion();
  try {
    const manifest = await fetchJson(MANIFEST_URL);
    return {
      updateAvailable: compareVersions(manifest.version, currentVersion) > 0,
      currentVersion,
      version: manifest.version || '',
      notes: manifest.notes || '',
      pubDate: manifest.pubDate || '',
      dmgUrl: manifest.dmgUrl || '',
      sha256: manifest.sha256 || '',
      deltaUrl: manifest.deltaUrl || '',
      deltaSha256: manifest.deltaSha256 || '',
      deltaFromVersion: manifest.deltaFromVersion || '',
      deltas: Array.isArray(manifest.deltas) ? manifest.deltas : [],
    };
  } catch (err) {
    return { updateAvailable: false, currentVersion, error: err.message };
  }
}

async function downloadAndInstall(manifest, cb = {}) {
  const info = typeof manifest === 'string' ? { dmgUrl: manifest } : (manifest || {});
  const targetVersion = String(info.version || '').trim();
  if (!targetVersion) throw new Error('更新清单缺少目标版本号');
  const appPath = assertAutomaticUpdateLocation();
  fs.mkdirSync(updateDir(), { recursive: true });
  const currentVersion = getCurrentVersion();
  const deltas = Array.isArray(info.deltas) ? info.deltas.slice() : [];
  if (info.deltaUrl && info.deltaFromVersion) {
    deltas.push({ from: info.deltaFromVersion, url: info.deltaUrl, sha256: info.deltaSha256 });
  }
  const delta = deltas.find((item) => item && item.from && item.url && compareVersions(item.from, currentVersion) === 0);

  if (delta) {
    try {
      const expected = String(delta.sha256 || '').toLowerCase();
      const cacheName = 'delta-' + currentVersion + '-to-' + targetVersion + '-' + expected.slice(0, 12) + '.zip';
      if (cb.onStage) cb.onStage('下载增量更新包…');
      const deltaPath = await downloadVerified(delta.url, path.join(updateDir(), cacheName), expected, {
        onProgress: (value) => cb.onProgress && cb.onProgress(value),
        onStage: (value) => cb.onStage && cb.onStage(value),
      });
      return scheduleDeltaUpdate(deltaPath, appPath, targetVersion, cb);
    } catch (err) {
      log('增量更新无法应用，回退完整安装包：', err.message);
      if (!info.dmgUrl) throw err;
      if (cb.onStage) cb.onStage('增量更新不可用，改用完整安装包…');
    }
  }

  if (!info.dmgUrl) throw new Error('未找到可用的增量包或完整安装包');
  const fullSha = String(info.sha256 || '').toLowerCase();
  const fullName = 'AI.Copilot-' + targetVersion + '-' + fullSha.slice(0, 12) + '.dmg';
  if (cb.onStage) cb.onStage('下载完整安装包…');
  const dmgPath = await downloadVerified(info.dmgUrl, path.join(updateDir(), fullName), fullSha, {
    onProgress: (value) => cb.onProgress && cb.onProgress(value),
    onStage: (value) => cb.onStage && cb.onStage(value),
  });
  return scheduleFullUpdate(dmgPath, appPath, targetVersion, cb);
}

module.exports = {
  checkForUpdates,
  downloadAndInstall,
  REPO,
  MANIFEST_URL,
  _internals: { safeRelativePath, makeDeltaHelperScript, makeFullHelperScript },
};
