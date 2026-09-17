#!/usr/bin/env python3
# OTA 发版脚本：构建增量包 → 建 GitHub Release → 上传 → 写 latest.json
# 用法：GITHUB_TOKEN=xxx python3 tools/publish_ota.py
# 说明：此前本脚本放在 /tmp 下被系统清理过两次，现移入仓库长期保存。
import os, sys, json, subprocess, urllib.request, urllib.error, urllib.parse, hashlib, datetime

REPO = 'ddxmu/AI-Copilot'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_SRC = os.path.join(ROOT, 'app')
REL_DIR = '/tmp/AIReplace/release'
API = f'https://api.github.com/repos/{REPO}'
UA = {'User-Agent': 'ai-copilot-publish'}


def api(method, url, token, data=None, upload=False, ct=None):
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
    headers.update(UA)
    body = None
    if data is not None:
        if upload:
            headers['Content-Type'] = ct or 'application/octet-stream'
            body = data
        else:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(data).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode('utf-8')[:400])
        sys.exit(1)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def extract_notes(version):
    chlog = open(os.path.join(APP_SRC, 'CHANGELOG.md'), encoding='utf-8').read()
    out, started = [], False
    for line in chlog.splitlines():
        if line.startswith(f'## v{version}'):
            started = True
            continue
        if started and line.startswith('## v'):
            break
        if started:
            out.append(line)
    return '\n'.join(out).strip()


def main():
    token = os.environ.get('GITHUB_TOKEN') or open(os.path.expanduser('~/.workbuddy/.github_token')).read().strip()
    version = json.load(open(os.path.join(APP_SRC, 'package.json')))['version']
    tag = f'v{version}'
    print(f'== 发版 {version} ==')

    latest_path = os.path.join(ROOT, 'latest.json')
    prev = json.load(open(latest_path))['version'] if os.path.exists(latest_path) else version
    print('上一版本:', prev)
    if prev == version:
        print('!! 警告：latest.json 的上一版本与本次相同，deltas 将为空（若刚失败重发，请手动修正 deltas.from）')

    zip_name = f'AI.Copilot-{version}.zip'
    zip_path = os.path.join(REL_DIR, zip_name)
    os.makedirs(REL_DIR, exist_ok=True)
    if os.path.exists(zip_path):
        os.remove(zip_path)
    subprocess.run(['zip', '-r', '-D', '-q', zip_path, '.', '-x', 'node_modules/*', '-x', '.workbuddy/*'],
                   cwd=APP_SRC, check=True)
    zip_sha = sha256_file(zip_path)
    print(f'OTA: {zip_path} {os.path.getsize(zip_path)} bytes, sha {zip_sha}')

    rel = api('POST', f'{API}/releases', token, {
        'tag_name': tag, 'name': f'v{version}', 'body': extract_notes(version),
        'draft': False, 'prerelease': False,
    })
    rel_id = rel['id']
    print('Release id', rel_id)

    with open(zip_path, 'rb') as f:
        data = f.read()
    up = api('POST',
             f'https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={urllib.parse.quote(zip_name)}',
             token, data=data, upload=True, ct='application/zip')
    ota_url = up.get('browser_download_url') or f'https://github.com/{REPO}/releases/download/{tag}/{zip_name}'
    print('OTA url:', ota_url)

    dmg_path = os.path.join(REL_DIR, f'AI Copilot-{version}-arm64.dmg')
    dmg_sha = sha256_file(dmg_path) if os.path.exists(dmg_path) else ''
    if not dmg_sha:
        print('!! 未找到 DMG，sha256 留空：', dmg_path)

    latest = {
        'version': version,
        'notes': extract_notes(version),
        'pubDate': datetime.datetime.now().astimezone().replace(microsecond=0).isoformat(),
        'dmgUrl': f'https://github.com/{REPO}/releases/download/{tag}/AI.Copilot-{version}-arm64.dmg',
        'sha256': dmg_sha,
        'patchUrl': ota_url,
        'patchSha256': zip_sha,
        'deltas': [{'from': prev, 'url': ota_url, 'sha256': zip_sha}] if prev != version else [],
    }
    with open(latest_path, 'w', encoding='utf-8') as f:
        json.dump(latest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('latest.json 已写:', latest_path)
    print('version:', version, '| prev:', prev, '| dmg sha:', dmg_sha[:16])


if __name__ == '__main__':
    main()
