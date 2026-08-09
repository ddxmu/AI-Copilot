#!/usr/bin/env python3
"""Publish a verified AI Copilot release without rewriting tags or source.

Expected order:
  1. Commit the source and create/push vX.Y.Z.
  2. Build a verified DMG with make_dmg.py.
  3. Run this script with GITHUB_TOKEN and --publish.
  4. Commit the generated latest.json separately.
"""
import argparse
import datetime
import hashlib
import io
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

ROOT = Path(__file__).resolve().parent
REPO = 'ddxmu/AI-Copilot'
API = 'https://api.github.com/repos/' + REPO
UPLOADS = 'https://uploads.github.com/repos/' + REPO


class ApiError(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def run(args, *, text=True):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=text)
    if result.returncode:
        if text:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
        raise RuntimeError('command failed: ' + ' '.join(map(str, args)))
    return result


def git_text(*args):
    return run(['git', *args]).stdout


def git_bytes(*args):
    return run(['git', *args], text=False).stdout


def sha256_file(file_path):
    digest = hashlib.sha256()
    with file_path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def version_tuple(value):
    pieces = str(value).lstrip('v').split('.')
    if len(pieces) != 3 or any(not piece.isdigit() for piece in pieces):
        raise ValueError('not a release version: ' + str(value))
    return tuple(int(piece) for piece in pieces)


def tag_version(tag):
    version_tuple(tag)
    return tag.lstrip('v')


def package_version_at(tag):
    package = json.loads(git_text('show', tag + ':app/package.json'))
    version = str(package.get('version', ''))
    if not version:
        raise RuntimeError('tag has no app version: ' + tag)
    return version


def tag_commit(tag):
    return git_text('rev-parse', tag + '^{commit}').strip()


def release_notes(tag, version):
    text = git_text('show', tag + ':app/CHANGELOG.md')
    marker = '## v' + version
    found = False
    lines = []
    for line in text.splitlines():
        if line.startswith('## '):
            if found:
                break
            if line.startswith(marker):
                found = True
                continue
        if found:
            lines.append(line)
    return '\n'.join(lines).strip() or ('AI Copilot ' + version)


def api(token, method, url_or_path, payload=None):
    url = url_or_path if url_or_path.startswith('http') else API + url_or_path
    headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'ai-copilot-release-publisher',
        'X-GitHub-Api-Version': '2022-11-28',
    }
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60, context=SSL_CONTEXT) as response:
            body = response.read()
            return json.loads(body.decode('utf-8')) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode('utf-8', errors='replace')[:1000]
        raise ApiError(error.code, 'GitHub API HTTP ' + str(error.code) + ': ' + body) from error


def curl_config_value(value):
    return json.dumps(str(value))


