#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从思源黑体（Source Han Sans / Noto Sans SC）生成界面用字体子集。

为什么需要子集化：
    完整的 NotoSansSC-VF.ttf 有 17.7 MB，直接打进 Electron 安装包会让体积
    从 78 MB 涨到 95 MB+。而桌面软件的界面用字其实非常有限（GB2312 一级
    常用字 + 少量符号就够了），子集化后能压到 1 MB 左右。

为什么用「可变字体」而不是三个静态字重：
    实测同一子集下——
        可变字体（wght 100-900 全轴）  1001 KB   ← 一个文件覆盖所有字重
        静态 400 + 500 + 700           1599 KB
    可变字体反而更小，且能支持任意字重（如 450、650 这种中间值）。

输出：
    desktop/src/renderer/fonts/source-han-sans-sc-subset.woff2

用法：
    python scripts/gen-fonts.py
"""

import os
import sys

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont
except ImportError:
    print("缺少 fontTools，请先安装：")
    print("  python -m pip install fonttools brotli")
    sys.exit(1)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "desktop", "src", "renderer", "fonts")
OUT_FILE = os.path.join(OUT_DIR, "source-han-sans-sc-subset.woff2")

# 候选源字体（Windows 系统自带 Noto Sans SC 可变字体，即思源黑体的开源版本）
CANDIDATES = [
    r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
    r"C:\Windows\Fonts\SourceHanSansSC-VF.ttf",
    "/System/Library/Fonts/Supplemental/SourceHanSansSC-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

# 会被扫描以收集用字的源码文件（保证界面文案里的字一定在子集内）
SCAN_FILES = [
    "desktop/src/renderer/index.html",
    "desktop/src/renderer/app.js",
    "desktop/src/renderer/icons.js",
    "desktop/src/main/main.js",
    "desktop/src/preload/preload.js",
    "README.md",
]

# 基础符号：ASCII 可见字符 + 中文标点 + 常用图表符号
BASE_CHARS = (
    "0123456789"
    "abcdefghijklmnopqrstuvwxyz"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    " .,:;!?()[]{}<>/\\|-_=+*&^%$#@~`'\""
    "·—…、。，；：？！“”‘’（）《》【】％"
    "◎●○◆◇★☆→←↑↓↔×÷±°№℃§¶†‡"
    "①②③④⑤⑥⑦⑧⑨⑩"
)


def find_source():
    for p in CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def collect_chars():
    """收集需要保留的全部字符。"""
    chars = set(BASE_CHARS)

    # 1) 扫描源码，把界面里出现的字全部纳入
    for rel in SCAN_FILES:
        path = os.path.join(ROOT, rel)
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    chars |= set(fh.read())
            except Exception as e:
                print(f"  ! 跳过 {rel}：{e}")

    # 2) 补 GB2312 一级汉字（3755 个最常用字）——
    #    界面上后续新增的动态文案（设备名以外的提示语等）也能安全覆盖
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode("gb2312"))
            except Exception:
                pass

    # 3) 过滤掉控制字符，保留空格
    chars = {c for c in chars if c == " " or c.strip()}
    return chars


def main():
    src = find_source()
    if not src:
        print("找不到思源黑体源文件，请确认系统已安装 Noto Sans SC / 思源黑体。")
        print("已查找的路径：")
        for p in CANDIDATES:
            print("  " + p)
        sys.exit(1)

    print(f"源字体：{src}  （{os.path.getsize(src) / 1048576:.1f} MB）")

    chars = collect_chars()
    text = "".join(sorted(chars))
    print(f"子集字符数：{len(chars)}")

    font = TTFont(src)
    has_var = "fvar" in font
    if has_var:
        axes = ", ".join(f"{a.axisTag} {a.minValue:.0f}-{a.maxValue:.0f}" for a in font["fvar"].axes)
        print(f"可变轴：{axes}")

    opts = subset.Options()
    opts.flavor = "woff2"          # 浏览器/Electron 原生支持的压缩字体格式
    opts.desubroutinize = True     # 去掉子程序化，避免部分渲染器兼容问题
    opts.drop_tables += ["DSIG"]   # 数字签名对子集无意义
    opts.notdef_outline = True
    opts.recalc_bounds = True

    setter = subset.Subsetter(options=opts)
    setter.populate(text=text)
    setter.subset(font)

    os.makedirs(OUT_DIR, exist_ok=True)
    font.flavor = "woff2"
    font.save(OUT_FILE)

    size = os.path.getsize(OUT_FILE)
    print(f"\n已生成：{os.path.relpath(OUT_FILE, ROOT)}")
    print(f"  大小：{size / 1024:.1f} KB（源字体的 {size / os.path.getsize(src) * 100:.1f}%）")
    print(f"  字重：{'可变 100-900' if has_var else '单一字重'}")


if __name__ == "__main__":
    main()
