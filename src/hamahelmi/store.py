# -*- coding: utf-8 -*-
"""Palvelimen muistissa pidettävä tila. Yksinkertainen yhden käyttäjän
työkalu -> ei tietokantaa, ei sessioita, ei kirjautumista.

Tila tallennetaan levylle ~/.hamahelmi/ hakemistoon niin että se säilyy
palvelimen uudelleenkäynnistysten yli: paletti/taulu/rajaus/poistoalueet/
ruudukko JSON-tiedostona (tila.json) ja alkuperäinen kuva erillisenä PNG-
tiedostona (original.png, ladattu muoto aina normalisoitu PNG:ksi
lataushetkellä, ks. app.py:n /api/upload)."""

import re
import time
from pathlib import Path

from PIL import Image

from .palette_data import DEFAULT_PALETTE

DATA_DIR = Path.home() / ".hamahelmi"
ORIGINAL_IMAGE_PATH = DATA_DIR / "original.png"
DEFAULT_STATE_PATH = DATA_DIR / "tila.json"

DEFAULT_BOARD = {"width": 20, "height": 20}


def _default_palette():
    return [{**c, "active": True} for c in DEFAULT_PALETTE]


STATE = {
    "has_image": False,
    "image_size": None,   # {"width": int, "height": int} tai None
    "board": dict(DEFAULT_BOARD),
    "crop": None,          # {"x","y","width","height"} alkuper. kuvan pikseleissä, tai None
    "exclude": [],          # list[list[[x, y], ...]] - poistoalueiden monikulmiot alkuper. kuvan pikseleissä
    "palette": _default_palette(),
    "grid": None,             # list[list[hex | None]] tai None - None-ruutu on tyhjä helmipaikka
    "hidden_colors": [],       # list[hex] - "Käytetyt värit" -listasta piilotetut värit (palautettavissa,
                                # ei muokkaa ruudukkoa - vain näkymä/laskenta ohittaa nämä värit)
    "last_saved_at": None,
    "last_save_path": None,
}


