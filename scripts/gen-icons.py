# -*- coding: utf-8 -*-
"""
由源 logo 生成两端所需的全套图标资源。

电脑端（Electron / electron-builder，Windows）：
  desktop/resources/icon.png  512x512  （窗口/任务栏，运行时）
  desktop/resources/icon.ico  多尺寸 ICO（16/24/32/48/64/128/256，打包安装包+exe 图标）

手机端（Capacitor / Android）：
  mobile/resources/icon.png                1024x1024  应用图标源
  mobile/resources/icon-foreground.png     1024x1024  自适应图标前景（留安全边距）
  mobile/resources/icon-background.png     1024x1024  自适应图标背景（纯品牌绿）
  mobile/resources/splash.png              2732x2732  启动图源
  mobile/resources/splash-dark.png         2732x2732  深色启动图源
  mobile/public/icon-192.png / 512.png     PWA / manifest

用法：python scripts/gen-icons.py
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r"C:/Users/User/Downloads/icon-logo.png"
BRAND = (0, 210, 131)          # 品牌绿 #00d283
BG_DARK = (13, 18, 21)         # 应用底色 #0d1215

def out(*p):
    return os.path.join(ROOT, *p)

def ensure(d):
    os.makedirs(d, exist_ok=True)

def square(im, size, bg=None):
    """缩放为正方形，必要时先铺底色"""
    im = im.convert("RGBA")
    if bg is not None:
        base = Image.new("RGBA", im.size, bg + (255,))
        base.alpha_composite(im)
        im = base
    return im.resize((size, size), Image.LANCZOS)

ensure(out("desktop", "resources"))
ensure(out("mobile", "resources"))
ensure(out("mobile", "public"))

src = Image.open(SRC).convert("RGBA")
w, h = src.size
print(f"源图 {w}x{h}")

# ── 电脑端 ─────────────────────────────────────────────
icon512 = square(src, 512)
icon512.save(out("desktop", "resources", "icon.png"))
print("✓ desktop/resources/icon.png (512x512)")

# ICO 多尺寸（electron-builder 用）
ico_path = out("desktop", "resources", "icon.ico")
src.resize((256, 256), Image.LANCZOS).save(
    ico_path, format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("✓ desktop/resources/icon.ico (16..256)")

# ── 手机端 ─────────────────────────────────────────────
square(src, 1024).save(out("mobile", "resources", "icon.png"))
print("✓ mobile/resources/icon.png (1024x1024)")

# 自适应图标：前景缩到 62% 居中（Android 安全区），背景纯品牌绿
fg_canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
inner = square(src, int(1024 * 0.62))
fg_canvas.alpha_composite(inner, ((1024 - inner.width) // 2, (1024 - inner.height) // 2))
fg_canvas.save(out("mobile", "resources", "icon-foreground.png"))
print("✓ mobile/resources/icon-foreground.png (62% 安全区)")

Image.new("RGBA", (1024, 1024), BRAND + (255,)).save(out("mobile", "resources", "icon-background.png"))
print("✓ mobile/resources/icon-background.png (品牌绿)")

# 启动图：深色底 + 居中 logo（约 26% 宽）
for name, bg in (("splash.png", (255, 255, 255)), ("splash-dark.png", BG_DARK)):
    canvas = Image.new("RGBA", (2732, 2732), bg + (255,))
    logo = square(src, 720)
    canvas.alpha_composite(logo, ((2732 - 720) // 2, (2732 - 720) // 2))
    canvas.save(out("mobile", "resources", name))
    print(f"✓ mobile/resources/{name} (2732x2732)")

# PWA
square(src, 192).save(out("mobile", "public", "icon-192.png"))
square(src, 512).save(out("mobile", "public", "icon-512.png"))
print("✓ mobile/public/icon-192.png / icon-512.png")

# 渲染层用的小图标（顶栏 logo，透明底）
square(src, 128).save(out("desktop", "src", "renderer", "logo.png"))
square(src, 256).save(out("mobile", "public", "logo.png"))
print("✓ desktop/src/renderer/logo.png (128) / mobile/public/logo.png (256)")
print("\n全部图标生成完成。")
