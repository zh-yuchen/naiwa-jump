"""把奶蛙蛋从白底里抠出来（带 alpha），并抹掉它自带的五官，
   这样游戏里还能继续画「开心/无语/震惊/破防」四种表情。

   关键点：不能用「饱和度」直接当 alpha —— 眼睛的黑色瞳孔和白色高光饱和度都很低，
   那样会被当成透明，而且抹脸时也会被排除在 mask 之外（第一版就栽在这）。
   正确做法是先求「蛋的实心轮廓」（背景从四角灌水，灌不到的就是蛋的内部），
   再在实心区域内做修复。
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
from collections import deque
from PIL import Image, ImageFilter

EGG = os.environ.get("EGG") or os.path.join(os.path.dirname(REPO), "ced5d879169e3ae61d6f676f63b39bf6.jpg")
OUT = os.path.join(REPO, "assets", "img", "naiwa-body.png")
CHECK = os.path.join(OUTDIR, "egg_check.png")


def _resize(a, size):
    return np.asarray(Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
                      .resize(size, Image.BILINEAR)).astype(np.float32)


def _jacobi(out, m, iters):
    """洞内取四邻域平均，洞外永不变（拉普拉斯扩散）。"""
    m3 = m[..., None]
    for _ in range(iters):
        up = np.roll(out, 1, 0); dn = np.roll(out, -1, 0)
        lf = np.roll(out, 1, 1); rt = np.roll(out, -1, 1)
        out = np.where(m3, (up + dn + lf + rt) * 0.25, out)
    return out


def inpaint(img, mask, iters=300):
    """Jacobi 扩散每轮只能推进约 1 像素，直接迭代要 O(N²) 轮。
    所以先在 1/8 缩略图上求低频解，再回全分辨率细化（multigrid 思路）。"""
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return img
    y0, y1 = max(0, ys.min() - 32), min(img.shape[0], ys.max() + 33)
    x0, x1 = max(0, xs.min() - 32), min(img.shape[1], xs.max() + 33)
    sub = img[y0:y1, x0:x1].copy()
    m = mask[y0:y1, x0:x1].copy()
    h, w = m.shape

    f = 8
    sw, sh = max(2, w // f), max(2, h // f)
    small = _resize(sub, (sw, sh))
    sm = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((sw, sh), Image.BILINEAR)) > 40
    if sm.any():
        small = _jacobi(small, sm, 400)

    out = sub.copy()
    init = _resize(small, (w, h))
    out[m] = init[m]
    out = _jacobi(out, m, iters)
    img[y0:y1, x0:x1] = out
    return img


# ============ 1. 读图，求实心轮廓 ============
im = Image.open(EGG).convert("RGB")
a = np.asarray(im).astype(np.float32)
H, W, _ = a.shape
r, g, b = a[..., 0], a[..., 1], a[..., 2]
sat = a.max(2) - a.min(2)

# 背景候选（白底 + 灰色地面投影都是低饱和）
bgm = sat < 20
# 蛋底部的黄色很饱和(sat>100)，但地面投影是灰的(sat 20~45)，
# 所以在下部放宽阈值，把投影也算成背景，免得留一圈白边
band = np.zeros((H, W), bool)
band[int(H * 0.70):, :] = True
bgm = bgm | (band & (sat < 48))
print("bg candidates:", int(bgm.sum()), "of", H * W, " corner sat:", float(sat[0, 0]))

# 从四条边往里灌水：灌得到的就是外面，灌不到的就是蛋的内部（眼睛这些洞会被自动填上）
outside = np.zeros((H, W), bool)
dq = deque()
for x in range(W):
    for y in (0, H - 1):
        if bgm[y, x] and not outside[y, x]:
            outside[y, x] = True; dq.append((y, x))
for y in range(H):
    for x in (0, W - 1):
        if bgm[y, x] and not outside[y, x]:
            outside[y, x] = True; dq.append((y, x))
while dq:
    y, x = dq.popleft()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        yy, xx = y + dy, x + dx
        if 0 <= yy < H and 0 <= xx < W and bgm[yy, xx] and not outside[yy, xx]:
            outside[yy, xx] = True; dq.append((yy, xx))

solid = ~outside                                            # 灌不到 = 蛋
# 蛋体本身很黄(sat>60)，地面投影是灰的。用"黄核"的下边界当蛋的真实底边，
# 把投影那一圈整条切掉，否则底下会留一条毛边。
core = sat > 60
cy, cx = np.where(core)
y_core_bot = int(cy.max())
print("core bbox:", cx.min(), cy.min(), cx.max(), y_core_bot)
solid[y_core_bot + 1:, :] = False

# 边缘抗锯齿像素半黄半灰，向内腐蚀 1px 削掉白边
solid = (solid & np.roll(solid, 1, 0) & np.roll(solid, -1, 0)
         & np.roll(solid, 1, 1) & np.roll(solid, -1, 1))
print("solid pixels:", int(solid.sum()), "of", H * W)
ys, xs = np.where(solid)
print("egg bbox:", xs.min(), ys.min(), xs.max(), ys.max(), " area:", int(solid.sum()))

pad = 10
y0, y1 = max(0, ys.min() - pad), min(H, y_core_bot + 3)
x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad + 1)

body = a[y0:y1, x0:x1].copy()
sil = solid[y0:y1, x0:x1].copy()
bh, bw = sil.shape
print("cropped:", bw, "x", bh)

# ============ 2. 抹脸 ============
eye = (g > r + 6) & (g > b + 6) & (sat > 30)
ey, ex = np.where(eye[y0:y1, x0:x1])
if len(ey):
    print("eye bbox local:", ex.min(), ey.min(), ex.max(), ey.max())
    face = np.zeros((bh, bw), bool)
    m = int(bw * 0.055)
    fx0, fx1 = max(0, ex.min() - m), min(bw, ex.max() + m)
    face[max(0, ey.min() - m):min(bh, ey.max() + m), fx0:fx1] = True          # 眼睛
    face[min(bh, ey.max() + m):min(bh, ey.max() + int(bh * 0.22)), fx0:fx1] = True  # 嘴
    body = inpaint(body, face, iters=400)

# ============ 3. 输出带 alpha 的贴图 ============
al = np.asarray(Image.fromarray((sil * 255).astype(np.uint8))
                .filter(ImageFilter.GaussianBlur(1.0))).astype(np.float32) / 255.0
rgba = np.dstack([np.clip(body, 0, 255), (al * 255)]).astype(np.uint8)
out = Image.fromarray(rgba, "RGBA")
out.save(OUT)
print("saved", OUT, out.size)

# ============ 4. 自检图 ============
cw, ch = out.size
sheet = Image.new("RGB", (cw * 3 + 40, ch + 20), (30, 30, 36))
for i, bgc in enumerate([(235, 240, 250), (60, 90, 140), (250, 210, 90)]):
    tile = Image.new("RGB", (cw, ch), bgc)
    tile.paste(out, (0, 0), out)
    sheet.paste(tile, (10 + i * (cw + 10), 10))
sheet.save(CHECK)
print("check ->", CHECK)
