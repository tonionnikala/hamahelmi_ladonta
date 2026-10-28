# -*- coding: utf-8 -*-
"""
Hamahelmi-ladontakuvion suunnittelu - käyttöliittymä.

Yksinkertainen paikallinen web-käyttöliittymä kuvankäsittelyytimen
(quantize.py) päälle. Käynnistys komennolla "hamahelmi", ks. cli.py.

Käyttöliittymä ja kuvionlaskenta on pidetty tarkoituksella erillään: tämä
tiedosto ei sisällä kvantisointilogiikkaa, vain pyyntöjen käsittelyä ja
tulosten muotoilua JSON:ksi.
"""

import io

from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image

from . import colorspace, quantize, store, wiki_colors

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 Mt

store.try_autoload()
store.try_autoload_image()


@app.after_request
def _autosave(response):
    """Tallentaa tilan levylle automaattisesti aina kun jotain muutetaan."""
    if (request.method in ("POST", "DELETE", "PATCH")
            and request.path.startswith("/api/")
            and response.status_code < 400):
        try:
            store.save_to_file()
        except Exception:
            pass
    return response


@app.errorhandler(413)
def _too_large(_e):
    return jsonify({"error": "Tiedosto on liian suuri (enintään 20 Mt)"}), 413


# ---------------------------------------------------------------- helpers --
def _normalize_hex(hex_value):
    if not hex_value or not colorspace.is_valid_hex(hex_value):
        return None
    return f"#{hex_value.lstrip('#').upper()}"


def _resolve_hex(body):
    """Hyväksyy värin joko valmiina hex-merkkijonona tai RGB-kentistä
    (r, g, b, kukin 0-255) - kumpikin syöttötapa on tuettu paletin
    muokkauksessa."""
    if body.get("hex"):
        return _normalize_hex(body["hex"])
    if all(k in body and body[k] is not None for k in ("r", "g", "b")):
        try:
            return colorspace.rgb_to_hex(body["r"], body["g"], body["b"])
        except (ValueError, TypeError):
            return None
    return None


MAX_EXCLUDE_POLYGONS = 30
MAX_POLYGON_POINTS = 400


def _parse_exclude(raw):
    """Jäsentää ja validoi poistoalueet pyynnön rungosta: lista
    monikulmioita, kukin lista [x, y] -pisteitä (alkuper. kuvan
    pikselikoordinaateissa). Palauttaa (polygons, error_message);
    polygons on list[list[(x, y)]] jos error_message on None."""
    if raw is None:
        return [], None
    if not isinstance(raw, list) or len(raw) > MAX_EXCLUDE_POLYGONS:
        return None, "Virheellinen poistoalueiden lista"
    polygons = []
    for poly in raw:
        if not isinstance(poly, list) or not (3 <= len(poly) <= MAX_POLYGON_POINTS):
            return None, "Virheellinen poistoalueen muoto"
        pts = []
        for pt in poly:
            if not (isinstance(pt, list) and len(pt) == 2):
                return None, "Virheellinen poistoalueen piste"
            try:
                pts.append((float(pt[0]), float(pt[1])))
            except (TypeError, ValueError):
                return None, "Virheellinen poistoalueen piste"
        polygons.append(pts)
    return polygons, None


# ------------------------------------------------------------------ pages --
@app.route("/")
def index():
    return render_template("index.html")


# ------------------------------------------------------------------- state -
@app.route("/api/state")
def api_state():
    return jsonify({
        "has_image": store.STATE["has_image"],
        "image_size": store.STATE["image_size"],
        "board": store.STATE["board"],
        "crop": store.STATE["crop"],
        "exclude": store.STATE["exclude"],
        "palette": store.STATE["palette"],
        "grid": store.STATE["grid"],
        "hidden_colors": store.STATE["hidden_colors"],
        "last_saved_at": store.STATE["last_saved_at"],
        "last_save_path": store.STATE["last_save_path"],
    })


@app.route("/api/reset", methods=["POST"])
def api_reset():
    store.reset_all()
    return jsonify({"ok": True})


# -------------------------------------------------------------------- kuva -
@app.route("/api/upload", methods=["POST"])
def api_upload():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify({"error": "Tiedosto puuttuu"}), 400
    data = file.read()
    try:
        check = Image.open(io.BytesIO(data))
        check.verify()
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return jsonify({
            "error": "Tiedostoa ei voitu lukea kuvana. Tuetut muodot: "
                     "JPEG, PNG, WebP, BMP, GIF, TIFF.",
        }), 400
    store.set_original_image(img)
    return jsonify({"ok": True, "image_size": store.STATE["image_size"]})


@app.route("/api/original.png")
def api_original_image():
    if not store.STATE["has_image"] or not store.ORIGINAL_IMAGE_PATH.exists():
        return jsonify({"error": "Ei kuvaa"}), 404
    return send_file(store.ORIGINAL_IMAGE_PATH, mimetype="image/png")


