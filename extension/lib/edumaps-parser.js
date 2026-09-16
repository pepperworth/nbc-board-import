// Edumaps-Board-Parser (Pinboard, Timeline, Stickerwall).
//
// Adaptiert aus edumaps-import/edumaps-parser.js (steedalot/nbcimport-nahe
// Projekt, lokal unter NBC-tools/edumaps-import) -- dort laeuft derselbe
// Code serverseitig gegen linkedom, hier direkt gegen das Live-DOM des
// Browsers (DOMParser-Ergebnis bzw. das echte Tab-DOM). Die Farblogik
// wurde entfernt und durch lib/colors.js ersetzt (dort inkl. der
// "nur 11 von 20 Farben sind im NBC-Client sichtbar"-Korrektur aus der
// Python-Analyse von nbcimport, die diese Datei ursprünglich nicht hatte).
(function () {
	'use strict';

// ── Pure Node-Helpers (kein DOM) ───────────────────────────────────────

function buildExport(columns, boardTitle) {
  let totalCards = 0, totalElements = 0, totalFiles = 0, totalLinks = 0,
      totalInternalLinks = 0, totalQrCodes = 0, totalCollaborativeTextEditors = 0,
      totalCardsColored = 0;
  for (const col of columns) {
    for (const card of col.cards) {
      totalCards++;
      if (card.backgroundColor && card.backgroundColor !== 'transparent') totalCardsColored++;
      for (const el of (card.elements || [])) {
        totalElements++;
        if (el.type === 'file') totalFiles++;
        if (el.type === 'link') totalLinks++;
        if (el.type === 'internalLink') totalInternalLinks++;
        if (el.type === 'qrCode') totalQrCodes++;
        if (el.type === 'collaborativeTextEditor') totalCollaborativeTextEditors++;
      }
    }
  }
  return {
    exportDate: new Date().toISOString(),
    version: '0.11',
    boardTitle,
    totalColumns: columns.length,
    totalCards,
    totalCardsColored,
    totalFiles,
    totalLinks,
    totalInternalLinks,
    totalQrCodes,
    totalCollaborativeTextEditors,
    totalVideoConferences: 0,
    totalExternalTools: 0,
    totalElements,
    columns,
  };
}

function collectMediaUrls(columns) {
  const map = new Map(); // fileName → _originalUrl
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'file' && el._originalUrl) {
          map.set(el.fileName, el._originalUrl);
        }
      }
    }
  }
  return map;
}

function injectFileData(columns, dataMap) {
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        if (el.type === 'file' && dataMap.has(el.fileName)) {
          el.fileData = dataMap.get(el.fileName);
        }
      }
    }
  }
}

function stripInternalFields(columns) {
  for (const col of columns) {
    for (const card of col.cards) {
      for (const el of (card.elements || [])) {
        delete el._originalUrl;
      }
    }
  }
}

// ── DOM-Parser ─────────────────────────────────────────────────────────

const TIMELINE_TYPES = ['34'];
const STICKERWALL_TYPES = ['22'];

// Edumaps-Widgets ohne NBC-Entsprechung. Reihenfolge ist relevant: spezifischere
// Klassen zuerst, damit z.B. coursestart-btn (Sonderfall von quizstart-btn-wrap)
// nicht als generischer Quiz-Starter erkannt wird.
const UNSUPPORTED_WIDGETS = [
  ['quiz-wrap',          'Single-/Multiple-Choice-Quiz'],
  ['coursestart-btn',    'Kurs-Starter-Button'],
  ['quizstart-btn-wrap', 'Quiz-Starter-Button'],
  ['sendprompt-btn',     'KI-Prompt-Button'],
  ['poll-wrap',          'Umfrage/Abstimmung'],
  ['test-wrap',          'Zuordnungsübung'],
  ['cboxlist',           'Abhakliste'],
  ['boxcountdown',       'Countdown-Timer'],
  ['ttsaudio',           'Text-to-Speech-Audio'],
];
const TEAMTEXT_RE = /^https?:\/\/team\.edumaps\.de\/p\//i;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function detectUnsupportedWidget(el) {
  for (const [cls, label] of UNSUPPORTED_WIDGETS) {
    if (el.querySelector('.' + cls)) return label;
  }
  return null;
}

function renderWidgetWarning(label) {
  return '<p>⚠️ Edumaps-Element „' + escHtml(label) + '" konnte nicht in die NBC übertragen werden.</p>';
}

