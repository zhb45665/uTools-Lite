"""Create the application and tray icon sizes from the approved source art."""

from pathlib import Path
from PIL import Image


root = Path(__file__).resolve().parent
source = Image.open(root / "icon-source.png").convert("RGBA")
for size, name in ((256, "icon.png"), (32, "tray-icon.png")):
    source.resize((size, size), Image.Resampling.LANCZOS).save(root / name)