def upload_asset(token, release_id, asset_path):
    name = asset_path.name
    query = urllib.parse.urlencode({'name': name})
    url = UPLOADS + '/releases/' + str(release_id) + '/assets?' + query
    config = '\n'.join([
        'request = "POST"',
        'url = ' + curl_config_value(url),
        'header = ' + curl_config_value('Authorization: Bearer ' + token),
        'header = "Accept: application/vnd.github+json"',
        'header = "Content-Type: application/octet-stream"',
        'header = "User-Agent: ai-copilot-release-publisher"',
        'data-binary = ' + curl_config_value('@' + str(asset_path)),
    ]) + '\n'
    result = subprocess.run(
        ['curl', '--config', '-', '--fail-with-body', '--silent', '--show-error'],
        input=config,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise RuntimeError('asset upload failed for ' + name + ': ' + result.stderr.strip())
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError('asset upload returned invalid JSON for ' + name) from error


def get_release_by_tag(token, tag):
    try:
        return api(token, 'GET', '/releases/tags/' + urllib.parse.quote(tag, safe=''))
    except ApiError as error:
        if error.status == 404:
            return None
        raise


def delete_asset_if_present(token, release, name):
    for asset in release.get('assets', []):
        if asset.get('name') == name:
            api(token, 'DELETE', '/releases/assets/' + str(asset['id']))


def verify_asset(token, release_id, asset_path, expected_sha):
    release = api(token, 'GET', '/releases/' + str(release_id))
    asset = next((item for item in release.get('assets', []) if item.get('name') == asset_path.name), None)
    if not asset:
        raise RuntimeError('GitHub did not list uploaded asset: ' + asset_path.name)
    if int(asset.get('size', -1)) != asset_path.stat().st_size:
        raise RuntimeError('uploaded asset size mismatch: ' + asset_path.name)
    digest = str(asset.get('digest') or '').lower()
    if digest != 'sha256:' + expected_sha.lower():
        raise RuntimeError('uploaded asset digest mismatch: ' + asset_path.name)
    return asset


def safe_app_path(value):
    path_value = Path(value)
    if path_value.parts[:1] != ('app',) or '..' in path_value.parts:
        raise RuntimeError('unexpected app path in git diff: ' + value)
    return value


def build_delta(from_ref, target_tag, output_dir):
    from_version = tag_version(from_ref)
    target_version = tag_version(target_tag)
    diff = git_text('diff', '--name-status', '-M', from_ref, target_tag, '--', 'app/')
    changed = set()
    deleted = set()
    for raw_line in diff.splitlines():
        if not raw_line:
            continue
        parts = raw_line.split('\t')
        status = parts[0]
        if status.startswith('R'):
            if len(parts) != 3:
                raise RuntimeError('unexpected rename diff: ' + raw_line)
            deleted.add(safe_app_path(parts[1]))
            changed.add(safe_app_path(parts[2]))
        elif status.startswith('D'):
            if len(parts) != 2:
                raise RuntimeError('unexpected deletion diff: ' + raw_line)
            deleted.add(safe_app_path(parts[1]))
        elif status[:1] in {'A', 'M', 'C', 'T'}:
            if len(parts) < 2:
                raise RuntimeError('unexpected change diff: ' + raw_line)
            changed.add(safe_app_path(parts[-1]))
        else:
            raise RuntimeError('unsupported git diff status: ' + raw_line)

    if not changed and not deleted:
        raise RuntimeError('no app changes for delta ' + from_ref + ' -> ' + target_tag)

    output = output_dir / ('delta-' + target_version + '-from-' + from_version + '.zip')
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file_path in sorted(changed):
            data = git_bytes('show', target_tag + ':' + file_path)
            info = zipfile.ZipInfo(file_path.removeprefix('app/'))
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
        if deleted:
            archive.writestr('__deleted.txt', '\n'.join(sorted(item.removeprefix('app/') for item in deleted)) + '\n')
        archive.writestr('__delta_info.json', json.dumps({
            'from': from_version,
            'to': target_version,
            'changed': len(changed),
            'deleted': len(deleted),
        }, ensure_ascii=False, sort_keys=True))
    return output, sha256_file(output)


def discover_from_tags(target_tag):
    target = version_tuple(target_tag)
    tags = git_text('tag', '--list', 'v*').split()
    selected = []
    for tag in tags:
        try:
            version = version_tuple(tag)
        except ValueError:
            continue
        if (0, 8, 0) <= version < target:
            selected.append(tag)
    return sorted(set(selected), key=version_tuple)


def create_or_get_draft_release(token, tag, version, notes):
    existing = get_release_by_tag(token, tag)
    if existing:
        if not existing.get('draft'):
            raise RuntimeError('release already exists and is published: ' + tag)
        return existing
    return api(token, 'POST', '/releases', {
        'tag_name': tag,
        'target_commitish': tag_commit(tag),
        'name': 'AI Copilot ' + version,
        'body': notes,
        'draft': True,
        'prerelease': False,
    })


def delete_release(token, tag):
    release = get_release_by_tag(token, tag)
    if release:
        api(token, 'DELETE', '/releases/' + str(release['id']))
        print('deleted obsolete release:', tag)


def main():
    parser = argparse.ArgumentParser(description='Publish verified full and delta AI Copilot packages')
    parser.add_argument('--tag', required=True, help='already-pushed source tag, e.g. v0.8.21')
    parser.add_argument('--dmg', required=True, type=Path, help='verified full DMG')
    parser.add_argument('--artifacts-dir', type=Path, default=ROOT / 'release')
    parser.add_argument('--manifest', type=Path, default=ROOT / 'latest.json')
    parser.add_argument('--from', dest='from_tags', action='append', help='source release tag for a delta; default: all v0.8.x tags')
    parser.add_argument('--publish', action='store_true', help='publish the draft after all assets verify')
    parser.add_argument('--delete-release', action='append', default=[], help='delete this old GitHub Release after publish; tags are retained')
    args = parser.parse_args()

    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        raise RuntimeError('GITHUB_TOKEN is required')
    tag = args.tag
    version = tag_version(tag)
    if package_version_at(tag) != version:
        raise RuntimeError('tag package.json version does not match ' + tag)
    if not args.dmg.is_file():
        raise RuntimeError('DMG does not exist: ' + str(args.dmg))
    dmg_sha = sha256_file(args.dmg)
    notes = release_notes(tag, version)
    from_tags = args.from_tags or discover_from_tags(tag)
    from_tags = sorted(set(from_tags), key=version_tuple)
    for from_tag in from_tags:
        if version_tuple(from_tag) >= version_tuple(tag):
            raise RuntimeError('delta source must be older than target: ' + from_tag)

    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    release = create_or_get_draft_release(token, tag, version, notes)
    release_id = release['id']
    print('release draft:', tag, 'id=', release_id)

    delete_asset_if_present(token, release, args.dmg.name)
    upload_asset(token, release_id, args.dmg)
    full_asset = verify_asset(token, release_id, args.dmg, dmg_sha)
    deltas = []
    for from_tag in from_tags:
        delta_path, delta_sha = build_delta(from_tag, tag, args.artifacts_dir)
        release = api(token, 'GET', '/releases/' + str(release_id))
        delete_asset_if_present(token, release, delta_path.name)
        upload_asset(token, release_id, delta_path)
        asset = verify_asset(token, release_id, delta_path, delta_sha)
        deltas.append({
            'from': tag_version(from_tag),
            'url': asset['browser_download_url'],
            'sha256': delta_sha,
        })
        print('verified delta:', from_tag, '->', tag, delta_path.stat().st_size, 'bytes')

    deltas.sort(key=lambda item: version_tuple(item['from']))
    manifest = {
        'version': version,
        'notes': notes,
        'pubDate': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(timespec='seconds'),
        'dmgUrl': full_asset['browser_download_url'],
        'sha256': dmg_sha,
        'deltas': deltas,
    }
    if deltas:
        latest_delta = max(deltas, key=lambda item: version_tuple(item['from']))
        manifest.update({
            'deltaUrl': latest_delta['url'],
            'deltaSha256': latest_delta['sha256'],
            'deltaFromVersion': latest_delta['from'],
        })
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('wrote manifest:', args.manifest)

    if args.publish:
        api(token, 'PATCH', '/releases/' + str(release_id), {'draft': False})
        for obsolete_tag in args.delete_release:
            delete_release(token, obsolete_tag)
        print('published release:', tag)
    else:
        print('release remains a draft; inspect assets, then rerun with --publish')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('ERROR:', exc, file=sys.stderr)
        sys.exit(1)