function cleanTableForCk5(table) {
  // NBC-Tabellen liegen als <figure class="table"><table><thead?>…</thead?><tbody>…</tbody></table></figure>
  // im CKEditor-5-Save-Format vor. Edumaps markiert Header-Zeilen, indem die erste
  // Zeile komplett aus <th> besteht.
  const rows = Array.from(table.querySelectorAll('tr'));
  if (!rows.length) return '';
  let headerRow = null;
  let bodyRows = rows;
  const firstCells = Array.from(rows[0].querySelectorAll('th, td'));
  if (firstCells.length && firstCells.every(c => c.tagName.toLowerCase() === 'th')) {
    headerRow = rows[0];
    bodyRows = rows.slice(1);
  }
  const cell = (c) => c.innerHTML.trim().replace(/\s+/g, ' ');
  const parts = ['<figure class="table"><table>'];
  if (headerRow) {
    parts.push('<thead><tr>');
    headerRow.querySelectorAll('th, td').forEach(c => parts.push('<th>' + cell(c) + '</th>'));
    parts.push('</tr></thead>');
  }
  if (bodyRows.length) {
    parts.push('<tbody>');
    bodyRows.forEach(row => {
      parts.push('<tr>');
      row.querySelectorAll('th, td').forEach(c => parts.push('<td>' + cell(c) + '</td>'));
      parts.push('</tr>');
    });
    parts.push('</tbody>');
  }
  parts.push('</table></figure>');
  return parts.join('');
}

function findQrCodes(boxEl) {
  // Pro .hasqrcode-Container ein Eintrag (Edumaps hat oft Preview-Btn + qrcodeimage
  // mit identischem data-url — hier wäre sonst alles doppelt).
  const found = [];
  let idx = 1;
  boxEl.querySelectorAll('.hasqrcode').forEach(wrap => {
    const target = wrap.querySelector('[data-url]');
    if (!target) return;
    const dataUrl = (target.getAttribute('data-url') || '').trim();
    if (!dataUrl) return;
    found.push({ content: dataUrl, index: idx++ });
  });
  return found;
}

function getTypeId(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const part of parts) if (/^\d+$/.test(part)) return part;
  return null;
}

function detectBoardType(pathname) {
  const id = getTypeId(pathname);
  if (!id) return null;
  if (TIMELINE_TYPES.includes(id)) return 'timeline';
  if (STICKERWALL_TYPES.includes(id)) return 'stickerwall';
  return 'pinboard';
}

function getBoardTitle(document) {
  const headline = document.querySelector('h1.mapeditor-headline');
  if (headline) return headline.textContent.trim();
  const h1 = document.querySelector('h1');
  if (h1) return h1.textContent.trim();
  const titleEl = document.querySelector('title');
  const raw = titleEl ? titleEl.textContent : '';
  return raw.replace(/\s*[|\-–]\s*edumaps.*/i, '').trim() || 'Edumaps Board';
}

function uniqueFileName(name, usedNames) {
  if (!usedNames.has(name)) { usedNames.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot >= 0 ? name.slice(0, dot) : name;
  const ext  = dot >= 0 ? name.slice(dot) : '';
  let i = 2;
  while (usedNames.has(base + '_' + i + ext)) i++;
  const unique = base + '_' + i + ext;
  usedNames.add(unique);
  return unique;
}

function extractImageElements(boxEl, startOrder, usedNames) {
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('a.mediaitem-img[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const cleanHref = href.replace(/#.*$/, '').replace(/\/preview$/, '');
    const segments = cleanHref.split('/').filter(Boolean);
    let baseName = segments[segments.length - 2] || segments[segments.length - 1] || 'bild';
    const isPng = href.includes('.png');
    const isJpg = href.includes('.jpg') || href.includes('.jpeg');
    const isGif = href.includes('.gif');
    if (isPng && !baseName.endsWith('.png')) baseName += '.png';
    else if (isJpg && !baseName.endsWith('.jpg')) baseName += '.jpg';
    else if (isGif && !baseName.endsWith('.gif')) baseName += '.gif';
    else if (!baseName.includes('.')) baseName += '.png';
    const fileName = uniqueFileName(baseName, usedNames);
    elements.push({ order: order++, type: 'file', fileName, fileInfo: 'Bild, Edumaps',
                    content: '📎 ' + fileName, shouldBeBold: true, _originalUrl: href });
  });
  const seenHrefs = new Set(elements.map(e => e._originalUrl));
  boxEl.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (!src.includes('/file/') && !src.includes('/upload/')) return;
    if (src.includes('preview') || src.includes('thumb')) return;
    if (seenHrefs.has(src)) return;
    seenHrefs.add(src);
    const baseName = src.split('/').pop().split('?')[0] || 'bild.png';
    const fileName = uniqueFileName(baseName, usedNames);
    elements.push({ order: order++, type: 'file', fileName, fileInfo: 'Bild, Edumaps',
                    content: '📎 ' + fileName, shouldBeBold: true, _originalUrl: src });
  });
  return elements;
}

