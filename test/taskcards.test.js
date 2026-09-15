'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadScript } = require('./harness');

createSandbox();
loadScript('lib/vendor/purify.min.js');
loadScript('lib/colors.js');
loadScript('lib/sanitize.js');
loadScript('lib/taskcards.js');
const { parseBoardLink, mapBoard } = global.NBCImport.taskcards;

test('parseBoardLink erkennt Pfad-Board-URLs', () => {
	const link = parseBoardLink('https://www.taskcards.de/#/board/3fa85f64-5717-4562-b3fc-2c963f66afa6');
	assert.ok(link);
	assert.equal(link.boardId, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
	assert.equal(link.token, '');
	assert.equal(link.baseUrl, 'https://www.taskcards.de');
});

test('parseBoardLink liest Token aus der Hash-Query', () => {
	const link = parseBoardLink('https://www.taskcards.de/#/board/3fa85f64-5717-4562-b3fc-2c963f66afa6?token=abc123');
	assert.ok(link);
	assert.equal(link.token, 'abc123');
});

test('parseBoardLink lehnt Nicht-Taskcards-URLs ab', () => {
	assert.equal(parseBoardLink('https://example.org/board/3fa85f64-5717-4562-b3fc-2c963f66afa6'), null);
	assert.equal(parseBoardLink('nicht-mal-eine-url'), null);
});

test('parseBoardLink akzeptiert Subdomains und .app', () => {
	assert.ok(parseBoardLink('https://schule.taskcards.app/board/3fa85f64-5717-4562-b3fc-2c963f66afa6'));
});

function kanbanBoard() {
	return {
		id: 'b1',
		name: 'Mein Board',
		type: 0,
		description: null,
		lists: [
			{ id: 'l1', name: 'To Do', position: 1 },
			{ id: 'l2', name: 'Fertig', position: 2 },
		],
		cards: [
			{
				id: 'c1', title: 'Karte A', description: '<p>Beschreibung</p>', link: 'https://example.org',
				color: '#4caf50', kanbanPosition: { listId: 'l1', position: 1 },
				attachments: [{ filename: 'foto.png', mimetype: 'image/png', length: 1024, downloadLink: 'https://cdn.example.org/foto.png' }],
				comments: [], created: 1,
			},
			{
				id: 'c2', title: 'Karte B', description: null, kanbanPosition: { listId: 'l2', position: 1 },
				attachments: [], comments: [], created: 2,
			},
		],
	};
}

test('mapBoard: Kanban-Board wird zu Spalten aus lists[]', () => {
	const out = mapBoard(kanbanBoard(), 'https://www.taskcards.de/#/board/x');
	assert.equal(out.boardTitle, 'Mein Board');
	assert.equal(out.layout, 'columns');
	assert.equal(out.columns.length, 2);
	assert.equal(out.columns[0].title, 'To Do');
	assert.equal(out.columns[0].cards.length, 1);
	assert.equal(out.columns[0].cards[0].title, 'Karte A');
});

test('mapBoard: Karte bekommt Text-, Link- und Datei-Element in stabiler Reihenfolge', () => {
	const out = mapBoard(kanbanBoard(), 'https://www.taskcards.de/#/board/x');
	const card = out.columns[0].cards[0];
	const types = card.elements.map((e) => e.type);
	assert.deepEqual(types, ['text', 'link', 'file']);
	assert.equal(card.elements[2].fileName, 'foto.png');
	assert.equal(card.elements[2]._originalUrl, 'https://cdn.example.org/foto.png');
});

test('mapBoard: Kartenfarbe wird auf NBC-Farbe gemappt', () => {
	const out = mapBoard(kanbanBoard(), 'https://www.taskcards.de/#/board/x');
	const card = out.columns[0].cards[0];
	assert.equal(card.backgroundColorRaw, '#4caf50');
	assert.equal(card.backgroundColor, 'green');
});

test('mapBoard: Anhang ohne Download-Link wird zu Hinweistext statt Datei-Element', () => {
	const board = kanbanBoard();
	board.cards[0].attachments = [{ filename: 'geheim.pdf' }];
	const out = mapBoard(board, 'x');
	const card = out.columns[0].cards[0];
	const fileEl = card.elements.find((e) => e.type === 'file');
	assert.equal(fileEl, undefined);
	const textEls = card.elements.filter((e) => e.type === 'text');
	assert.ok(textEls.some((e) => e.content.includes('geheim.pdf')));
});

test('mapBoard: Timeline-Layout erzeugt eine Spalte pro Karte, sortiert nach Position', () => {
	const board = {
		id: 'b2', name: 'Zeitstrahl', type: 1,
		cards: [
			{ id: 'c1', title: 'Zweitens', timeLinePosition: { position: 2 }, attachments: [], comments: [] },
			{ id: 'c2', title: 'Erstens', timeLinePosition: { position: 1 }, attachments: [], comments: [] },
		],
	};
	const out = mapBoard(board, 'x');
	assert.equal(out.columns.length, 2);
	assert.equal(out.columns[0].cards[0].title, 'Erstens');
	assert.equal(out.columns[1].cards[0].title, 'Zweitens');
});

test('mapBoard: unbekannter board.type wirft einen Fehler', () => {
	assert.throws(() => mapBoard({ id: 'b3', name: 'X', type: 99, cards: [] }, 'x'));
});

test('mapBoard: Board-Beschreibung wird als erste Karte in der ersten Spalte eingefuegt', () => {
	const board = kanbanBoard();
	board.description = '<p>Boardbeschreibung</p>';
	const out = mapBoard(board, 'x');
	assert.equal(out.columns[0].cards[0].title, 'Beschreibung');
});
