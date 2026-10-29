"""Regenerate the project-owned desktop icon; requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

size = 1024
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((32, 32, 992, 992), radius=224, fill="#164c3a")
draw.rounded_rectangle((74, 74, 950, 950), radius=190, outline="#327d60", width=5)
draw.line([(352, 330), (704, 330), (704, 692), (352, 692)], fill="#d8b36c", width=42, joint="curve")
draw.polygon([(331, 692), (397, 646), (397, 738)], fill="#d8b36c")
for box in [(210, 214, 474, 446), (566, 214, 830, 446), (210, 576, 474, 808), (566, 576, 830, 808)]:
    draw.rounded_rectangle(box, radius=56, fill="#f4f5eb")
    cx = (box[0] + box[2]) // 2
    cy = (box[1] + box[3]) // 2
    draw.line([(cx - 42, cy), (cx - 8, cy + 32), (cx + 46, cy - 32)], fill="#327d60", width=20, joint="curve")
destination = Path(__file__).resolve().parents[1] / "desktop" / "assets" / "icon.png"
destination.parent.mkdir(parents=True, exist_ok=True)
image.save(destination, optimize=True)
print(destination)