function injectAnchorPlaceholders(html) {
  // href="#anker" → href="__ANCHOR__anker" — wird nach dem Import aufgelöst
  return html.replace(/href="#([^"]+)"/g, 'href="__ANCHOR__$1"');
}

function hasInlineOnlyLinks(li) {
  // Zeile enthält nur interne Links (kein Text außer in den Links, kein ol/ul)
  const puretext = li.querySelector('.line-puretext');
  if (!puretext) return false;
  const anchors = puretext.querySelectorAll('a.inline.selfopener[href^="#"]');
  if (!anchors.length) return false;
  if (puretext.querySelector('ol, ul')) return false;
  return anchors.length === 1;
}

function extractTextContent(boxEl) {
  // Inhalt wird als (html, isBlock)-Paare gesammelt. Block-Elemente
  // (<table>, <blockquote>, Widget-Warnungen) dürfen laut HTML5-Spec nicht
  // in <p> stehen — CKEditor-5 würde die Tabelle sonst beim Laden verlieren.
  const parts = [];
  boxEl.querySelectorAll('li.itemline').forEach(li => {
    if (li.querySelector('a.mediaitem-img')) return;
    if (li.querySelector('a[class*="mediaitem-"]')) return;
    if (hasInlineOnlyLinks(li)) return;

    const puretext = li.querySelector('.line-puretext');
    if (puretext) {
      // QR-Codes werden vom Parent (parseBox) als eigenes File-Element erzeugt —
      // hier keine leere Text-Zeile produzieren.
      if (puretext.querySelector('.hasqrcode, .qrcodeimage')) return;

      const widgetLabel = detectUnsupportedWidget(puretext);
      if (widgetLabel) {
        parts.push({ html: renderWidgetWarning(widgetLabel), isBlock: true });
        return;
      }

      const table = puretext.querySelector('table');
      if (table) {
        const cleaned = cleanTableForCk5(table);
        if (cleaned) parts.push({ html: cleaned, isBlock: true });
        return;
      }

      let html = puretext.innerHTML.replace(/<span[^>]*class="mapanchor"[^>]*>.*?<\/span>/g, '').trim();
      if (html !== '&nbsp;' && html !== '' && html.replace(/\s/g,'') !== '') {
        html = injectAnchorPlaceholders(html);
        parts.push({ html, isBlock: false });
      }
      return;
    }

    const bq = li.querySelector('blockquote');
    if (bq && bq.textContent.trim()) {
      let html = '<blockquote>' + bq.innerHTML.trim() + '</blockquote>';
      html = injectAnchorPlaceholders(html);
      parts.push({ html, isBlock: true });
    }
  });
  if (!parts.length) return '';
  return parts.map(p => p.isBlock ? p.html : '<p>' + p.html + '</p>').join('');
}

function extractLinkElements(boxEl, startOrder) {
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('li.itemline a[class*="mediaitem-"]').forEach(a => {
    if (a.classList.contains('mediaitem-img')) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    // Edumaps-Teamtext (Etherpad auf team.edumaps.de) → CollabTextEditor in NBC.
    // Der NBC-Pad ist beim Anlegen leer; der Server hängt zusätzlich einen Link
    // auf den Original-Pad an, damit der Lehrer den Inhalt rüberkopieren kann.
    if (TEAMTEXT_RE.test(href)) {
      const innerSpan = a.querySelector('span');
      const padTitle = (innerSpan && innerSpan.textContent ? innerSpan.textContent.trim() : '') || 'Teamtext';
      elements.push({ order: order++, type: 'collaborativeTextEditor',
                      title: padTitle, originalUrl: href, content: '📝 ' + padTitle });
      return;
    }
    let title = (a.getAttribute('aria-label') || '').replace(/^Externen Link öffnen\s*[-–]\s*/i, '').trim();
    if (!title) title = a.textContent.replace(/\s+/g, ' ').trim();
    if (!title) title = href;
    elements.push({ order: order++, type: 'link', url: href, title, content: '🔗 ' + title });
  });
  return elements;
}

