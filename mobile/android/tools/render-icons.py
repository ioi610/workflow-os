"""Resize the shared product icon for Android launchers and legacy splashes."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
RES = ROOT / 'mobile/android/app/src/main/res'
SOURCE = Image.open(ROOT / 'desktop/assets/icon.png').convert('RGBA')
GREEN = '#184d3d'
PAPER = '#f5f4ef'

for density, factor in [('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)]:
    directory = RES / f'mipmap-{density}'
    directory.mkdir(parents=True, exist_ok=True)
    size = round(48 * factor)
    icon = SOURCE.resize((size, size), Image.Resampling.LANCZOS)
    icon.save(directory / 'ic_launcher.png', optimize=True)

    round_icon = Image.new('RGBA', (size, size), GREEN)
    round_icon.alpha_composite(icon)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size-1, size-1), fill=255)
    round_icon.putalpha(mask)
    round_icon.save(directory / 'ic_launcher_round.png', optimize=True)

    # 108 dp adaptive canvas; the logo's marks remain inside the safe area.
    adaptive_size = round(108 * factor)
    foreground = Image.new('RGBA', (adaptive_size, adaptive_size), (0, 0, 0, 0))
    logo_size = round(72 * factor)
    logo = SOURCE.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    inset = (adaptive_size-logo_size)//2
    foreground.alpha_composite(logo, (inset, inset))
    foreground.save(directory / 'ic_launcher_foreground.png', optimize=True)

for splash in RES.glob('*/splash.png'):
    previous = Image.open(splash)
    width, height = previous.size
    factor = next((factor for density, factor in [('xxxhdpi', 4), ('xxhdpi', 3), ('xhdpi', 2), ('hdpi', 1.5), ('mdpi', 1)] if density in splash.parent.name), 1)
    image = Image.new('RGBA', (width, height), PAPER)
    logo_size = min(round(112*factor), round(min(width, height)*.35))
    logo = SOURCE.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    image.alpha_composite(logo, ((width-logo_size)//2, (height-logo_size)//2))
    image.convert('RGB').save(splash, optimize=True)

print('Generated five launcher densities, adaptive foregrounds, round icons and branded splashes.')
