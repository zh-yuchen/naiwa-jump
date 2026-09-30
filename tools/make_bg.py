"""把 奶娃素材/ 的图去掉小红书水印，输出成游戏背景图。

结论：水印（徽章 + 「小红书号：xxxx」）在所有图里都落在最下面那条带里
      （y 约 0.86H~0.95H，横跨右边大半宽），而这条带里基本只有地面/桌面/被子之类的背景。
      所以最干净的做法是**直接把底部裁掉**：零补图痕迹，也就不用担心糊出深色块
      （试过逐图检测 + 扩散补图：检测会在咖啡杯/西装上过度命中，
        固定矩形扩散又会把深色边界摊成一块脏影）。

排除：[5] 与 [4] 同一张；[13] 竖中指；[18] 手机截图带 UI。
"""
"""本文件的路径都相对仓库自身，所以换台机器也能直接跑。
   源图默认取仓库上一级的「奶娃素材/」，可以用环境变量 SRC 覆盖。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)                       # 仓库根目录
OUTDIR = os.path.join(HERE, "_out")                # 自检图输出
os.makedirs(OUTDIR, exist_ok=True)

import numpy as np
from PIL import Image

SRC = os.environ.get("SRC") or os.path.join(os.path.dirname(REPO), "奶娃素材")
DST = os.path.join(REPO, "assets", "bg")
CHECK = os.path.join(OUTDIR, "wm_check.png")
EXCLUDE = {5, 13, 18}
MAXDIM, QUALITY = 900, 82
KEEP_H = 0.84                  # 只保留上面 84%，下面 16% 连水印一起裁掉

files = sorted(f for f in os.listdir(SRC) if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp")))
os.makedirs(DST, exist_ok=True)
pairs, n = [], 0

for i, name in enumerate(files):
    if i in EXCLUDE:
        print(f"skip [{i}] {name}")
        continue
    im = Image.open(os.path.join(SRC, name)).convert("RGB")
    W, H = im.size
    res = im.crop((0, 0, W, max(1, int(H * KEEP_H))))

    if max(res.size) > MAXDIM:
        s = MAXDIM / max(res.size)
        res = res.resize((max(1, int(res.width * s)), max(1, int(res.height * s))), Image.LANCZOS)

    n += 1
    dst = os.path.join(DST, f"bg{n:02d}.jpg")
    res.save(dst, "JPEG", quality=QUALITY, optimize=True, progressive=True)
    print(f"[{i}] {name[:24]:<26} {im.size} -> {res.size}  -> bg{n:02d}.jpg")
    pairs.append((im, res.copy(), H))

# ---- 自检：原图底部 20% vs 裁剪后底部 20% ----
CW, CH = 300, 120
sheet = Image.new("RGB", (CW * 2 + 20, len(pairs) * (CH + 4) + 8), (20, 20, 24))
for r, (b, aft, H) in enumerate(pairs):
    for c, (imx, frac) in enumerate(((b, 0.80), (aft, 0.80))):
        w, h = imx.size
        crop = imx.crop((int(w * 0.35), int(h * frac), w, h)).resize((CW, CH), Image.LANCZOS)
        sheet.paste(crop, (4 + c * (CW + 8), 4 + r * (CH + 4)))
sheet.save(CHECK)
total = sum(os.path.getsize(os.path.join(DST, f)) for f in os.listdir(DST))
print(f"\n{n} 张背景，共 {total/1024:.0f} KB   check -> {CHECK}")