function extractQrCodeMarkers(boxEl, startOrder) {
  // Marker-Element — wird vom Server (renderQrCodesInline) zu file mit fileData PNG.
  const elements = [];
  let order = startOrder;
  findQrCodes(boxEl).forEach(({ content, index }) => {
    const fileName = 'qrcode-' + index + '.png';
    elements.push({
      order: order++,
      type: 'qrCode',
      content,
      fileName,
      caption: 'QR-Code → ' + content,
    });
  });
  return elements;
}

function extractInternalLinkElements(boxEl, startOrder) {
  // Nur einzelne interne Links (nicht in ol/ul) → als eigenes Link-Element
  const elements = [];
  let order = startOrder;
  boxEl.querySelectorAll('li.itemline').forEach(li => {
    if (!hasInlineOnlyLinks(li)) return;
    const a = li.querySelector('a.inline.selfopener[href^="#"]');
    const anchor = a.getAttribute('href') || '';
    if (!anchor || anchor === '#') return;
    const title = a.textContent.replace(/\s+/g, ' ').trim() || anchor;
    elements.push({ order: order++, type: 'internalLink', anchor, title, content: '↩ ' + title });
  });
  return elements;
}

function getBoxAnchorId(boxEl) {
  const span = boxEl.querySelector('span.mapanchor[id]');
  return span ? span.id : null;
}

function getBoxBackgroundColor(boxEl) {
  // Edumaps färbt h3.boxlabel via inline style="background:#xxxxxx;" — das ist
  // der Streifen oben auf der Karte und entspricht der "Karten-Farbe".
  // Fallback: Style direkt am .box-item (manche Board-Typen).
  const candidates = [
    boxEl.querySelector('h3.boxlabel[style*="background"]'),
    boxEl.querySelector('.boxhead[style*="background"]'),
    boxEl.matches?.('[style*="background"]') ? boxEl : null,
  ];
  for (const el of candidates) {
    if (!el) continue;
    const style = el.getAttribute('style') || '';
    const m = style.match(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/);
    if (m) return m[1];
  }
  return null;
}

function parseBox(boxEl, usedNames) {
  const labelEl = boxEl.querySelector('h3.boxlabel');
  const title = labelEl ? labelEl.textContent.trim() : 'Pin';
  const anchorId = getBoxAnchorId(boxEl);
  const rawColor = getBoxBackgroundColor(boxEl);
  const mappedColor = rawColor ? NBCImport.colors.hexToNbcColor(rawColor) : null;
  const elements = [];
  let order = 0;
  const textHtml = extractTextContent(boxEl);
  if (textHtml) elements.push({ order: order++, type: 'text', content: textHtml });
  const imgEls = extractImageElements(boxEl, order, usedNames);
  imgEls.forEach(el => { el.order = order++; elements.push(el); });
  const linkEls = extractLinkElements(boxEl, order);
  linkEls.forEach(el => { el.order = order++; elements.push(el); });
  const internalLinkEls = extractInternalLinkElements(boxEl, order);
  internalLinkEls.forEach(el => { el.order = order++; elements.push(el); });
  const qrEls = extractQrCodeMarkers(boxEl, order);
  qrEls.forEach(el => { el.order = order++; elements.push(el); });
  const card = { title, elements, content: elements.map(e => e.content || '').join('') };
  if (anchorId) card.anchorId = anchorId;
  if (rawColor) card.backgroundColorRaw = rawColor;
  if (mappedColor) card.backgroundColor = mappedColor;
  return card;
}

// Edumaps zeigt im UI nur einen Spalten-Header — wenn der DOM-`.path-item` leer
// ist (häufig), leitet Edumaps den Titel aus dem `h3.boxlabel` der ersten Karte
// ab und unterdrückt dort den Karten-Titel. Wir nehmen exakt diese Logik nach,
// sonst erscheint der Titel in NBC doppelt: einmal als Spalten-Header, einmal
// als Titel der ersten Karte. Eine reine Header-Karte ohne sonstigen Inhalt
// wird ganz gedroppt; eine Karte mit Inhalt verliert nur den Titel.
function dedupeFirstCardTitle(cards, sourceWasFirstLabel) {
  if (!sourceWasFirstLabel || cards.length === 0) return cards;
  const first = cards[0];
  if (!first.title) return cards;
  if (first.elements.length === 0) return cards.slice(1);
  first.title = '';
  return cards;
}

