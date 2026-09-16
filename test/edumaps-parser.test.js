'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, loadScript } = require('./harness');

createSandbox();
loadScript('lib/colors.js');
loadScript('lib/edumaps-parser.js');
const { parseDocument, buildExport } = global.NBCImport.edumapsParser;

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'pinboard.html'), 'utf8');

function parseFixture() {
	const doc = new DOMParser().parseFromString(html, 'text/html');
	// Pinboard-Typ: kein numerischer Pfadbestandteil -> detectBoardType
	// liefert null -> parseDocument faellt auf parsePinboard zurueck (Default).
	return parseDocument(doc, '/board/pinboard');
}

test('parseDocument liest den Boardtitel aus h1.mapeditor-headline', () => {
	const { boardTitle } = parseFixture();
	assert.equal(boardTitle, 'Mein Testboard');
});

test('parseDocument baut zwei Spalten aus path-column mit path-item-Titeln', () => {
	const { columns } = parseFixture();
	assert.equal(columns.length, 2);
	assert.equal(columns[0].title, 'Spalte Eins');
	assert.equal(columns[1].title, 'Spalte Zwei');
});

// Regression: der Spalten-Header (.path-item h2.pathhead) enthaelt neben
// dem Titel (span.pathlabel) einen Karten-Anzahl-Badge
// (span.pathboxcount-badge). Reines .textContent haengt beide zusammen --
// aus "Spalte Eins" + Badge "2" wurde faelschlich "Spalte Eins2". Die
// Fixture bildet dieses reale Markup nach (siehe fixtures/pinboard.html);
// dieser Test macht die Erwartung explizit und benennt den Bug.
test('Spaltentitel enthaelt NICHT den Karten-Anzahl-Badge aus dem Header', () => {
	const { columns } = parseFixture();
	assert.equal(columns[0].title, 'Spalte Eins');
	assert.ok(!columns[0].title.includes('2'), `Titel "${columns[0].title}" enthaelt den Badge-Text`);
});

test('Spaltentitel-Fallback: ohne span.pathlabel wird der Badge-Text trotzdem entfernt', () => {
	const doc = new DOMParser().parseFromString(`<!doctype html><body>
		<h1>Fallback-Board</h1>
		<div class="map-content-wrap">
			<div class="path-column">
				<div class="path-item"><h2 class="pathhead">Nur Titel<span class="pathboxcount-badge">4</span></h2></div>
				<div class="box-item"><h3 class="boxlabel">Karte</h3></div>
			</div>
			<div class="path-column">
				<div class="path-item"><h2 class="pathhead">Zweite<span class="pathboxcount-badge">1</span></h2></div>
				<div class="box-item"><h3 class="boxlabel">Karte 2</h3></div>
			</div>
		</div>
	</body>`, 'text/html');
	const { columns } = parseDocument(doc, '/board/pinboard');
	assert.equal(columns[0].title, 'Nur Titel');
});

test('parseBox liest den Kartentitel aus h3.boxlabel', () => {
	const { columns } = parseFixture();
	assert.equal(columns[0].cards[0].title, 'Karte Eins');
	assert.equal(columns[1].cards[0].title, 'Karte Zwei');
});

test('parseBox mapped die Titel-Hintergrundfarbe auf eine NBC-Farbe', () => {
	const { columns } = parseFixture();
	const card = columns[0].cards[0];
	assert.equal(card.backgroundColorRaw, '#4caf50');
	assert.equal(card.backgroundColor, 'green');
});

test('parseBox extrahiert Text- und Link-Elemente in Lesereihenfolge', () => {
	const { columns } = parseFixture();
	const card = columns[0].cards[0];
	const types = card.elements.map((e) => e.type);
	assert.deepEqual(types, ['text', 'link']);
	assert.ok(card.elements[0].content.includes('Hallo'));
	assert.ok(card.elements[0].content.includes('<b>Welt</b>'));
	assert.equal(card.elements[1].url, 'https://example.org');
	assert.equal(card.elements[1].title, 'Beispiel');
});

test('parseBox liest reinen Text ohne Markup ebenfalls als Text-Element', () => {
	const { columns } = parseFixture();
	const card = columns[1].cards[0];
	assert.equal(card.elements.length, 1);
	assert.equal(card.elements[0].type, 'text');
	assert.ok(card.elements[0].content.includes('Reiner Text'));
});

test('buildExport zaehlt Spalten/Karten/Elemente korrekt', () => {
	const { columns, boardTitle } = parseFixture();
	const exportData = buildExport(columns, boardTitle);
	assert.equal(exportData.totalColumns, 2);
	assert.equal(exportData.totalCards, 2);
	assert.equal(exportData.totalLinks, 1);
	assert.equal(exportData.totalCardsColored, 1);
});
