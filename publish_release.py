#!/usr/bin/env python3
# publish_release.py — AI Copilot 发布脚本（含增量包）
# 流程：同步源码 → 打包 DMG → 建 GitHub Release 并上传 DMG →
#       git 提交+打 tag → 构建增量 delta zip → 上传 delta → 写 latest.json → push
# 用法：GITHUB_TOKEN=xxx python3 publish_release.py
import os, sys, json, shutil, subprocess, urllib.request, urllib.error, urllib.parse, hashlib, datetime, zipfile, io, socket, time

REPO = 'ddxmu/AI-Copilot'
ROOT = os.path.dirname(os.path.abspath(__file__))
APP_SRC = '/tmp/AIReplace/appbuild/AI Copilot.app/Contents/Resources/app'
ASSETS = '/tmp/AIReplace/dmg-assets'
MAKE_DMG = '/tmp/AIReplace/make_dmg.py'
PY = '/Users/dingjunjie/.workbuddy/binaries/python/versions/3.13.12/bin/python3'
API = f'https://api.github.com/repos/{REPO}'
UA = {'User-Agent': 'ai-copilot-publish'}
DELTA_DIR = '/tmp/AIReplace/release'


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
    last_err = None
    for attempt in range(5):
        req = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            # 409/422 等语义错误直接抛出由调用方处理；5xx/网络错误重试
            if e.code < 500:
                print('HTTP', e.code, e.read().decode('utf-8')); sys.exit(1)
            last_err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError, socket.timeout) as e:
            last_err = e
        import time as _t
        print(f'  api 重试 ({attempt+1}/5): {last_err}')
        _t.sleep(8 * (attempt + 1))
    print('api 最终失败:', last_err); sys.exit(1)


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


def stream_sha256(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def upload_asset(token, rel_id, name, filepath=None, data=None):
    """流式上传资产（curl 子进程，不占内存）。filepath 优先，否则用 data(bytes)。"""
    name_q = urllib.parse.quote(name)
    upload_url = f'https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets?name={name_q}'
    cmd = ['curl', '-sS', '-X', 'POST',
           '-H', f'Authorization: Bearer {token}',
           '-H', 'Content-Type: application/octet-stream',
           '-H', 'User-Agent: ai-copilot-publish',
           '--max-time', '3600',
           '--retry', '5', '--retry-delay', '10', '--retry-all-errors',
           upload_url]
    if filepath:
        cmd += ['--data-binary', f'@{filepath}']
    else:
        cmd += ['--data-binary', data]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print('上传失败:', r.stderr); sys.exit(1)
    try:
        asset = json.loads(r.stdout)
    except Exception:
        print('上传返回非 JSON:', r.stdout[:200]); sys.exit(1)
    return asset['browser_download_url']


def delete_existing_asset(token, rel, name):
    for a in rel.get('assets', []):
        if a['name'] == name:
            api('DELETE', f'{API}/releases/assets/{a["id"]}', token)


def git_tag_exists(tag):
    r = subprocess.run(['git', '-C', ROOT, 'tag', '-l', tag], capture_output=True, text=True)
    return r.stdout.strip() == tag


def list_version_tags():
    tags = subprocess.run(['git', '-C', ROOT, 'tag', '--list', 'v[0-9]*.*[0-9]'],
                         capture_output=True, text=True).stdout.split()
    out = []
    for t in tags:
        if t.startswith('v') and t[1:].count('.') == 2:
            try:
                out.append(t)
            except Exception:
                pass
    return out


def ver_tuple(v):
    v = v[1:] if v.startswith('v') else v
    parts = v.split('.')
    return tuple(int(x) for x in parts[:3]) + (0,) * (3 - min(len(parts), 3))


def cmp_ver(a, b):
    ta, tb = ver_tuple(a), ver_tuple(b)
    return (ta > tb) - (ta < tb)


def build_delta(prev_tag, version):
    """基于 git diff 构建增量 zip，返回 (bytes, sha256) 或 None"""
    cur_tag = 'v' + version
    # 对比上一版本 tag 与当前工作区 app/ 的差异（工作区含本次未提交改动）
    r = subprocess.run(
        ['git', '-C', ROOT, 'diff', '--name-status', prev_tag, '--', 'app/'],
        capture_output=True, text=True)
    if r.returncode != 0:
        print('git diff 失败:', r.stderr); return None
    lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    if not lines:
        print('无变更文件，跳过 delta'); return None

    changed, deleted = [], []
    for line in lines:
        parts = line.split('\t')
        status = parts[0]
        if status.startswith('A') or status.startswith('M') or status.startswith('R'):
            # R100\told\tnew → 取 new
            filepath = parts[-1]
            changed.append(filepath)
        elif status.startswith('D'):
            deleted.append(parts[-1])

    if not changed and not deleted:
        print('无实质变更，跳过 delta'); return None

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for fp in changed:
            full = os.path.join(ROOT, fp)
            if os.path.isfile(full):
                # zip 内路径：去掉 app/ 前缀，保留相对结构
                arcname = fp[len('app/'):] if fp.startswith('app/') else fp
                zf.write(full, arcname)
        if deleted:
            del_content = '\n'.join(
                fp[len('app/'):] if fp.startswith('app/') else fp for fp in deleted
            ) + '\n'
            zf.writestr('__deleted.txt', del_content)
        # 写版本信息
        zf.writestr('__delta_info.json', json.dumps({
            'from': prev_tag, 'to': cur_tag, 'changed': len(changed), 'deleted': len(deleted),
        }, ensure_ascii=False, indent=2))

    data = buf.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    print(f'delta 构建: {len(changed)} 改动, {len(deleted)} 删除, {len(data)} bytes')
    return data, sha


def files_equal(a, b):
    if os.path.getsize(a) != os.path.getsize(b):
        return False
    h1, h2 = hashlib.sha256(), hashlib.sha256()
    with open(a, 'rb') as f1, open(b, 'rb') as f2:
        for c1, c2 in zip(iter(lambda: f1.read(1024 * 1024), b''),
                          iter(lambda: f2.read(1024 * 1024), b'')):
            h1.update(c1); h2.update(c2)
    return h1.digest() == h2.digest()


def build_delta_from_dir(old_app_dir, version, from_v):
    """对比 old_app_dir 与当前工作区 app/，生成增量 zip，返回 (bytes, sha256) 或 None。"""
    cur_app = os.path.join(ROOT, 'app')
    changed, deleted = [], []
    cur_files = set()
    for root, dirs, files in os.walk(cur_app):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, cur_app)
            cur_files.add(rel)
            old_full = os.path.join(old_app_dir, rel)
            if os.path.exists(old_full):
                if not files_equal(full, old_full):
                    changed.append(rel)
            else:
                changed.append(rel)
    for root, dirs, files in os.walk(old_app_dir):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, old_app_dir)
            if rel not in cur_files:
                deleted.append(rel)
    if not changed and not deleted:
        print(f'  {from_v} 无变更，跳过'); return None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for rel in changed:
            zf.write(os.path.join(cur_app, rel), rel)
        if deleted:
            zf.writestr('__deleted.txt', '\n'.join(deleted) + '\n')
        zf.writestr('__delta_info.json', json.dumps({
            'from': from_v, 'to': version, 'changed': len(changed), 'deleted': len(deleted),
        }, ensure_ascii=False, indent=2))
    data = buf.getvalue()
    sha = hashlib.sha256(data).hexdigest()
    print(f'  delta(from {from_v}) 构建: {len(changed)} 改动, {len(deleted)} 删除, {len(data)} bytes')
    return data, sha


