"""Link-preview image and icons: public/og.png (1200x630), public/apple-touch-icon.png, public/favicon.svg.

Run: .venv/bin/python -I scripts/icons.py   (needs npm install for the fonts)
The kiss is Noto Emoji (Apache 2.0); fonts are the game's own Bricolage Grotesque and Inter (OFL).
"""
import io
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC, CACHE = ROOT / "public", ROOT / "data/raw/noto"
NOTO = "https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D"
ROSE = (224, 36, 94)  # --rose in index.html


def fetch(path):
    f = CACHE / Path(path).name
    if not f.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        f.write_bytes(urllib.request.urlopen(f"{NOTO}/{path}", timeout=30).read())
    return f


def font(package, file, size, weight):
    ttf = io.BytesIO()
    TTFont(ROOT / f"node_modules/@fontsource-variable/{package}/files/{file}").save(ttf)  # woff2 → ttf
    f = ImageFont.truetype(io.BytesIO(ttf.getvalue()), size)
    f.set_variation_by_axes([weight])
    return f


def main():
    kiss = Image.open(fetch("png/512/emoji_u1f48b.png")).convert("RGBA")
    (PUBLIC / "favicon.svg").write_bytes(fetch("svg/emoji_u1f48b.svg").read_bytes())

    icon = Image.new("RGB", (180, 180), "white")  # red lips vanish on the rose; white keeps them crisp
    icon.paste(k := kiss.resize((136, 136), Image.LANCZOS), (22, 22), k)
    icon.save(PUBLIC / "apple-touch-icon.png")

    og = Image.new("RGB", (1200, 630), ROSE)
    d = ImageDraw.Draw(og)
    title = font("bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2", 104, 800)
    body = font("inter", "inter-latin-wght-normal.woff2", 36, 500)
    pill = font("bricolage-grotesque", "bricolage-grotesque-latin-wght-normal.woff2", 36, 800)
    d.text((80, 120), "Sex and", font=title, fill="white")
    d.text((80, 232), "the City", font=title, fill="white")
    for k, line in enumerate(["Create the most irresistible character.", "A town of 1,000 people decides."]):
        d.text((84, 380 + k * 48), line, font=body, fill=(255, 235, 242))
    label = "Climb the leaderboard"
    w = d.textlength(label, font=pill)
    d.rounded_rectangle((80, 498, 80 + w + 64, 568), radius=35, fill="white")
    d.text((112, 512), label, font=pill, fill=(194, 24, 91))
    d.ellipse((790, 135, 1150, 495), fill="white")
    og.paste(k := kiss.resize((270, 270), Image.LANCZOS), (835, 180), k)
    og.save(PUBLIC / "og.png", optimize=True)
    print("wrote public/og.png, public/apple-touch-icon.png, public/favicon.svg")


if __name__ == "__main__":
    main()