# ------------------------------------------------------------------- kuva --
def set_original_image(pil_image: Image.Image):
    """Tallentaa uuden alkuperäiskuvan PNG:nä. Nollaa rajauksen ja
    ruudukon, koska ne koskivat edellistä kuvaa."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    rgb = pil_image.convert("RGB")

    max_side = 1600
    if max(rgb.width, rgb.height) > max_side:
        scale = max_side / max(rgb.width, rgb.height)
        rgb = rgb.resize((max(1, round(rgb.width * scale)),
                          max(1, round(rgb.height * scale))), Image.Resampling.LANCZOS)

    rgb.save(ORIGINAL_IMAGE_PATH, format="PNG")
    STATE["has_image"] = True
    STATE["image_size"] = {"width": rgb.width, "height": rgb.height}
    STATE["crop"] = None
    STATE["exclude"] = []
    STATE["grid"] = None


def load_original_image() -> Image.Image:
    return Image.open(ORIGINAL_IMAGE_PATH)


def clear_image():
    if ORIGINAL_IMAGE_PATH.exists():
        ORIGINAL_IMAGE_PATH.unlink()
    STATE["has_image"] = False
    STATE["image_size"] = None
    STATE["crop"] = None
    STATE["exclude"] = []
    STATE["grid"] = None


def try_autoload_image():
    """Yrittää lukea kuvan koon levyltä käynnistyksessä. Ei kaada
    käynnistystä jos tiedosto puuttuu tai on viallinen."""
    if not ORIGINAL_IMAGE_PATH.exists():
        STATE["has_image"] = False
        STATE["image_size"] = None
        return
    try:
        with Image.open(ORIGINAL_IMAGE_PATH) as img:
            STATE["has_image"] = True
            STATE["image_size"] = {"width": img.width, "height": img.height}
    except Exception:
        STATE["has_image"] = False
        STATE["image_size"] = None


# --------------------------------------------------------------- paletti --
_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(name: str) -> str:
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "vari"


def color_by_id(color_id):
    for c in STATE["palette"]:
        if c["id"] == color_id:
            return c
    return None


def add_color(name: str, hex_value: str) -> dict:
    base = _slugify(name)
    existing_ids = {c["id"] for c in STATE["palette"]}
    color_id = base
    n = 2
    while color_id in existing_ids:
        color_id = f"{base}-{n}"
        n += 1
    color = {"id": color_id, "name": name, "hex": hex_value.upper(), "active": True}
    STATE["palette"].append(color)
    return color


def active_colors():
    """list[(id, hex)] aktiivisista paletin väreistä, järjestyksessä."""
    return [(c["id"], c["hex"]) for c in STATE["palette"] if c["active"]]


def set_color_hidden(hex_value: str, hidden: bool):
    """Piilottaa/palauttaa värin "Käytetyt värit" -näkymässä. Ei koske
    ruudukkoa lainkaan - siksi palautus (piilotuksen kumoaminen) on aina
    mahdollista eikä vaadi kuvion uudelleengenerointia."""
    hex_value = hex_value.upper()
    if hidden:
        if hex_value not in STATE["hidden_colors"]:
            STATE["hidden_colors"].append(hex_value)
    else:
        STATE["hidden_colors"] = [h for h in STATE["hidden_colors"] if h != hex_value]


# -------------------------------------------------------------- ruudukko --
def board_aspect_crop_box():
    """Oletusrajaus: kuvan keskitetty alue joka vastaa taulun
    kuvasuhdetta ('cover'-rajaus). Palauttaa None jos kuvaa ei ole."""
    if not STATE["has_image"] or not STATE["image_size"]:
        return None
    img_w, img_h = STATE["image_size"]["width"], STATE["image_size"]["height"]
    board_w, board_h = STATE["board"]["width"], STATE["board"]["height"]
    target_ratio = board_w / board_h
    img_ratio = img_w / img_h
    if img_ratio > target_ratio:
        crop_h = img_h
        crop_w = round(crop_h * target_ratio)
    else:
        crop_w = img_w
        crop_h = round(crop_w / target_ratio)
    x = (img_w - crop_w) // 2
    y = (img_h - crop_h) // 2
    return {"x": x, "y": y, "width": crop_w, "height": crop_h}


# ------------------------------------------------------------------ reset --
def reset_all():
    clear_image()
    STATE["board"] = dict(DEFAULT_BOARD)
    STATE["palette"] = _default_palette()
    STATE["grid"] = None
    STATE["crop"] = None
    STATE["exclude"] = []
    STATE["hidden_colors"] = []


# ---------------------------------------------------------------- levytys --
def to_json_dict() -> dict:
    return {
        "version": 1,
        "board": dict(STATE["board"]),
        "crop": dict(STATE["crop"]) if STATE["crop"] else None,
        "exclude": [[list(pt) for pt in poly] for poly in STATE["exclude"]],
        "palette": [dict(c) for c in STATE["palette"]],
        "grid": [list(row) for row in STATE["grid"]] if STATE["grid"] else None,
        "hidden_colors": list(STATE["hidden_colors"]),
    }


def load_from_json_dict(d: dict):
    STATE["board"] = {
        "width": int(d.get("board", DEFAULT_BOARD)["width"]),
        "height": int(d.get("board", DEFAULT_BOARD)["height"]),
    }
    crop = d.get("crop")
    STATE["crop"] = dict(crop) if crop else None
    exclude = d.get("exclude") or []
    STATE["exclude"] = [[list(pt) for pt in poly] for poly in exclude]
    palette = d.get("palette")
    STATE["palette"] = [dict(c) for c in palette] if palette else _default_palette()
    grid = d.get("grid")
    STATE["grid"] = [list(row) for row in grid] if grid else None
    STATE["hidden_colors"] = [str(h).upper() for h in (d.get("hidden_colors") or [])]


def save_to_file(path=None):
    import json
    path = Path(path) if path else DEFAULT_STATE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(to_json_dict(), f, ensure_ascii=False, indent=2)
    tmp.replace(path)
    STATE["last_saved_at"] = time.time()
    STATE["last_save_path"] = str(path)
    return path


def load_from_file(path=None):
    import json
    path = Path(path) if path else DEFAULT_STATE_PATH
    with open(path, "r", encoding="utf-8") as f:
        d = json.load(f)
    load_from_json_dict(d)
    STATE["last_save_path"] = str(path)
    return path


def try_autoload(path=None):
    """Yrittää ladata oletustiedoston jos se on olemassa. Ei kaada
    käynnistystä jos tiedosto puuttuu tai on viallinen."""
    path = Path(path) if path else DEFAULT_STATE_PATH
    if not path.exists():
        return False
    try:
        load_from_file(path)
        return True
    except Exception:
        return False
