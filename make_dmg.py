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

    # 3.5 安装引导脚本：未签名 app 别人下载后会提示「已损坏」，
    #     双击此 .command 会弹原生安全确认（打开/取消），确认后自动拷到应用程序、去隔离、启动。
    #     .command 是脚本不会被判「已损坏」，首次右键→打开即可执行。
    install_cmd = '''#!/bin/bash
# AI Copilot 首次安装引导（独立开发者作品，未经 Apple 公证）
APP_NAME="AI Copilot"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC_APP="$HERE/$APP_NAME.app"

ANSWER=$(osascript -e 'display dialog "即将把 AI Copilot 安装到「应用程序」文件夹并打开。\\n\\n该应用为独立开发者作品、未经 Apple 公证，本脚本会自动解除隔离属性后启动。是否继续？" buttons {"取消","打开"} default button "打开" with title "AI Copilot 安装"' 2>/dev/null)
if [ $? -ne 0 ] || [[ "$ANSWER" != *打开* ]]; then
  echo "已取消。"
  exit 0
fi

if [ ! -d "$SRC_APP" ]; then
  osascript -e "display notification \\"未找到 $APP_NAME.app，请确认本脚本与 app 在同一目录（DMG 根目录）。\\" with title \\"安装失败\\""
  exit 1
fi

if [ -w "/Applications" ]; then
  DEST_DIR="/Applications"
else
  DEST_DIR="$HOME/Applications"
  mkdir -p "$DEST_DIR"
fi
DEST="$DEST_DIR/$APP_NAME.app"

echo "正在安装到 $DEST ..."
rm -rf "$DEST"
cp -R "$SRC_APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
xattr -dr com.apple.quarantine "$DEST_DIR" 2>/dev/null

echo "正在启动 $APP_NAME ..."
open "$DEST"
'''
    cmd_path = os.path.join(MOUNT, "双击安装.command")
    with open(cmd_path, "w", encoding="utf-8") as f:
        f.write(install_cmd)
    os.chmod(cmd_path, 0o755)
    print("双击安装.command 已写入")

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
