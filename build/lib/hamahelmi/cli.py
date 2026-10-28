# -*- coding: utf-8 -*-
"""
Komentorivikäynnistin. Asennuksen jälkeen ohjelma käynnistetään komennolla:

    hamahelmi [--host HOST] [--port PORT] [--no-browser]

Käynnistää paikallisen web-käyttöliittymän ja avaa oletusselaimen
automaattisesti (ellei --no-browser ole annettu).
"""

import argparse
import sys
import threading
import time
import webbrowser


def build_arg_parser():
    p = argparse.ArgumentParser(
        prog="hamahelmi",
        description="Hamahelmi-ladontakuvion suunnittelu valokuvasta.",
    )
    p.add_argument("--host", default="127.0.0.1",
                    help="Osoite jota palvelin kuuntelee (oletus: 127.0.0.1, "
                         "vain tämä kone). Käytä 0.0.0.0 jakaaksesi verkossa.")
    p.add_argument("--port", type=int, default=5000, help="Portti (oletus: 5000)")
    p.add_argument("--no-browser", action="store_true",
                    help="Älä avaa selainta automaattisesti")
    p.add_argument("--debug", action="store_true", help="Flaskin debug-tila (kehitykseen)")
    return p


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    try:
        from .app import app
    except ImportError as e:  # puuttuvat riippuvuudet, esim. flask/pillow/numpy
        print(f"Virhe: käynnistys epäonnistui puuttuvan riippuvuuden vuoksi: {e}",
              file=sys.stderr)
        print("Asenna riippuvuudet: pip install flask pillow numpy", file=sys.stderr)
        return 1

    url = f"http://{args.host}:{args.port}"
    print(f"Hamahelmi-suunnittelija käynnistyy osoitteessa {url}")
    print("Pysäytä palvelin painamalla Ctrl+C.")

    if not args.no_browser:
        def _open_browser():
            time.sleep(1.0)
            try:
                webbrowser.open(url)
            except Exception:
                pass
        threading.Thread(target=_open_browser, daemon=True).start()

    try:
        app.run(host=args.host, port=args.port, debug=args.debug)
    except KeyboardInterrupt:
        print("\nPysäytetty.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