# ---------------------------------------------------------------- kuvion --
@app.route("/api/generate", methods=["POST"])
def api_generate():
    if not store.STATE["has_image"]:
        return jsonify({"error": "Lataa ensin kuva"}), 400

    body = request.get_json(force=True)
    try:
        width = int(body["width"])
        height = int(body["height"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Virheellinen taulun koko"}), 400
    if not (1 <= width <= 300 and 1 <= height <= 300):
        return jsonify({"error": "Taulun koon pitää olla 1-300 helmeä"}), 400

    store.STATE["board"] = {"width": width, "height": height}

    crop_in = body.get("crop")
    if crop_in:
        try:
            crop_box = (float(crop_in["x"]), float(crop_in["y"]),
                        float(crop_in["width"]), float(crop_in["height"]))
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "Virheellinen rajausalue"}), 400
    else:
        default = store.board_aspect_crop_box()
        crop_box = (default["x"], default["y"], default["width"], default["height"])

    exclude_polygons, exclude_error = _parse_exclude(body.get("exclude"))
    if exclude_error:
        return jsonify({"error": exclude_error}), 400

    active = store.active_colors()
    try:
        image = store.load_original_image()
        grid = quantize.generate_pattern(image, width, height, crop_box, active,
                                          exclude_polygons=exclude_polygons)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    img_w = store.STATE["image_size"]["width"]
    img_h = store.STATE["image_size"]["height"]
    cx, cy, cw, ch = quantize.clamp_crop_box(*crop_box, img_w=img_w, img_h=img_h)
    store.STATE["crop"] = {"x": cx, "y": cy, "width": cw, "height": ch}
    store.STATE["exclude"] = [[list(pt) for pt in poly] for poly in exclude_polygons]
    store.STATE["grid"] = grid

    return jsonify({"ok": True, "board": store.STATE["board"], "crop": store.STATE["crop"],
                     "exclude": store.STATE["exclude"], "grid": grid})


@app.route("/api/recolor", methods=["POST"])
def api_recolor():
    """Korvaa kaikki `from_hex`-väriset ruudut `to_hex`-värillä koko
    kuviossa. `to_hex: null` tyhjentää ruudut (None) sen sijaan että ne
    värjättäisiin uudelleen - pysyvä muutos ruudukkoon (ei sekoiteta
    "Käytetyt värit" -listan palautettavaan piilotukseen, ks.
    /api/hide_color)."""
    if store.STATE["grid"] is None:
        return jsonify({"error": "Ei kuviota - luo kuvio ensin"}), 400
    body = request.get_json(force=True)
    from_hex = _normalize_hex(body.get("from_hex"))
    if not from_hex:
        return jsonify({"error": "Virheellinen väriarvo"}), 400

    to_raw = body.get("to_hex")
    if to_raw is None:
        to_hex = None
    else:
        to_hex = _normalize_hex(to_raw)
        if not to_hex:
            return jsonify({"error": "Virheellinen väriarvo"}), 400

    changed = 0
    grid = store.STATE["grid"]
    for row in grid:
        for i, hex_ in enumerate(row):
            if hex_ and hex_.upper() == from_hex:
                row[i] = to_hex
                changed += 1

    return jsonify({"ok": True, "changed": changed, "grid": grid})


@app.route("/api/cell", methods=["POST"])
def api_cell():
    if store.STATE["grid"] is None:
        return jsonify({"error": "Ei kuviota - luo kuvio ensin"}), 400
    body = request.get_json(force=True)
    try:
        row = int(body["row"])
        col = int(body["col"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "Virheelliset ruudun koordinaatit"}), 400

    grid = store.STATE["grid"]
    if not (0 <= row < len(grid) and 0 <= col < len(grid[0])):
        return jsonify({"error": "Ruutu on taulun ulkopuolella"}), 400

    raw_hex = body.get("hex")
    if raw_hex is None:
        grid[row][col] = None
    else:
        hex_value = _normalize_hex(raw_hex)
        if not hex_value:
            return jsonify({"error": "Virheellinen väriarvo"}), 400
        grid[row][col] = hex_value
    return jsonify({"ok": True})


@app.route("/api/hide_color", methods=["POST"])
def api_hide_color():
    """Piilottaa/palauttaa värin "Käytetyt värit" -näkymässä. Ei koske
    ruudukkoa - täysin palautettavissa, ei vaadi kuvion uudelleengenerointia."""
    body = request.get_json(force=True)
    hex_value = _normalize_hex(body.get("hex"))
    if not hex_value:
        return jsonify({"error": "Virheellinen väriarvo"}), 400
    hidden = bool(body.get("hidden", True))
    store.set_color_hidden(hex_value, hidden)
    return jsonify({"ok": True, "hidden_colors": store.STATE["hidden_colors"]})


# --------------------------------------------------------------- paletti --
@app.route("/api/palette")
def api_palette():
    return jsonify({"colors": store.STATE["palette"]})


@app.route("/api/wiki_colors")
def api_wiki_colors():
    """Nimettyjen värien hakemisto (Wikipedia) - kiinteä viitedata, ei
    STATE:n osa eikä käyttäjän muokattavissa."""
    return jsonify({"colors": wiki_colors.WIKI_COLORS})


@app.route("/api/palette/colors", methods=["POST"])
def api_add_color():
    body = request.get_json(force=True)
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Värin nimi puuttuu"}), 400
    hex_value = _resolve_hex(body)
    if not hex_value:
        return jsonify({"error": "Anna väri joko hex-arvona tai RGB-kentillä (0-255)"}), 400
    color = store.add_color(name, hex_value)
    return jsonify({"ok": True, "color": color})


@app.route("/api/palette/colors/<color_id>", methods=["PATCH"])
def api_update_color(color_id):
    color = store.color_by_id(color_id)
    if not color:
        return jsonify({"error": "Tuntematon väri"}), 404
    body = request.get_json(force=True)
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Värin nimi ei voi olla tyhjä"}), 400
        color["name"] = name
    if body.get("hex") or all(k in body and body[k] is not None for k in ("r", "g", "b")):
        hex_value = _resolve_hex(body)
        if not hex_value:
            return jsonify({"error": "Virheellinen väriarvo"}), 400
        color["hex"] = hex_value
    if "active" in body:
        color["active"] = bool(body["active"])
    return jsonify({"ok": True, "color": color})


@app.route("/api/palette/colors/<color_id>", methods=["DELETE"])
def api_delete_color(color_id):
    store.STATE["palette"] = [c for c in store.STATE["palette"] if c["id"] != color_id]
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
