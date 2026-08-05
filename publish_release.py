#!/usr/bin/env python3
# publish_release.py — AI Copilot 发布脚本
# 流程：同步源码 → 打包 DMG → 建 GitHub Release 并上传 DMG → 写 latest.json → git 提交推送
# 用法：GITHUB_TOKEN=xxx python3 publish_release.py
import os, sys, json, shutil, subprocess, urllib.request, urllib.error, urllib.parse, hashlib, datetime

REPO = 'ddxmu/AI-Copilot'
ROOT = os.path.dirname(os.path.abspath(__file__))
APP_SRC = '/tmp/AIReplace/appbuild/AI Copilot.app/Contents/Resources/app'
ASSETS = '/tmp/AIReplace/dmg-assets'
MAKE_DMG = '/tmp/AIReplace/make_dmg.py'
PY = '/Users/dingjunjie/.workbuddy/binaries/python/versions/3.13.12/bin/python3'
API = f'https://api.github.com/repos/{REPO}'
UA = {'User-Agent': 'ai-copilot-publish'}


def run(cmd):
    print('$', ' '.join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout); print(r.stderr); sys.exit(1)
    return r


def api(method, url, token, data=None, upload=False):
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
    headers.update(UA)
    body = None
    if data is not None:
        if upload:
            headers['Content-Type'] = 'application/octet-stream'
            body = data
        else:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode('utf-8')); sys.exit(1)


def extract_notes(version):
    chlog = open(os.path.join(ROOT, 'app', 'CHANGELOG.md'), encoding='utf-8').read()
    lines = chlog.splitlines()
    out, started = [], False
    for ln in lines:
        if ln.startswith('## '):
            if started:
                break
            if version in ln:
                started = True
                continue
        if started:
            out.append(ln)
    return '\n'.join(out).strip() or f'AI Copilot {version}'


def main():
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        print('缺少环境变量 GITHUB_TOKEN（需要 repo 权限）'); sys.exit(1)

    # 1. 同步源码到仓库（非破坏性覆盖复制，不删除旧文件，避免触发沙箱拦截）
    print('== 同步源码 ==')
    run(['cp', '-Rf', APP_SRC + '/.', os.path.join(ROOT, 'app') + '/'])
    run(['cp', '-Rf', ASSETS + '/.', os.path.join(ROOT, 'dmg-assets') + '/'])

    # 同步后再读取版本号（否则会读到旧版本）
    pkg = json.load(open(os.path.join(ROOT, 'app', 'package.json'), encoding='utf-8'))
    version = pkg['version']
    tag = 'v' + version
    dmg_name = f'AI Copilot-{version}-arm64.dmg'
    dmg_path = os.path.join('/tmp/AIReplace/release', dmg_name)
    # GitHub 上传后会把文件名里的空格规范成点，统一用这个名称做资产比对/上传
    gh_asset_name = dmg_name.replace(' ', '.')

    # 2. 打包 DMG
    print('== 打包 DMG ==')
    if not os.path.exists(dmg_path):
        run([PY, MAKE_DMG])
    else:
        print('DMG 已存在，跳过打包:', dmg_path)
    if not os.path.exists(dmg_path):
        print('DMG 未生成'); sys.exit(1)

    # 3. 创建 / 获取 Release（已存在则复用）
    print('== Release', tag, '==')
    try:
        rel = api('POST', f'{API}/releases', token, {
            'tag_name': tag, 'name': f'AI Copilot {version}',
            'body': extract_notes(version), 'draft': False, 'prerelease': False,
        })
    except SystemExit:
        # 可能已存在，尝试获取
        rel = api('GET', f'{API}/releases/tags/{tag}', token)
    rel_id = rel.get('id')
    if not rel_id:
        print('无法获取 release id'); sys.exit(1)

    # 4. 上传 DMG（先删同名旧资产）
    for a in rel.get('assets', []):
        if a['name'] == gh_asset_name:
            api('DELETE', f'{API}/releases/assets/{a["id"]}', token)
    with open(dmg_path, 'rb') as f:
        data = f.read()
    name_q = urllib.parse.quote(gh_asset_name)
    upload_url = f'https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={name_q}'
    req = urllib.request.Request(upload_url, data=data, method='POST', headers={
        'Authorization': f'Bearer {token}', 'Content-Type': 'application/octet-stream', **UA})
    try:
        with urllib.request.urlopen(req) as resp:
            asset = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print('上传失败 HTTP', e.code, e.read().decode('utf-8')); sys.exit(1)
    dmg_url = asset['browser_download_url']

    # 5. 写 latest.json
    print('== 写 latest.json ==')
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    latest = {
        'version': version,
        'notes': extract_notes(version),
        'pubDate': datetime.datetime.now(tz8).isoformat(timespec='seconds'),
        'dmgUrl': dmg_url,
        'sha256': hashlib.sha256(data).hexdigest(),
    }
    json.dump(latest, open(os.path.join(ROOT, 'latest.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)

    # 6. git 提交并推送
    print('== git 提交推送 ==')
    run(['git', '-C', ROOT, 'add', '-A'])
    run(['git', '-C', ROOT, 'commit', '-m', f'release: v{version}'])
    run(['git', '-C', ROOT, 'push', 'origin', 'main'])
    print('完成。新版本', version, '已发布，App 端下次启动即可检测到。')


if __name__ == '__main__':
    main()
