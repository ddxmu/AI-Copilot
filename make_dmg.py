#!/usr/bin/env python3
# 打品牌化 DMG：hdiutil UDRW -> 挂载可写卷 -> 排布文件 -> Python 写 .DS_Store -> 转 UDZO
import os, shutil, subprocess, sys, time

APP = "/tmp/AIReplace/appbuild/AI Copilot.app"
ASSETS = "/tmp/AIReplace/dmg-assets"
OUT = os.path.expanduser("~/Downloads/AI Copilot-0.6.2-arm64.dmg")
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
detach_all()
for p in (TMP_DMG, OUT):
    if os.path.exists(p): os.remove(p)

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
print("完成:", OUT)
print("大小: %.1f MB" % (os.path.getsize(OUT) / 1024 / 1024))
