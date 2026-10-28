'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

let STATE = null;
let cropImg = null;          // {x, y, width, height} alkuperäisen kuvan pikseleissä
let excludePolygons = [];    // [[{x,y}, ...], ...] alkuperäisen kuvan pikseleissä
let naturalW = 0, naturalH = 0;

// ------------------------------------------------------------ toast/util --
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (kind === 'err' ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* ei sisältöä */ }
  if (!res.ok) throw new Error(data.error || `Virhe (${res.status})`);
  return data;
}

function postJSON(path, body, method = 'POST') {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postForm(path, formEl) {
  const fd = new FormData(formEl);
  return api(path, { method: 'POST', body: fd });
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// -------------------------------------------------------------- refresh --
async function refreshState() {
  STATE = await api('/api/state');
  cropImg = STATE.crop;
  excludePolygons = (STATE.exclude || []).map(poly => poly.map(pt => ({ x: pt[0], y: pt[1] })));
  renderPhoto();
  renderPaletteList();
  renderRecolorSelects();
  renderCanvas();
  renderLegend();
  renderSaveStatus();
}

function renderSaveStatus() {
  const el = $('#save-status');
  if (!STATE.last_saved_at) {
    el.textContent = 'Ei vielä tallennettu levylle';
    el.className = 'save-status pending';
    return;
  }
  const secondsAgo = Math.max(0, Math.round(Date.now() / 1000 - STATE.last_saved_at));
  let when;
  if (secondsAgo < 5) when = 'juuri nyt';
  else if (secondsAgo < 60) when = `${secondsAgo} s sitten`;
  else if (secondsAgo < 3600) when = `${Math.round(secondsAgo / 60)} min sitten`;
  else when = `${Math.round(secondsAgo / 3600)} h sitten`;
  el.textContent = `Tallennettu ${when}`;
  el.className = 'save-status saved';
  el.title = `Tallennuspolku: ${STATE.last_save_path || ''}`;
}

// =================================================================== KUVA =
const photoFrame = $('#photo-frame');
const photoImg = $('#photo-img');
const cropBoxEl = $('#crop-box');

function renderPhoto() {
  if (!STATE.has_image) {
    photoImg.style.display = 'none';
    cropBoxEl.style.display = 'none';
    $('#photo-empty').style.display = 'block';
    $('#crop-hint').style.display = 'none';
    $('#btn-reset-crop').style.display = 'none';
    $('#tool-mode-row').style.display = 'none';
    $('#erase-hint').style.display = 'none';
    $('#erase-actions').style.display = 'none';
    setToolMode('crop');
    return;
  }
  $('#photo-empty').style.display = 'none';
  $('#tool-mode-row').style.display = 'flex';
  setToolMode('crop');
  naturalW = STATE.image_size.width;
  naturalH = STATE.image_size.height;
  const src = `/api/original.png?t=${Date.now()}`;
  photoImg.onload = () => {
    photoImg.style.display = 'block';
    cropBoxEl.style.display = 'block';
    if (!cropImg) {
      cropImg = { x: 0, y: 0, width: naturalW, height: naturalH };
      syncBoardToCrop();
    }
    renderCropBox();
    renderExcludeOverlay();
  };
  photoImg.src = src;
}

function boardWidth() { return Math.max(1, Math.min(300, parseInt($('#board-width').value, 10) || 20)); }
function boardHeight() { return Math.max(1, Math.min(300, parseInt($('#board-height').value, 10) || 20)); }

// Palauttaa kentän arvon positiivisena kokonaislukuna, tai null jos kenttä
// on parhaillaan tyhjä/virheellinen (esim. käyttäjä on juuri tyhjentänyt
// sen kirjoittaakseen uuden luvun) - EI koskaan oletusarvoa 20 kuten
// boardWidth()/boardHeight(), koska niiden fallback on tarkoitettu vain
// lopulliseen (kuvion generointi) lukemiseen, ei muokkauksen aikaiseen
// väliaikaistilaan.
function parsedPositiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

function displayScale() { return photoImg.clientWidth / naturalW; }

function renderCropBox() {
  if (!cropImg || !photoImg.clientWidth) return;
  const s = displayScale();
  cropBoxEl.style.left = `${cropImg.x * s}px`;
  cropBoxEl.style.top = `${cropImg.y * s}px`;
  cropBoxEl.style.width = `${cropImg.width * s}px`;
  cropBoxEl.style.height = `${cropImg.height * s}px`;
}

window.addEventListener('resize', () => {
  if (STATE && STATE.has_image) { renderCropBox(); renderExcludeOverlay(); }
});

$('#btn-reset-crop').addEventListener('click', () => {
  if (!STATE.has_image) return;
  cropImg = { x: 0, y: 0, width: naturalW, height: naturalH };
  syncBoardToCrop();
  renderCropBox();
});

// Rajattava alue valitaan vapaasti minkä muotoisena tahansa - pegboardin
// kokosuhde lukitaan SEN JÄLKEEN vastaamaan valittua rajausta (ei toisin
// päin), jotta kuvio ei koskaan pääse vääristymään venymällä. Leveys-kenttä
// on "ankkuri": korkeus lasketaan aina siitä ja rajauksen kuvasuhteesta.
// Nämä kaksi funktiota lukevat/kirjoittavat molempia kenttiä (myös
// ankkuria itseään, jos raja-arvot pakottavat sen korjaamaan) - siksi
// niitä käytetään vain muokkauksen PÄÄTYTTYÄ ('change'), ei jokaisella
// näppäimenpainalluksella, ettei käyttäjän kirjoitusta keskeytettäisi.
function syncBoardToCrop() {
  if (!cropImg) return;
  const ratio = cropImg.width / cropImg.height;
  let w = boardWidth();
  let h = Math.round(w / ratio);
  if (h > 300) { h = 300; w = Math.round(h * ratio); }
  if (h < 1) { h = 1; w = Math.round(h * ratio); }
  w = Math.max(1, Math.min(300, w));
  $('#board-width').value = w;
  $('#board-height').value = h;
}

function syncBoardToCropFromHeight() {
  if (!cropImg) return;
  const ratio = cropImg.width / cropImg.height;
  let h = boardHeight();
  let w = Math.round(h * ratio);
  if (w > 300) { w = 300; h = Math.round(w / ratio); }
  if (w < 1) { w = 1; h = Math.round(w / ratio); }
  h = Math.max(1, Math.min(300, h));
  $('#board-height').value = h;
  $('#board-width').value = w;
}

// Kirjoittamisen AIKANA ('input') päivitetään vain TOINEN kenttä eikä
// koskaan kosketa sitä kenttää jota käyttäjä paraikaa muokkaa - muuten
// esim. kentän tyhjentäminen uuden luvun kirjoittamista varten ylikirjoit­
// tuisi heti takaisin vanhaan arvoon. Virheellinen/tyhjä väliaikaistila
// jätetään rauhaan; raja-arvot (1-300) ja oletusarvo sovelletaan vasta
// kentästä poistuttaessa (change) yllä olevilla funktioilla.
$('#board-width').addEventListener('input', () => {
  if (!cropImg) return;
  const w = parsedPositiveInt($('#board-width').value);
  if (w === null) return;
  const ratio = cropImg.width / cropImg.height;
  $('#board-height').value = Math.max(1, Math.min(300, Math.round(w / ratio)));
});
$('#board-height').addEventListener('input', () => {
  if (!cropImg) return;
  const h = parsedPositiveInt($('#board-height').value);
  if (h === null) return;
  const ratio = cropImg.width / cropImg.height;
  $('#board-width').value = Math.max(1, Math.min(300, Math.round(h * ratio)));
});
$('#board-width').addEventListener('change', syncBoardToCrop);
$('#board-height').addEventListener('change', syncBoardToCropFromHeight);

// ------------------------------------------------ rajaustyökalu (vetäminen) -
// Koordinaatit lasketaan KUVAN, ei kehyksen, rect:in suhteen - kehyksellä voi
// olla reunaviiva/täyte joka siirtäisi origoa muutamalla pikselillä, jolloin
// rajaus osuisi hieman väärään kohtaan kuvassa.
function frameXY(evt) {
  const r = photoImg.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

// Vapaamuotoinen koon/sijainnin rajoitus: pysyy kehyksen sisällä, ei
// kuvasuhdepakkoa - rajauksen muoto saa olla mikä tahansa suorakulmio.
function clampDisplayBox(box) {
  const maxW = photoImg.clientWidth, maxH = photoImg.clientHeight;
  let { left, top, width, height } = box;
  width = Math.max(12, Math.min(width, maxW));
  height = Math.max(12, Math.min(height, maxH));
  left = Math.max(0, Math.min(left, maxW - width));
  top = Math.max(0, Math.min(top, maxH - height));
  return { left, top, width, height };
}

function commitDisplayBox(box) {
  const s = displayScale();
  cropImg = {
    x: Math.round(box.left / s), y: Math.round(box.top / s),
    width: Math.max(1, Math.round(box.width / s)), height: Math.max(1, Math.round(box.height / s)),
  };
  syncBoardToCrop();
}

let dragState = null;
let eraseStroke = null;      // pisteet näyttökoordinaateissa piirron aikana
let eraseMode = false;

function setToolMode(mode) {
  eraseMode = mode === 'erase';
  $('#btn-mode-crop').classList.toggle('active', !eraseMode);
  $('#btn-mode-erase').classList.toggle('active', eraseMode);
  photoFrame.classList.toggle('erase-mode', eraseMode);
  const hasImage = !!(STATE && STATE.has_image);
  $('#crop-hint').style.display = hasImage && !eraseMode ? 'block' : 'none';
  $('#btn-reset-crop').style.display = hasImage && !eraseMode ? 'inline-block' : 'none';
  $('#erase-hint').style.display = hasImage && eraseMode ? 'block' : 'none';
  $('#erase-actions').style.display = hasImage && eraseMode ? 'flex' : 'none';
}
$('#btn-mode-crop').addEventListener('click', () => setToolMode('crop'));
$('#btn-mode-erase').addEventListener('click', () => setToolMode('erase'));

photoFrame.addEventListener('mousedown', evt => {
  if (!STATE || !STATE.has_image) return;
  const start = frameXY(evt);

  if (eraseMode) {
    eraseStroke = [start];
    evt.preventDefault();
    return;
  }

  const target = evt.target;
  if (target.classList.contains('crop-handle')) {
    const handle = target.dataset.handle;
    const box = {
      left: parseFloat(cropBoxEl.style.left), top: parseFloat(cropBoxEl.style.top),
      width: parseFloat(cropBoxEl.style.width), height: parseFloat(cropBoxEl.style.height),
    };
    const opposite = {
      x: handle.includes('w') ? box.left + box.width : box.left,
      y: handle.includes('n') ? box.top + box.height : box.top,
    };
    dragState = { mode: 'resize', opposite };
  } else if (target === cropBoxEl) {
    const box = { left: parseFloat(cropBoxEl.style.left), top: parseFloat(cropBoxEl.style.top) };
    dragState = { mode: 'move', startMouse: start, startBox: box };
  } else {
    dragState = { mode: 'draw', origin: start };
    cropBoxEl.style.left = `${start.x}px`;
    cropBoxEl.style.top = `${start.y}px`;
    cropBoxEl.style.width = '0px';
    cropBoxEl.style.height = '0px';
  }
  evt.preventDefault();
});

window.addEventListener('mousemove', evt => {
  if (eraseMode && eraseStroke) {
    const pos = frameXY(evt);
    const last = eraseStroke[eraseStroke.length - 1];
    if (Math.hypot(pos.x - last.x, pos.y - last.y) >= 3) {
      eraseStroke.push(pos);
      renderExcludeOverlay(eraseStroke);
    }
    return;
  }

  if (!dragState) return;
  const pos = frameXY(evt);

  if (dragState.mode === 'move') {
    const dx = pos.x - dragState.startMouse.x, dy = pos.y - dragState.startMouse.y;
    const box = clampDisplayBox({
      left: dragState.startBox.left + dx, top: dragState.startBox.top + dy,
      width: parseFloat(cropBoxEl.style.width), height: parseFloat(cropBoxEl.style.height),
    });
    cropBoxEl.style.left = `${box.left}px`;
    cropBoxEl.style.top = `${box.top}px`;
  } else if (dragState.mode === 'resize') {
    const o = dragState.opposite;
    const box = clampDisplayBox({
      left: Math.min(o.x, pos.x), top: Math.min(o.y, pos.y),
      width: Math.abs(pos.x - o.x), height: Math.abs(pos.y - o.y),
    });
    cropBoxEl.style.left = `${box.left}px`;
    cropBoxEl.style.top = `${box.top}px`;
    cropBoxEl.style.width = `${box.width}px`;
    cropBoxEl.style.height = `${box.height}px`;
  } else if (dragState.mode === 'draw') {
    const o = dragState.origin;
    const box = clampDisplayBox({
      left: Math.min(o.x, pos.x), top: Math.min(o.y, pos.y),
      width: Math.abs(pos.x - o.x), height: Math.abs(pos.y - o.y),
    });
    cropBoxEl.style.left = `${box.left}px`;
    cropBoxEl.style.top = `${box.top}px`;
    cropBoxEl.style.width = `${box.width}px`;
    cropBoxEl.style.height = `${box.height}px`;
  }
});

window.addEventListener('mouseup', () => {
  if (eraseMode && eraseStroke) {
    if (eraseStroke.length >= 3) {
      const s = displayScale();
      const polyImg = eraseStroke.map(p => ({ x: Math.round(p.x / s), y: Math.round(p.y / s) }));
      excludePolygons.push(polyImg);
      regenerateIfPossible();
    }
    eraseStroke = null;
    renderExcludeOverlay();
    return;
  }

  if (!dragState) return;
  const box = {
    left: parseFloat(cropBoxEl.style.left), top: parseFloat(cropBoxEl.style.top),
    width: parseFloat(cropBoxEl.style.width), height: parseFloat(cropBoxEl.style.height),
  };
  commitDisplayBox(clampDisplayBox(box));
  renderCropBox();
  dragState = null;
});

// ------------------------------------------- poistoalueet (turhat kohdat) --
const excludeOverlaySvg = $('#exclude-overlay');

function renderExcludeOverlay(liveDisplayPoints) {
  if (!photoImg.clientWidth) { excludeOverlaySvg.innerHTML = ''; return; }
  const s = displayScale();
  let svg = '';
  excludePolygons.forEach(poly => {
    const pts = poly.map(p => `${p.x * s},${p.y * s}`).join(' ');
    svg += `<polygon class="exclude-polygon" points="${pts}"></polygon>`;
  });
  if (liveDisplayPoints && liveDisplayPoints.length >= 2) {
    const pts = liveDisplayPoints.map(p => `${p.x},${p.y}`).join(' ');
    svg += `<polygon class="exclude-polygon" points="${pts}"></polygon>`;
  }
  excludeOverlaySvg.innerHTML = svg;
}

$('#btn-undo-exclude').addEventListener('click', () => {
  excludePolygons.pop();
  renderExcludeOverlay();
  regenerateIfPossible();
});
$('#btn-clear-exclude').addEventListener('click', () => {
  if (!excludePolygons.length) return;
  excludePolygons = [];
  renderExcludeOverlay();
  regenerateIfPossible();
});

function excludeToWire() {
  return excludePolygons.map(poly => poly.map(p => [p.x, p.y]));
}

function excludeFromWire(raw) {
  return (raw || []).map(poly => poly.map(pt => ({ x: pt[0], y: pt[1] })));
}

// ------------------------------------------------------------- lataus --
$('#form-upload').addEventListener('submit', async evt => {
  evt.preventDefault();
  const msg = $('#msg-upload');
  msg.textContent = '';
  msg.className = 'msg';
  const fileInput = $('#input-photo');
  if (!fileInput.files.length) return;
  try {
    await postForm('/api/upload', evt.target);
    cropImg = null;
    excludePolygons = [];
    await refreshState();
    toast('Kuva ladattu');
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg msg-error';
  }
});

// ------------------------------------------------------------ kuvion luonti
$('#btn-generate').addEventListener('click', async () => {
  const msg = $('#msg-generate');
  msg.textContent = '';
  msg.className = 'msg';
  if (!STATE.has_image) {
    msg.textContent = 'Lataa ensin kuva';
    msg.className = 'msg msg-error';
    return;
  }
  try {
    const res = await postJSON('/api/generate', {
      width: boardWidth(), height: boardHeight(), crop: cropImg, exclude: excludeToWire(),
    });
    STATE.board = res.board;
    STATE.crop = res.crop;
    STATE.grid = res.grid;
    cropImg = res.crop;
    excludePolygons = excludeFromWire(res.exclude);
    renderCropBox();
    renderExcludeOverlay();
    renderCanvas();
    renderLegend();
    renderSaveStatus();
    toast('Kuvio luotu');
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg msg-error';
  }
});

async function regenerateIfPossible() {
  if (!STATE.grid || !STATE.has_image) return;
  try {
    const res = await postJSON('/api/generate', {
      width: STATE.board.width, height: STATE.board.height, crop: cropImg, exclude: excludeToWire(),
    });
    STATE.board = res.board;
    STATE.crop = res.crop;
    STATE.grid = res.grid;
    excludePolygons = excludeFromWire(res.exclude);
    renderCanvas();
    renderLegend();
    renderSaveStatus();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================== PALETTI ==
function renderPaletteList() {
  const wrap = $('#palette-list');
  wrap.innerHTML = '';
  STATE.palette.forEach(c => {
    const [r, g, b] = hexToRgb(c.hex);
    const row = document.createElement('div');
    row.className = 'palette-row';
    row.dataset.id = c.id;
    row.innerHTML = `
      <input type="color" class="pal-color" value="${c.hex}">
      <input type="text" class="pal-name" value="${escapeHtml(c.name)}">
      <input type="number" class="pal-r" min="0" max="255" value="${r}" title="R">
      <input type="number" class="pal-g" min="0" max="255" value="${g}" title="G">
      <input type="number" class="pal-b" min="0" max="255" value="${b}" title="B">
      <label class="pal-active" title="Käytössä"><input type="checkbox" class="pal-active-cb" ${c.active ? 'checked' : ''}></label>
      <button class="row-del" data-id="${c.id}" title="Poista">✕</button>
    `;
    wrap.appendChild(row);
  });

  $$('.pal-color', wrap).forEach(el => el.addEventListener('change', onPaletteColorPicked));
  $$('.pal-r,.pal-g,.pal-b', wrap).forEach(el => el.addEventListener('change', onPaletteRgbChanged));
  $$('.pal-name', wrap).forEach(el => el.addEventListener('change', onPaletteNameChanged));
  $$('.pal-active-cb', wrap).forEach(el => el.addEventListener('change', onPaletteActiveChanged));
  $$('.row-del', wrap).forEach(el => el.addEventListener('click', onPaletteDelete));
}

async function onPaletteColorPicked(evt) {
  const id = evt.target.closest('.palette-row').dataset.id;
  const hex = evt.target.value.toUpperCase();
  try {
    await postJSON(`/api/palette/colors/${id}`, { hex }, 'PATCH');
    await afterPaletteEdit();
  } catch (err) { toast(err.message, 'err'); }
}

async function onPaletteRgbChanged(evt) {
  const row = evt.target.closest('.palette-row');
  const id = row.dataset.id;
  const r = parseInt($('.pal-r', row).value, 10) || 0;
  const g = parseInt($('.pal-g', row).value, 10) || 0;
  const b = parseInt($('.pal-b', row).value, 10) || 0;
  try {
    await postJSON(`/api/palette/colors/${id}`, { r, g, b }, 'PATCH');
    await afterPaletteEdit();
  } catch (err) { toast(err.message, 'err'); }
}

async function onPaletteNameChanged(evt) {
  const row = evt.target.closest('.palette-row');
  const id = row.dataset.id;
  const name = evt.target.value.trim();
  if (!name) { toast('Nimi ei voi olla tyhjä', 'err'); return; }
  try {
    await postJSON(`/api/palette/colors/${id}`, { name }, 'PATCH');
    STATE = await api('/api/state');
    renderRecolorSelects();
    renderLegend();
  } catch (err) { toast(err.message, 'err'); }
}

async function onPaletteActiveChanged(evt) {
  const row = evt.target.closest('.palette-row');
  const id = row.dataset.id;
  try {
    await postJSON(`/api/palette/colors/${id}`, { active: evt.target.checked }, 'PATCH');
    await afterPaletteEdit();
  } catch (err) { toast(err.message, 'err'); }
}

async function onPaletteDelete(evt) {
  const id = evt.target.dataset.id;
  try {
    await api(`/api/palette/colors/${id}`, { method: 'DELETE' });
    STATE = await api('/api/state');
    renderPaletteList();
    renderRecolorSelects();
    renderLegend();
    renderSaveStatus();
  } catch (err) { toast(err.message, 'err'); }
}

async function afterPaletteEdit() {
  STATE = await api('/api/state');
  renderPaletteList();
  renderRecolorSelects();
  await regenerateIfPossible();
}

// ------------------------------------------- nimetyt värit (Wikipedia) ----
let WIKI_COLORS = [];

async function loadWikiColors() {
  try {
    const res = await api('/api/wiki_colors');
    WIKI_COLORS = res.colors;
  } catch (err) {
    console.error('Wikipedia-värilistan lataus epäonnistui', err);
  }
}

const wikiSearchInput = $('#wiki-color-search');
const wikiDropdown = $('#wiki-color-dropdown');
const WIKI_RESULTS_LIMIT = 50;

function renderWikiDropdown(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    wikiDropdown.hidden = true;
    wikiDropdown.innerHTML = '';
    return;
  }
  const matches = WIKI_COLORS.filter(c => c.name.toLowerCase().includes(q));
  const shown = matches.slice(0, WIKI_RESULTS_LIMIT);
  wikiDropdown.innerHTML = '';

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'wiki-color-empty';
    empty.textContent = 'Ei osumia';
    wikiDropdown.appendChild(empty);
  } else {
    shown.forEach(c => {
      const row = document.createElement('div');
      row.className = 'wiki-color-row';
      row.innerHTML = `
        <span class="wiki-color-swatch" style="background:${c.hex}"></span>
        <span class="wiki-color-name">${escapeHtml(c.name)}</span>
        <span class="wiki-color-hex">${c.hex}</span>
      `;
      row.addEventListener('click', () => addWikiColor(c));
      wikiDropdown.appendChild(row);
    });
    if (matches.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'wiki-color-empty';
      more.textContent = `+ ${matches.length - shown.length} muuta osumaa - tarkenna hakua`;
      wikiDropdown.appendChild(more);
    }
  }
  wikiDropdown.hidden = false;
}

async function addWikiColor(c) {
  try {
    await postJSON('/api/palette/colors', { name: c.name, hex: c.hex });
    wikiSearchInput.value = '';
    wikiDropdown.hidden = true;
    wikiDropdown.innerHTML = '';
    await afterPaletteEdit();
    toast(`${c.name} lisätty paletiin`);
  } catch (err) {
    toast(err.message, 'err');
  }
}

wikiSearchInput.addEventListener('input', () => renderWikiDropdown(wikiSearchInput.value));
wikiSearchInput.addEventListener('focus', () => {
  if (wikiSearchInput.value.trim()) renderWikiDropdown(wikiSearchInput.value);
});
document.addEventListener('click', evt => {
  if (!wikiDropdown.hidden && !wikiDropdown.contains(evt.target) && evt.target !== wikiSearchInput) {
    wikiDropdown.hidden = true;
  }
});
wikiSearchInput.addEventListener('keydown', evt => {
  if (evt.key === 'Escape') { wikiDropdown.hidden = true; wikiSearchInput.blur(); }
});

function updateNewColorPreview() {
  const r = parseInt($('#new-color-r').value, 10) || 0;
  const g = parseInt($('#new-color-g').value, 10) || 0;
  const b = parseInt($('#new-color-b').value, 10) || 0;
  $('#new-color-preview').style.background = rgbToHex(r, g, b);
}
$$('#new-color-r,#new-color-g,#new-color-b').forEach(el => {
  el.addEventListener('input', updateNewColorPreview);
});
updateNewColorPreview();

$('#btn-add-color').addEventListener('click', async () => {
  const msg = $('#msg-palette');
  msg.textContent = '';
  msg.className = 'msg';
  const name = $('#new-color-name').value.trim();
  if (!name) {
    msg.textContent = 'Anna värille nimi';
    msg.className = 'msg msg-error';
    return;
  }
  const r = parseInt($('#new-color-r').value, 10) || 0;
  const g = parseInt($('#new-color-g').value, 10) || 0;
  const b = parseInt($('#new-color-b').value, 10) || 0;
  try {
    await postJSON('/api/palette/colors', { name, r, g, b });
    $('#new-color-name').value = '';
    STATE = await api('/api/state');
    renderPaletteList();
    renderRecolorSelects();
    await regenerateIfPossible();
    toast('Väri lisätty');
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg msg-error';
  }
});

// ------------------------------------------------------------ vaihda väri -
function renderRecolorSelects() {
  const opts = STATE.palette
    .map(c => `<option value="${c.hex}">${escapeHtml(c.name)} (${c.hex})</option>`)
    .join('');
  $('#recolor-from').innerHTML = opts;
  $('#recolor-to').innerHTML = opts;
}

$('#btn-recolor').addEventListener('click', async () => {
  const msg = $('#msg-recolor');
  msg.textContent = '';
  msg.className = 'msg';
  const from_hex = $('#recolor-from').value;
  const to_hex = $('#recolor-to').value;
  if (!STATE.grid) {
    msg.textContent = 'Ei kuviota - luo kuvio ensin';
    msg.className = 'msg msg-error';
    return;
  }
  try {
    const res = await postJSON('/api/recolor', { from_hex, to_hex });
    STATE.grid = res.grid;
    renderCanvas();
    renderLegend();
    renderSaveStatus();
    toast(`${res.changed} helmeä vaihdettu`);
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg msg-error';
  }
});

// ================================================================ CANVAS ==
const canvas = $('#pattern-canvas');
const ctx = canvas.getContext('2d');

const PEGBOARD_BG = '#dfdacb';
const PEG_COLOR = '#c7bfa5';

// Sävyttää hex-värin kohti mustaa (percent < 0) tai valkoista (percent > 0) -
// käytetään helmen reunavarjostukseen, jotta se erottuu litteästä ympyrästä.
function shadeHex(hex, percent) {
  const [r, g, b] = hexToRgb(hex);
  const target = percent < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(percent) / 100);
  const mix = c => Math.round(c + (target - c) * p);
  return rgbToHex(mix(r), mix(g), mix(b));
}

function renderCanvas() {
  if (!STATE.grid) {
    canvas.style.display = 'none';
    $('#canvas-empty').style.display = 'block';
    return;
  }
  canvas.style.display = 'inline-block';
  $('#canvas-empty').style.display = 'none';

  const boardH = STATE.grid.length;
  const boardW = STATE.grid[0].length;
  const budget = 640;
  const cell = Math.max(4, Math.min(40, Math.floor(budget / Math.max(boardW, boardH))));

  // Piirretään ylitarkkuudella (vähintään 2x, näytön omaa devicePixelRatiota
  // korkeampi arvo ei koskaan haittaa) - ilman tätä helmien ympyröiden
  // pyöristys/reunanpehmennys tallentuisi vain näytön "loogisiin" pikseleihin,
  // ja kuvio näyttäisi suttuiselta heti kun sitä suurentaa (selaimen zoomaus,
  // iso näyttö, PNG-viennin avaaminen suurempana). Bitmap piirretään
  // moninkertaisena, mutta näytetään silti samankokoisena CSS-pikseleissä.
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const logicalW = boardW * cell;
  const logicalH = boardH * cell;

  canvas.width = Math.round(logicalW * dpr);
  canvas.height = Math.round(logicalH * dpr);
  canvas.style.width = `${logicalW}px`;
  canvas.style.height = `${logicalH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = PEGBOARD_BG;
  ctx.fillRect(0, 0, logicalW, logicalH);

  // Hamahelmen tunnusomaisin piirre on reiän kautta näkyvä pegboard-nasta,
  // johon helmi pujotetaan - siksi jokainen helmi piirretään renkaana
  // (täyttö + tummempi reunavarjostus + keskellä nastan väriseksi jätetty
  // reikä), ei pelkkänä umpinaisena ympyränä. Pieni kiiltopilkku antaa
  // muovisen helmen hieman kolmiulotteisen ilmeen.
  const beadR = cell * 0.47;
  const holeR = Math.max(0.8, cell * 0.15);
  const pegR = Math.max(0.6, cell * 0.09);
  const showDetail = cell >= 9;
  const hidden = new Set(STATE.hidden_colors || []);

  for (let row = 0; row < boardH; row++) {
    for (let col = 0; col < boardW; col++) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell / 2;
      const rawHex = STATE.grid[row][col];
      // Piilotettu väri näytetään paljaana nastana kuten tyhjä ruutu,
      // vaikka data (STATE.grid) säilyttää alkuperäisen värin ennallaan -
      // siksi piilotus on aina palautettavissa ilman uudelleengenerointia.
      const hex = rawHex && !hidden.has(rawHex.toUpperCase()) ? rawHex : null;

      if (hex) {
        ctx.beginPath();
        ctx.arc(cx, cy, beadR, 0, Math.PI * 2);
        ctx.fillStyle = hex;
        ctx.fill();
        ctx.lineWidth = Math.max(0.6, cell * 0.05);
        ctx.strokeStyle = shadeHex(hex, -30);
        ctx.stroke();

        if (showDetail) {
          ctx.beginPath();
          ctx.ellipse(cx - beadR * 0.32, cy - beadR * 0.32, beadR * 0.3, beadR * 0.17, -Math.PI / 4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,.35)';
          ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
        ctx.fillStyle = PEG_COLOR;
        ctx.fill();
        if (showDetail) {
          ctx.lineWidth = 0.6;
          ctx.strokeStyle = 'rgba(0,0,0,.3)';
          ctx.stroke();
        }
      } else {
        // Tyhjä helmipaikka: paljas pegboard-nasta ilman helmeä.
        ctx.beginPath();
        ctx.arc(cx, cy, pegR, 0, Math.PI * 2);
        ctx.fillStyle = PEG_COLOR;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,.15)';
        ctx.stroke();
      }
    }
  }
}

canvas.addEventListener('click', evt => {
  if (!STATE.grid) return;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (evt.clientX - rect.left) * scaleX;
  const y = (evt.clientY - rect.top) * scaleY;
  const boardW = STATE.grid[0].length, boardH = STATE.grid.length;
  const cellSize = canvas.width / boardW;
  const col = Math.min(boardW - 1, Math.max(0, Math.floor(x / cellSize)));
  const row = Math.min(boardH - 1, Math.max(0, Math.floor(y / cellSize)));
  openCellPopover(row, col, evt.pageX, evt.pageY);
});

// -------------------------------------------------------- solun väripop-up
const popover = $('#cell-popover');

function openCellPopover(row, col, pageX, pageY) {
  popover.innerHTML = '';

  const emptyBtn = document.createElement('button');
  emptyBtn.className = 'popover-empty-btn';
  emptyBtn.title = 'Tyhjä (ei helmeä)';
  emptyBtn.textContent = '×';
  emptyBtn.addEventListener('click', async () => {
    try {
      await postJSON('/api/cell', { row, col, hex: null });
      STATE.grid[row][col] = null;
      renderCanvas();
      renderLegend();
      renderSaveStatus();
      closePopover();
    } catch (err) { toast(err.message, 'err'); }
  });
  popover.appendChild(emptyBtn);

  STATE.palette.forEach(c => {
    const btn = document.createElement('button');
    btn.style.background = c.hex;
    btn.title = `${c.name} (${c.hex})`;
    btn.addEventListener('click', async () => {
      try {
        await postJSON('/api/cell', { row, col, hex: c.hex });
        STATE.grid[row][col] = c.hex;
        renderCanvas();
        renderLegend();
        renderSaveStatus();
        closePopover();
      } catch (err) { toast(err.message, 'err'); }
    });
    popover.appendChild(btn);
  });
  popover.hidden = false;
  popover.style.left = `${pageX + 10}px`;
  popover.style.top = `${pageY + 10}px`;
}

function closePopover() { popover.hidden = true; }

document.addEventListener('click', evt => {
  if (!popover.hidden && !popover.contains(evt.target) && evt.target !== canvas) closePopover();
});

// -------------------------------------------------------------- vienti PNG
$('#btn-export-png').addEventListener('click', () => {
  if (!STATE.grid) { toast('Ei kuviota vietäväksi', 'err'); return; }
  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hamahelmi-kuvio.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, 'image/png');
});

// ================================================================ LEGENDA =
function renderLegend() {
  const list = $('#legend-list');
  list.innerHTML = '';
  if (!STATE.grid) {
    $('#legend-total').textContent = '0';
    return;
  }
  const counts = new Map();
  let emptyCount = 0;
  STATE.grid.forEach(row => row.forEach(hex => {
    if (!hex) { emptyCount++; return; }
    const key = hex.toUpperCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }));
  const nameByHex = new Map(STATE.palette.map(c => [c.hex.toUpperCase(), c.name]));
  const hidden = new Set(STATE.hidden_colors || []);
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const visible = entries.filter(([hex]) => !hidden.has(hex));
  const hiddenEntries = entries.filter(([hex]) => hidden.has(hex));

  visible.forEach(([hex, count]) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const name = nameByHex.get(hex) || hex;
    row.innerHTML = `
      <span class="legend-swatch" style="background:${hex}"></span>
      <span class="legend-name">${escapeHtml(name)}</span>
      <span class="legend-count">${count}</span>
      <button class="legend-hide-btn" data-hex="${hex}" title="Piilota väri - poistaa sen näkyvistä kuviosta (voit palauttaa sen myöhemmin)">Piilota</button>
    `;
    list.appendChild(row);
  });
  $$('.legend-hide-btn', list).forEach(btn => btn.addEventListener('click', onHideColor));

  if (emptyCount > 0) {
    const row = document.createElement('div');
    row.className = 'legend-row';
    row.innerHTML = `
      <span class="legend-swatch legend-swatch-empty"></span>
      <span class="legend-name">Tyhjä (poistettu)</span>
      <span class="legend-count">${emptyCount}</span>
    `;
    list.appendChild(row);
  }

  if (hiddenEntries.length) {
    const heading = document.createElement('div');
    heading.className = 'legend-hidden-heading';
    heading.textContent = 'Piilotetut värit';
    list.appendChild(heading);

    hiddenEntries.forEach(([hex, count]) => {
      const row = document.createElement('div');
      row.className = 'legend-row legend-row-hidden';
      const name = nameByHex.get(hex) || hex;
      row.innerHTML = `
        <span class="legend-swatch" style="background:${hex}"></span>
        <span class="legend-name">${escapeHtml(name)}</span>
        <span class="legend-count">${count}</span>
        <button class="legend-restore-btn" data-hex="${hex}" title="Palauta väri näkyviin">Palauta</button>
      `;
      list.appendChild(row);
    });
    $$('.legend-restore-btn', list).forEach(btn => btn.addEventListener('click', onRestoreColor));
  }

  const totalVisible = visible.reduce((s, [, c]) => s + c, 0);
  const totalHidden = hiddenEntries.reduce((s, [, c]) => s + c, 0);
  $('#legend-total').textContent = String(totalVisible + totalHidden + emptyCount);
}

async function onHideColor(evt) {
  const hex = evt.target.dataset.hex;
  try {
    const res = await postJSON('/api/hide_color', { hex, hidden: true });
    STATE.hidden_colors = res.hidden_colors;
    renderCanvas();
    renderLegend();
    renderSaveStatus();
    toast('Väri piilotettu - voit palauttaa sen "Piilotetut värit" -listasta');
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function onRestoreColor(evt) {
  const hex = evt.target.dataset.hex;
  try {
    const res = await postJSON('/api/hide_color', { hex, hidden: false });
    STATE.hidden_colors = res.hidden_colors;
    renderCanvas();
    renderLegend();
    renderSaveStatus();
    toast('Väri palautettu');
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ================================================================== RESET =
$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Tyhjennetäänkö kuva, paletti ja kuvio kokonaan?')) return;
  try {
    await api('/api/reset', { method: 'POST' });
    cropImg = null;
    excludePolygons = [];
    await refreshState();
    toast('Kaikki tyhjennetty');
  } catch (err) { toast(err.message, 'err'); }
});

// ==================================================================== INIT
refreshState();
loadWikiColors();