// Der Spalten-Header (.path-item h2.pathhead) enthaelt neben dem
// eigentlichen Titel (span.pathlabel) einen Badge mit der Kartenzahl
// (span.pathboxcount-badge, z.B. "3" fuer "3 Boxen in dieser Spalte").
// Reines .textContent auf .path-item haengt beides zusammen -- aus
// "Einführung" + Badge "3" wird "Einführung3". Karten-Titel (h3.boxlabel)
// haben dieses Problem nicht, nur der Spalten-Header.
function pathColumnTitle(pathItemEl) {
  if (!pathItemEl) return '';
  const label = pathItemEl.querySelector('.pathlabel');
  if (label) return label.textContent.trim();
  // Fallback fuer den Fall, dass .pathlabel mal fehlt, der Badge aber da
  // ist: Badge-Text vor dem Lesen entfernen statt ihn zu riskieren.
  const clone = pathItemEl.cloneNode(true);
  clone.querySelectorAll('.pathboxcount-badge').forEach((el) => el.remove());
  return clone.textContent.trim();
}

function parsePinboard(document, usedNames) {
  const boardTitle = getBoardTitle(document);
  const pathCols = document.querySelectorAll('.map-content-wrap .path-column');
  if (pathCols.length > 1) {
    const columns = [];
    pathCols.forEach((pathCol, idx) => {
      const pathItem = pathCol.querySelector('.path-item');
      const pathItemText = pathColumnTitle(pathItem);
      const firstLabel = pathCol.querySelector('h3.boxlabel');
      const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
      const colTitle = pathItemText || firstLabelText || 'Spalte ' + (idx + 1);
      const boxEls = pathCol.querySelectorAll('.box-item');
      let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
      cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
      if (cards.length > 0) columns.push({ title: colTitle, cards });
    });
    if (columns.length > 0) return columns;
  }
  const boxEls = document.querySelectorAll('.map-content-wrap .box-item');
  const cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
  return [{ title: boardTitle, cards }];
}

function parseTimeline(document, usedNames) {
  const pathCols = document.querySelectorAll('.path-column');
  const columns = [];
  pathCols.forEach((pathCol, idx) => {
    const pathWrap = pathCol.querySelector('.path-wrap .path-item');
    const pathItemText = pathColumnTitle(pathWrap);
    const firstLabel = pathCol.querySelector('h3.boxlabel');
    const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
    const colTitle = pathItemText || firstLabelText || 'Woche ' + (idx + 1);
    const boxEls = pathCol.querySelectorAll('.box-item');
    let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
    cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
    if (cards.length > 0) columns.push({ title: colTitle, cards });
  });
  if (columns.length === 0) return parsePinboard(document, usedNames);
  return columns;
}

function parseStickerwall(document, usedNames) {
  const pathCols = document.querySelectorAll('.path-column');
  if (pathCols.length > 1) {
    const columns = [];
    pathCols.forEach((pathCol, idx) => {
      const pathItem = pathCol.querySelector('.path-item');
      const pathItemText = pathColumnTitle(pathItem);
      const firstLabel = pathCol.querySelector('h3.boxlabel');
      const firstLabelText = firstLabel ? firstLabel.textContent.trim() : '';
      const colTitle = pathItemText || firstLabelText || 'Gruppe ' + (idx + 1);
      const boxEls = pathCol.querySelectorAll('.box-item');
      let cards = Array.from(boxEls).map(b => parseBox(b, usedNames)).filter(c => c.title || c.elements.length > 0);
      cards = dedupeFirstCardTitle(cards, !pathItemText && !!firstLabelText);
      if (cards.length > 0) columns.push({ title: colTitle, cards });
    });
    if (columns.length > 0) return columns;
  }
  return parsePinboard(document, usedNames);
}

function parseDocument(document, pathname) {
  const usedNames = new Set();
  const boardType = detectBoardType(pathname);
  const boardTitle = getBoardTitle(document);
  let columns;
  if (boardType === 'timeline')         columns = parseTimeline(document, usedNames);
  else if (boardType === 'stickerwall') columns = parseStickerwall(document, usedNames);
  else                                  columns = parsePinboard(document, usedNames);
  return { columns, boardTitle, boardType };
}

	const api = { buildExport, collectMediaUrls, injectFileData, stripInternalFields, parseDocument };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.edumapsParser = api;
})();
