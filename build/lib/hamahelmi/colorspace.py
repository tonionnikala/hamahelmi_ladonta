# -*- coding: utf-8 -*-
"""Väriapufunktiot: hex/RGB-muunnokset ja sRGB -> CIE Lab -muunnos.

Lab-avaruutta käytetään lähimmän palettivärin haussa, koska euklidinen
etäisyys Lab-avaruudessa vastaa paremmin ihmisen kokemaa värien
samankaltaisuutta kuin raaka RGB-etäisyys.
"""

import re

import numpy as np

_HEX_RE = re.compile(r"^#?[0-9a-fA-F]{6}$")


def is_valid_hex(hex_str: str) -> bool:
    return bool(hex_str) and bool(_HEX_RE.match(hex_str))


def hex_to_rgb(hex_str: str):
    if not is_valid_hex(hex_str):
        raise ValueError(f"Virheellinen väriarvo: {hex_str!r} (odotettu esim. #A1B2C3)")
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def rgb_to_hex(r: int, g: int, b: int) -> str:
    for v, name in ((r, "R"), (g, "G"), (b, "B")):
        if not (0 <= int(v) <= 255):
            raise ValueError(f"RGB-arvon {name} pitää olla välillä 0-255 (sai {v})")
    return f"#{int(r):02X}{int(g):02X}{int(b):02X}"


# ------------------------------------------------------------- sRGB -> Lab --
_D65_WHITE = (0.95047, 1.0, 1.08883)

_RGB_TO_XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])


def srgb_array_to_lab(arr: np.ndarray) -> np.ndarray:
    """arr: uint8/float taulukko, muoto (..., 3), arvot 0-255. Palauttaa
    saman muotoisen taulukon CIE L*a*b* -arvoja."""
    c = np.asarray(arr, dtype=np.float64) / 255.0
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = linear @ _RGB_TO_XYZ.T
    xn, yn, zn = _D65_WHITE
    x, y, z = xyz[..., 0] / xn, xyz[..., 1] / yn, xyz[..., 2] / zn

    delta = 6.0 / 29.0

    def f(t):
        return np.where(t > delta ** 3, np.cbrt(t), t / (3 * delta ** 2) + 4.0 / 29.0)

    fx, fy, fz = f(x), f(y), f(z)
    L = 116.0 * fy - 16.0
    a = 500.0 * (fx - fy)
    b = 200.0 * (fy - fz)
    return np.stack([L, a, b], axis=-1)
