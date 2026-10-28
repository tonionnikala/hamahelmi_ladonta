#!/usr/bin/env bash
# Asentaa "hamahelmi"-komennon paikallisesti.
#
# Käyttö:
#   ./install.sh            # asentaa pipx:llä jos saatavilla, muuten venv:iin
#   ./install.sh --venv DIR # pakota tietty venv-hakemisto (oletus: ~/.hamahelmi-venv)
#
# Asennuksen jälkeen komento "hamahelmi" käynnistää web-käyttöliittymän.
# Jos käytit venv-asennusta etkä lisännyt sitä PATH:iin, käynnistä ohjelma
# suoraan: ~/.hamahelmi-venv/bin/hamahelmi

set -euo pipefail
cd "$(dirname "$0")"

VENV_DIR="${HOME}/.hamahelmi-venv"
if [[ "${1:-}" == "--venv" && -n "${2:-}" ]]; then
    VENV_DIR="$2"
fi

if command -v pipx >/dev/null 2>&1; then
    echo "Asennetaan pipx:llä (suositeltu, eristetty ympäristö)..."
    pipx install --force .
    echo
    echo "Valmis. Käynnistä: hamahelmi"
    exit 0
fi

echo "pipx:ää ei löytynyt, luodaan venv hakemistoon: ${VENV_DIR}"
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/pip" install --upgrade pip
"${VENV_DIR}/bin/pip" install .

BIN_DIR="${VENV_DIR}/bin"
echo
echo "Valmis. Käynnistä jommalla kummalla tavalla:"
echo "  1) ${BIN_DIR}/hamahelmi"
echo "  2) Lisää PATH:iin pysyvästi ja käytä pelkkää 'hamahelmi':"
echo "       echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc"