def main():
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        print('缺少环境变量 GITHUB_TOKEN（需要 repo 权限）'); sys.exit(1)

    # 0. 读取上一版本号（从现有 latest.json，覆写前）
    prev_version = None
    latest_path = os.path.join(ROOT, 'latest.json')
    if os.path.exists(latest_path):
        try:
            old = json.load(open(latest_path, encoding='utf-8'))
            prev_version = old.get('version')
        except Exception:
            pass

    # 1. 同步源码到仓库
    print('== 同步源码 ==')
    run(['cp', '-Rf', APP_SRC + '/.', os.path.join(ROOT, 'app') + '/'])
    run(['cp', '-Rf', ASSETS + '/.', os.path.join(ROOT, 'dmg-assets') + '/'])

    # 同步后再读取版本号
    pkg = json.load(open(os.path.join(ROOT, 'app', 'package.json'), encoding='utf-8'))
    version = pkg['version']
    tag = 'v' + version
    dmg_name = f'AI Copilot-{version}-arm64.dmg'
    dmg_path = os.path.join('/tmp/AIReplace/release', dmg_name)
    gh_asset_name = dmg_name.replace(' ', '.')
    delta_name = f'delta-{version}.zip'

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
        rel = api('GET', f'{API}/releases/tags/{tag}', token)
    rel_id = rel.get('id')
    if not rel_id:
        print('无法获取 release id'); sys.exit(1)

    # 4. 上传 DMG（流式，先删同名旧资产）
    print('== 上传 DMG ==')
    delete_existing_asset(token, rel, gh_asset_name)
    dmg_url = upload_asset(token, rel_id, gh_asset_name, filepath=dmg_path)
    dmg_sha = stream_sha256(dmg_path)
    print('DMG url:', dmg_url)

    # 5. git 提交 + 打 tag
    print('== git 提交 + tag ==')
    run(['git', '-C', ROOT, 'add', '-A'])
    run(['git', '-C', ROOT, 'commit', '--allow-empty', '-m', f'release: v{version}'])
    if not git_tag_exists(tag):
        run(['git', '-C', ROOT, 'tag', tag])

    # 6. 构建增量包：为每个历史版本都生成「到当前版本」的独立 delta，
    #    写入 latest.json 的 deltas 数组。完整包始终作为兜底，任何老版本都能升级。
    delta_url = None
    delta_sha = None
    delta_from = None
    deltas = []
    # 历史 tag（< 当前版本，且 >= v0.8.0）逐个生成 delta
    hist_tags = [t for t in list_version_tags()
                 if cmp_ver(t, tag) < 0 and cmp_ver(t, 'v0.8.0') >= 0]
    hist_tags.sort(key=ver_tuple)
    print(f'== 历史版本数：{len(hist_tags)}，逐个构建增量 ==')
    for ht in hist_tags:
        ht_v = ht[1:]  # 去掉 v 前缀
        if not git_tag_exists(ht):
            print(f'  跳过 {ht}（tag 不存在）'); continue
        print(f'== 构建增量 {ht} → {tag} ==')
        result = build_delta(ht, version)
        if not result:
            print(f'  {ht} 无变更，跳过'); continue
        delta_data, delta_sha_i = result
        dname = f'delta-{version}-from-{ht_v}.zip'
        dpath = os.path.join(DELTA_DIR, dname)
        with open(dpath, 'wb') as f:
            f.write(delta_data)
        print('== 上传 delta ==')
        delete_existing_asset(token, rel, dname)
        durl = upload_asset(token, rel_id, dname, filepath=dpath)
        deltas.append({'from': ht_v, 'url': durl, 'sha256': delta_sha_i})
        print('delta url:', durl, f'({len(delta_data)} bytes)')
    # 6.5 额外处理无 git tag 的基线 v0.8.24（从本地 DMG 提取 app/ 对比当前工作区）
    BASELINE_0824 = os.path.expanduser('~/Downloads/AI.Copilot-0.8.24-arm64.dmg')
    if os.path.exists(BASELINE_0824):
        print('== 为无 tag 的基线 v0.8.24 构建增量 ==')
        mnt = '/tmp/mnt0824_baseline'
        os.makedirs(mnt, exist_ok=True)
        try:
            subprocess.run(['hdiutil', 'attach', '-nobrowse', '-mountpoint', mnt, BASELINE_0824], check=True)
            old_app = os.path.join(mnt, 'AI Copilot.app/Contents/Resources/app')
            result = build_delta_from_dir(old_app, version, '0.8.24')
            if result:
                delta_data, delta_sha_i = result
                dname = f'delta-{version}-from-0.8.24.zip'
                dpath = os.path.join(DELTA_DIR, dname)
                with open(dpath, 'wb') as f:
                    f.write(delta_data)
                print('== 上传 delta (0.8.24) ==')
                delete_existing_asset(token, rel, dname)
                durl = upload_asset(token, rel_id, dname, filepath=dpath)
                deltas.append({'from': '0.8.24', 'url': durl, 'sha256': delta_sha_i})
                # 兼容旧更新器的单 deltaUrl：以用户当前所在版本 0.8.24 作为主增量源
                delta_url = durl
                delta_sha = delta_sha_i
                delta_from = '0.8.24'
                print('delta url:', durl, f'({len(delta_data)} bytes)')
        finally:
            subprocess.run(['hdiutil', 'detach', mnt], check=False)
    else:
        print('警告：未找到 0.8.24 基线 DMG，跳过 0.8.24 delta')

    # 7. 写 latest.json
    print('== 写 latest.json ==')
    tz8 = datetime.timezone(datetime.timedelta(hours=8))
    latest = {
        'version': version,
        'notes': extract_notes(version),
        'pubDate': datetime.datetime.now(tz8).isoformat(timespec='seconds'),
        'dmgUrl': dmg_url,
        'sha256': dmg_sha,
    }
    if delta_url:
        latest['deltaUrl'] = delta_url
        latest['deltaSha256'] = delta_sha
        latest['deltaFromVersion'] = delta_from
    if deltas:
        latest['deltas'] = deltas
    json.dump(latest, open(latest_path, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=2)

    # 8. git 推送（含 tag）
    print('== git 推送 ==')
    run(['git', '-C', ROOT, 'add', '-A'])
    # latest.json 变了，amend 到刚才的 commit
    run(['git', '-C', ROOT, 'commit', '--amend', '--no-edit'])
    run(['git', '-C', ROOT, 'push', 'origin', 'main', '--tags', '--force'])
    print('完成。新版本', version, '已发布。')
    if delta_url:
        print(f'增量包: {delta_from} → {version}，App 端在线升级将只下载 delta。')


if __name__ == '__main__':
    main()
