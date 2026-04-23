from PIL import Image

SRC = "apple-touch-icon.png"
OUT = "apple-touch-icon.png"
SIZE = 180
BG_COLOR = (17, 17, 17)  # #111111

src = Image.open(SRC).convert("RGBA")

icon_size = int(SIZE * 0.6)  # 108px
src = src.resize((icon_size, icon_size), Image.LANCZOS)

bg = Image.new("RGBA", (SIZE, SIZE), BG_COLOR + (255,))
offset = (SIZE - icon_size) // 2
bg.paste(src, (offset, offset), src)

bg.convert("RGB").save(OUT, "PNG")
print(f"Saved {OUT} ({SIZE}x{SIZE}px, icon at {icon_size}px centered)")
