#!/usr/bin/env python3
"""Build and verify a branded, ad-hoc-signed AI Copilot DMG.

The app bundle is supplied explicitly so a release cannot accidentally package
an old bundle from a developer-specific temporary directory.
"""
import argparse
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def run(args, *, text=True):
    result = subprocess.run(args, capture_output=True, text=text)
    if result.returncode:
        if text:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
        raise RuntimeError('command failed: ' + ' '.join(map(str, args)))
    return result


def attach_dmg(image, readwrite=False):
    args = ['hdiutil', 'attach', '-nobrowse', '-plist']
    args.append('-readwrite' if readwrite else '-readonly')
    args.append(str(image))
    result = run(args, text=False)
    info = plistlib.loads(result.stdout)
    for entity in info.get('system-entities', []):
        mount = entity.get('mount-point')
        device = entity.get('dev-entry')
        if mount and device:
            return device, Path(mount)
    raise RuntimeError('hdiutil did not return a mounted volume')


def detach_dmg(device):
    subprocess.run(['hdiutil', 'detach', '-force', device], capture_output=True, text=True)


def app_version(app_path):
    package = app_path / 'Contents' / 'Resources' / 'app' / 'package.json'
    if not package.is_file():
        raise RuntimeError('missing app package.json: ' + str(package))
    version = json.loads(package.read_text(encoding='utf-8')).get('version')
    if not version:
        raise RuntimeError('package.json has no version')
    return str(version)


def sync_and_sign_app(app_path, version):
    plist_path = app_path / 'Contents' / 'Info.plist'
    if not plist_path.is_file():
        raise RuntimeError('missing Info.plist: ' + str(plist_path))
    with plist_path.open('rb') as handle:
        info = plistlib.load(handle)
    info['CFBundleShortVersionString'] = version
    info['CFBundleVersion'] = version
    with plist_path.open('wb') as handle:
        plistlib.dump(info, handle, sort_keys=False)
    run(['codesign', '--force', '--deep', '--sign', '-', str(app_path)])
    run(['codesign', '--verify', '--deep', '--strict', str(app_path)])


def verify_dmg(dmg_path, expected_version):
    run(['hdiutil', 'verify', str(dmg_path)])
    device = None
    try:
        device, mount = attach_dmg(dmg_path)
        bundle = mount / 'AI Copilot.app'
        actual_version = app_version(bundle)
        if actual_version != expected_version:
            raise RuntimeError('DMG version mismatch: ' + actual_version + ' != ' + expected_version)
        with (bundle / 'Contents' / 'Info.plist').open('rb') as handle:
            info = plistlib.load(handle)
        for key in ('CFBundleShortVersionString', 'CFBundleVersion'):
            if str(info.get(key, '')) != expected_version:
                raise RuntimeError('DMG Info.plist ' + key + ' mismatch')
        run(['codesign', '--verify', '--deep', '--strict', str(bundle)])
    finally:
        if device:
            detach_dmg(device)


def build_dmg(app_path, assets, output, overwrite):
    if not app_path.is_dir():
        raise RuntimeError('app bundle does not exist: ' + str(app_path))
    if not assets.is_dir():
        raise RuntimeError('DMG assets do not exist: ' + str(assets))
    version = app_version(app_path)
    sync_and_sign_app(app_path, version)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        if not overwrite:
            raise RuntimeError('output already exists (use --overwrite): ' + str(output))
        output.unlink()

    app_size_mb = int(run(['du', '-sm', str(app_path)]).stdout.split()[0])
    with tempfile.TemporaryDirectory(prefix='ai-copilot-dmg-') as temp:
        temp_dmg = Path(temp) / 'rw.dmg'
        run([
            'hdiutil', 'create', '-size', str(app_size_mb + 60) + 'm',
            '-fs', 'HFS+', '-volname', 'AI Copilot', '-ov', str(temp_dmg),
        ])
        device = None
        try:
            device, mount = attach_dmg(temp_dmg, readwrite=True)
            shutil.copytree(app_path, mount / 'AI Copilot.app', symlinks=True)
            shutil.copy2(assets / '使用说明.html', mount / '使用说明.html')
            (mount / 'Applications').symlink_to('/Applications')
            background = mount / '.background'
            background.mkdir(exist_ok=True)
            shutil.copy2(assets / 'background.png', background / 'background.png')
            shutil.copy2(assets / '.VolumeIcon.icns', mount / '.VolumeIcon.icns')
            ds_store = assets / 'DS_Store.reference'
            if ds_store.is_file():
                shutil.copy2(ds_store, mount / '.DS_Store')
            setfile = shutil.which('SetFile')
            if setfile:
                subprocess.run([setfile, '-a', 'C', str(mount)], capture_output=True, text=True)
        finally:
            if device:
                detach_dmg(device)
        run([
            'hdiutil', 'convert', str(temp_dmg), '-format', 'UDZO',
            '-imagekey', 'zlib-level=9', '-o', str(output),
        ])

    verify_dmg(output, version)
    return version


def main():
    parser = argparse.ArgumentParser(description='Build a verified AI Copilot DMG')
    parser.add_argument('--app', required=True, type=Path, help='path to AI Copilot.app')
    parser.add_argument('--assets', type=Path, default=ROOT / 'dmg-assets')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'release')
    parser.add_argument('--output', type=Path, help='explicit DMG output path')
    parser.add_argument('--overwrite', action='store_true')
    args = parser.parse_args()
    version = app_version(args.app)
    output = args.output or args.output_dir / ('AI.Copilot-' + version + '-arm64.dmg')
    built_version = build_dmg(args.app, args.assets, output, args.overwrite)
    print('built and verified:', output)
    print('version:', built_version)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('ERROR:', exc, file=sys.stderr)
        sys.exit(1)
