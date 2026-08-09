'use strict';

// macOS 更新助手的离线集成测试：不启动 Electron、不触碰真实应用。
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') {
  console.log('updater test skipped: macOS only');
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-copilot-updater-test-'));
const fakeApp = {
  exit() {},
  getPath(name) {
    const values = {
      userData: path.join(tempRoot, 'user-data'),
      exe: path.join(tempRoot, 'Applications', 'AI Copilot.app', 'Contents', 'MacOS', 'AI Copilot'),
      desktop: path.join(tempRoot, 'Desktop'),
      documents: path.join(tempRoot, 'Documents'),
      downloads: path.join(tempRoot, 'Downloads'),
    };
    return values[name] || tempRoot;
  },
  getVersion() { return '0.0.0'; },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return { app: fakeApp };
  if (request === './office-replace') return { readZipEntries() { return []; } };
  return originalLoad.call(this, request, parent, isMain);
};
const { _internals } = require('../app/updater');
Module._load = originalLoad;

function run(command, args) {
  childProcess.execFileSync(command, args, { stdio: 'pipe' });
}

function infoPlist(version) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleExecutable</key><string>AI Copilot</string>',
    '<key>CFBundleIdentifier</key><string>com.ddxmu.aicopilot.updater-test</string>',
    '<key>CFBundlePackageType</key><string>APPL</string>',
    '<key>CFBundleShortVersionString</key><string>' + version + '</string>',
    '<key>CFBundleVersion</key><string>' + version + '</string>',
    '</dict></plist>',
  ].join('');
}

function createApp(parent, version, markerName) {
  const appPath = path.join(parent, 'AI Copilot.app');
  const resources = path.join(appPath, 'Contents', 'Resources', 'app');
  const macos = path.join(appPath, 'Contents', 'MacOS');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), infoPlist(version));
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({ name: 'ai-copilot', version }, null, 2));
  fs.writeFileSync(path.join(resources, markerName), version);
  fs.copyFileSync('/bin/echo', path.join(macos, 'AI Copilot'));
  fs.chmodSync(path.join(macos, 'AI Copilot'), 0o755);
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath]);
  return appPath;
}

function packageVersion(appPath) {
  const file = path.join(appPath, 'Contents', 'Resources', 'app', 'package.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).version;
}

function testDeltaHelper() {
  const appPath = createApp(path.join(tempRoot, 'delta-target'), '0.8.20', 'old.txt');
  const pending = path.join(tempRoot, 'delta-pending');
  const files = path.join(pending, 'files');
  fs.mkdirSync(path.join(files, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(files, 'package.json'), JSON.stringify({ name: 'ai-copilot', version: '0.8.21' }));
  fs.writeFileSync(path.join(files, 'nested', 'new.txt'), 'new version');
  const script = _internals.makeDeltaHelperScript(
    pending,
    appPath,
    '0.8.21',
    ['nested/new.txt', 'package.json'],
    ['old.txt'],
    { waitForPid: 99999999, reopen: false }
  );
  const scriptPath = path.join(pending, 'apply-update.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  run('/bin/sh', [scriptPath]);
  assert.strictEqual(packageVersion(appPath), '0.8.21');
  assert.strictEqual(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'app', 'nested', 'new.txt'), 'utf8'), 'new version');
  assert.ok(!fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app', 'old.txt')));
  assert.strictEqual(childProcess.execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim(), '0.8.21');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}

function testFullHelper() {
  const appPath = createApp(path.join(tempRoot, 'full-target'), '0.8.20', 'old.txt');
  const pending = path.join(tempRoot, 'full-pending');
  const stagedApp = createApp(path.join(pending, 'payload'), '0.8.21', 'new.txt');
  const script = _internals.makeFullHelperScript(pending, stagedApp, appPath, { waitForPid: 99999999, reopen: false });
  const scriptPath = path.join(pending, 'apply-update.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  run('/bin/sh', [scriptPath]);
  assert.strictEqual(packageVersion(appPath), '0.8.21');
  assert.strictEqual(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'app', 'new.txt'), 'utf8'), '0.8.21');
  assert.ok(!fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app', 'old.txt')));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}

async function testLaunchctlDeltaHelper() {
  const appPath = createApp(path.join(tempRoot, 'launchctl-target'), '0.8.20', 'old.txt');
  const pending = path.join(tempRoot, 'launchctl-pending');
  const files = path.join(pending, 'files');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'package.json'), JSON.stringify({ name: 'ai-copilot', version: '0.8.21' }));
  const sleeper = childProcess.spawn('/bin/sleep', ['1']);
  const script = _internals.makeDeltaHelperScript(
    pending,
    appPath,
    '0.8.21',
    ['package.json'],
    ['old.txt'],
    { waitForPid: sleeper.pid, reopen: false }
  );
  const scriptPath = path.join(pending, 'apply-update.sh');
  const logPath = path.join(pending, 'helper.log');
  const label = 'com.ddxmu.aicopilot.updater-test.' + Date.now();
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  run('/bin/launchctl', ['submit', '-l', label, '-o', logPath, '-e', logPath, '--', '/bin/sh', scriptPath]);
  await new Promise((resolve, reject) => {
    sleeper.once('error', reject);
    sleeper.once('close', resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const helperLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : 'helper log was not created';
  assert.strictEqual(packageVersion(appPath), '0.8.21', helperLog);
  assert.ok(!fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'app', 'old.txt')));
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}

(async () => {
  try {
    assert.throws(() => _internals.safeRelativePath('../outside'));
    assert.throws(() => _internals.safeRelativePath('/absolute'));
    assert.strictEqual(_internals.safeRelativePath('renderer/app.js'), 'renderer/app.js');
    testDeltaHelper();
    testFullHelper();
    await testLaunchctlDeltaHelper();
    console.log('updater helper integration tests passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
