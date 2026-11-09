"""生成 Windows 桌面图标：python scripts/make-icons.py
（需要 Pillow；用项目里的 Electron 渲染 SVG）

桌面：build/icon.ico、resources/icon.ico / icon.png / tray*.png、src/renderer/public/icon.png、docs/images/icon.png
图形定义在 scripts/icons/lava.py
"""
import json
import os
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'icons'))
import lava  # noqa: E402

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def render(tmp, jobs):
    """jobs: [(svg 文本, 输出文件, 尺寸)]"""
    spec = []
    for i, (text, out, size) in enumerate(jobs):
        p = os.path.join(tmp, f'{i}.svg')
        open(p, 'w', encoding='utf-8').write(text)
        spec.append({'svg': p, 'out': out, 'size': size})
    jp = os.path.join(tmp, 'jobs.json')
    json.dump(spec, open(jp, 'w'))
    subprocess.run(['npx', 'electron', os.path.join(ROOT, 'scripts', 'icons', 'render.cjs'), jp], cwd=ROOT, shell=True, check=True)


def main():
    full = lava.icon()
    small = lava.icon(small=True)
    with tempfile.TemporaryDirectory() as tmp:
        t = lambda name: os.path.join(tmp, name)  # noqa: E731
        jobs = [(full, t('1024.png'), 1024)]
        jobs += [(small if s <= 32 else full, t(f'ico-{s}.png'), s) for s in ICO_SIZES]
        render(tmp, jobs)

        big = Image.open(t('1024.png')).convert('RGBA')
        for p in ['resources/icon.png', 'src/renderer/public/icon.png', 'docs/images/icon.png']:
            big.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, p))
        frames = [Image.open(t(f'ico-{s}.png')).convert('RGBA') for s in ICO_SIZES]
        for p in ['build/icon.ico', 'resources/icon.ico']:
            frames[-1].save(os.path.join(ROOT, p), sizes=[(s, s) for s in ICO_SIZES], append_images=frames[:-1])
        for name, s in [('tray.png', 16), ('tray@1.25x.png', 20), ('tray@1.5x.png', 24), ('tray@2x.png', 32)]:
            Image.open(t(f'ico-{s}.png')).save(os.path.join(ROOT, 'resources', name))

    print('icons ok')


if __name__ == '__main__':
    main()
