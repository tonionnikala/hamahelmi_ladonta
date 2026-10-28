# -*- coding: utf-8 -*-
"""Ladontakuvion laskenta valokuvasta. Puhdas funktio, ei riipu Flaskista -
testattavissa/käytettävissä suoraan Pythonista.

Algoritmi:
  1. Rajaa kuva annetulla rajausalueella (kutsuja vastaa rajauksesta -
     tämä moduuli ei enää laske automaattista rajausta, ks. app.js).
  2. Rasteroi käyttäjän poistoalueet (vapaamuotoiset monikulmiot) maskiksi
     ja jätä maskatut pikselit pois keskiarvolaskennasta - siksi kohdan 3
     keskiarvo lasketaan käsin numpy-binnauksella eikä Pillow'n valmiilla
     BOX-suotimella (joka ei osaisi ohittaa yksittäisiä pikseleitä).
  3. Jokaiselle kohderuudulle lasketaan sen alueeseen osuvien, ei-poistettujen
     lähdepikselien keskiarvo. Jos ruudulla ei ole yhtään jäljellä olevaa
     pikseliä (koko ruutu poistettu), ruutu jää tyhjäksi (None) - ei helmeä.
  4. Muunna keskiarvot ja aktiivinen paletti Lab-väriavaruuteen ja etsi
     jokaiselle ei-tyhjälle ruudulle lähin palettiväri (numpy-broadcast,
     ei Python-tason silmukkaa ruutukohtaisesti).
"""

import numpy as np
from PIL import Image, ImageDraw

from . import colorspace


def clamp_crop_box(x: int, y: int, width: int, height: int, img_w: int, img_h: int):
    """Varmistaa että rajausalue mahtuu kuvan sisään; palauttaa
    (x, y, width, height) kokonaislukuina, väh. 1x1."""
    x = max(0, min(int(round(x)), img_w - 1))
    y = max(0, min(int(round(y)), img_h - 1))
    width = max(1, min(int(round(width)), img_w - x))
    height = max(1, min(int(round(height)), img_h - y))
    return x, y, width, height


def _build_keep_mask(img_w, img_h, exclude_polygons):
    """Palauttaa (img_h, img_w) totuusarvoisen numpy-taulukon (True = mukana
    kuviossa) tai None jos poistoalueita ei ole - jälkimmäisessä
    tapauksessa kutsuja voi olettaa kaiken olevan mukana ilman että
    kokonaista kuvan kokoista taulukkoa tarvitsee edes rakentaa."""
    if not exclude_polygons:
        return None
    mask_img = Image.new("L", (img_w, img_h), 255)
    draw = ImageDraw.Draw(mask_img)
    for poly in exclude_polygons:
        if len(poly) >= 3:
            draw.polygon([(float(p[0]), float(p[1])) for p in poly], fill=0)
    return np.asarray(mask_img) > 127


def generate_pattern(image: Image.Image, board_w: int, board_h: int,
                      crop_box, active_colors, exclude_polygons=None):
    """
    image: PIL.Image (alkuperäinen, rajaamaton kuva).
    board_w, board_h: taulun koko helmissä (kokonaislukuja, >= 1).
    crop_box: (x, y, width, height) alkuperäisen kuvan pikselikoordinaateissa.
    active_colors: list[(id, hex)] - aktiivisen paletin värit.
    exclude_polygons: list[list[(x, y)]] tai None - käyttäjän merkitsemät
      poistoalueet alkuperäisen kuvan pikselikoordinaateissa.

    Palauttaa list[list[str | None]] (rivi-järjestys); None tarkoittaa
    tyhjää helmipaikkaa (koko ruutu poistoalueen peitossa).
    """
    if board_w < 1 or board_h < 1:
        raise ValueError("Taulun koon pitää olla vähintään 1x1")
    if not active_colors:
        raise ValueError("Valitse vähintään yksi väri paletista")

    img = image.convert("RGB")
    x, y, w, h = clamp_crop_box(*crop_box, img_w=img.width, img_h=img.height)
    cropped = img.crop((x, y, x + w, y + h))
    pixels = np.asarray(cropped, dtype=np.float64)  # (h, w, 3)

    keep_full = _build_keep_mask(img.width, img.height, exclude_polygons)
    keep = keep_full[y:y + h, x:x + w] if keep_full is not None else np.ones((h, w), dtype=bool)

    row_bin = np.minimum((np.arange(h) * board_h) // h, board_h - 1)
    col_bin = np.minimum((np.arange(w) * board_w) // w, board_w - 1)
    cell_idx = row_bin[:, None] * board_w + col_bin[None, :]  # (h, w)

    keep_flat = keep.reshape(-1)
    idx_flat = cell_idx.reshape(-1)[keep_flat]
    n_cells = board_h * board_w

    counts = np.bincount(idx_flat, minlength=n_cells).astype(np.float64)
    sums = np.zeros((n_cells, 3), dtype=np.float64)
    for c in range(3):
        channel_flat = pixels[:, :, c].reshape(-1)[keep_flat]
        sums[:, c] = np.bincount(idx_flat, weights=channel_flat, minlength=n_cells)

    has_pixels = counts > 0
    means = np.zeros((n_cells, 3), dtype=np.float64)
    means[has_pixels] = sums[has_pixels] / counts[has_pixels, None]
    means_lab = colorspace.srgb_array_to_lab(means)

    palette_hex = [hex_ for _id, hex_ in active_colors]
    palette_rgb = np.array([colorspace.hex_to_rgb(hex_) for hex_ in palette_hex],
                            dtype=np.float64)
    palette_lab = colorspace.srgb_array_to_lab(palette_rgb)

    diffs = means_lab[:, None, :] - palette_lab[None, :, :]
    dist2 = np.sum(diffs ** 2, axis=-1)  # (n_cells, P)
    nearest_idx = np.argmin(dist2, axis=-1)  # (n_cells,)

    grid = []
    for row in range(board_h):
        grid_row = []
        for col in range(board_w):
            idx = row * board_w + col
            grid_row.append(palette_hex[nearest_idx[idx]] if has_pixels[idx] else None)
        grid.append(grid_row)
    return grid
