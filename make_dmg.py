#!/usr/bin/env python3
# 打品牌化 DMG：hdiutil UDRW -> 挂载可写卷 -> 排布文件 -> Python 写 .DS_Store -> 转 UDZO
import os, shutil, subprocess, sys, time, json

APP = "/tmp/AIReplace/appbuild/AI Copilot.app"
ASSETS = "/tmp/AIReplace/dmg-assets"
PKG = json.load(open(os.path.join(APP, "Contents", "Resources", "app", "package.json"), encoding="utf-8"))
VERSION = PKG["version"]
OUT_DIR = "/tmp/AIReplace/release"
OUT = os.path.join(OUT_DIR, f"AI Copilot-{VERSION}-arm64.dmg")
VOL = "AI Copilot"
TMP_DMG = "/tmp/AIReplace/_tmp_aicopilot.dmg"
MOUNT = "/Volumes/" + VOL

def run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode != 0:
        print("FAIL:", " ".join(cmd)); print(r.stdout); print(r.stderr); sys.exit(1)
    return r

def detach_all():
    for _ in range(3):
        r = subprocess.run(["hdiutil", "info"], capture_output=True, text=True)
        for line in r.stdout.splitlines():
            line = line.strip()
            if line.startswith("/dev/disk"):
                subprocess.run(["hdiutil", "detach", "-force", line.split()[0]],
                               capture_output=True)
        time.sleep(1)

# 0. 清理
os.makedirs(OUT_DIR, exist_ok=True)
detach_all()
for p in (TMP_DMG, OUT):
    if os.path.exists(p): os.remove(p)

# 0.5 重新 ad-hoc 签名 app（rsync 后签名会失效，失效+quarantine 会被判「已损坏」）。
#     正确顺序：先签所有 framework（--deep 签内部二进制）→ 签 helper apps → 签主 app。
#     这样 spctl 评估为「rejected」（=无法验证开发者，用户右键→打开或系统设置→仍要打开），
#     而非「sealed resource missing/invalid」（=已损坏，无法打开）。无 Developer ID 证书下
#     最接近 WorkBuddy（正式签名）的安装体验。
print("重新 ad-hoc 签名 app ...")
_fw_dir = os.path.join(APP, "Contents", "Frameworks")
if os.path.isdir(_fw_dir):
    for _name in sorted(os.listdir(_fw_dir)):
        _p = os.path.join(_fw_dir, _name)
        if _name.endswith(".framework"):
            subprocess.run(["codesign", "--force", "--deep", "--sign", "-", _p], capture_output=True)
        elif _name.endswith(".app"):
            subprocess.run(["codesign", "--force", "--sign", "-", _p], capture_output=True)
subprocess.run(["codesign", "--force", "--sign", "-", APP], capture_output=True)
# 用 spctl 判定：rejected 可接受（=无法验证开发者，可右键打开）；
# sealed resource missing / invalid 不可接受（=已损坏）
_ar = subprocess.run(["spctl", "-a", "-t", "exec", APP], capture_output=True, text=True)
_assess = (_ar.stdout + _ar.stderr).lower()
if "sealed resource" in _assess or "invalid" in _assess or "damaged" in _assess:
    print("签名校验失败（仍判已损坏）："); print(_ar.stdout); print(_ar.stderr); sys.exit(1)
print("app 签名完成（spctl:", (_ar.stdout + _ar.stderr).strip().splitlines()[-1] if (_ar.stdout + _ar.stderr).strip() else "ok", ")")

# 1. 计算 app 大小，建足够大的可写 dmg
size_mb = int(run(["du", "-sm", APP]).stdout.split()[0]) + 60
print(f"app 大小 ~{size_mb-60}MB, dmg 分配 {size_mb}MB")
run(["hdiutil", "create", "-size", f"{size_mb}m", "-fs", "HFS+",
     "-volname", VOL, "-ov", TMP_DMG])

# 2. 挂载可写卷
run(["hdiutil", "attach", "-nobrowse", "-readwrite", TMP_DMG])
if not os.path.isdir(MOUNT):
    print("挂载失败"); sys.exit(1)

try:
    # 3. 拷贝 app / 使用说明 / Applications 软链
    shutil.copytree(APP, os.path.join(MOUNT, "AI Copilot.app"), symlinks=True)
    shutil.copy(os.path.join(ASSETS, "使用说明.html"), os.path.join(MOUNT, "使用说明.html"))
    os.symlink("/Applications", os.path.join(MOUNT, "Applications"))

    # 4. 背景图 + 卷标图标
    os.makedirs(os.path.join(MOUNT, ".background"), exist_ok=True)
    shutil.copy(os.path.join(ASSETS, "background.png"), os.path.join(MOUNT, ".background", "background.png"))
    shutil.copy(os.path.join(ASSETS, ".VolumeIcon.icns"), os.path.join(MOUNT, ".VolumeIcon.icns"))
    subprocess.run(["SetFile", "-a", "C", MOUNT], capture_output=True)

    # 5. 复用旧版正确的 .DS_Store（窗口/图标位置/背景布局完全一致）
    shutil.copy(os.path.join(ASSETS, "DS_Store.reference"), os.path.join(MOUNT, ".DS_Store"))
    print(".DS_Store 复用完成")
finally:
    run(["hdiutil", "detach", MOUNT], check=False)
    time.sleep(1)

# 6. 转 UDZO 压缩只读
run(["hdiutil", "convert", TMP_DMG, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", OUT])
os.remove(TMP_DMG)
# 7. 给 DMG 本身 ad-hoc 签名（进一步降低被 Gatekeeper 判「已损坏」的概率）
run(["codesign", "--force", "--sign", "-", OUT])
print("完成:", OUT)
print("大小: %.1f MB" % (os.path.getsize(OUT) / 1024 / 1024))
