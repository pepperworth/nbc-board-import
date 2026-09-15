'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadScript } = require('./harness');

createSandbox();
loadScript('lib/colors.js');
const { hexToNbcColor } = global.NBCImport.colors;

test('leerer/ungueltiger Wert liefert null', () => {
	assert.equal(hexToNbcColor(null), null);
	assert.equal(hexToNbcColor(''), null);
	assert.equal(hexToNbcColor('nicht-hex'), null);
});

test('transparent bleibt transparent', () => {
	assert.equal(hexToNbcColor('transparent'), 'transparent');
	assert.equal(hexToNbcColor('TRANSPARENT'), 'transparent');
});

test('weisse/nahezu-weisse Werte werden zu transparent', () => {
	assert.equal(hexToNbcColor('#ffffff'), 'transparent');
	assert.equal(hexToNbcColor('#fefefe'), 'transparent');
	assert.equal(hexToNbcColor('#fafafa'), 'transparent'); // sehr helles Grau, isWhiteish faengt es ab
});

test('3-stelliges Hex wird wie 6-stelliges behandelt', () => {
	assert.equal(hexToNbcColor('#0f0'), hexToNbcColor('#00ff00'));
});

test('exakte Palette-Anker mappen auf sich selbst', () => {
	assert.equal(hexToNbcColor('#4caf50'), 'green');
	assert.equal(hexToNbcColor('#2196f3'), 'blue');
	assert.equal(hexToNbcColor('#9c27b0'), 'purple');
});

test('nur die 11 im NBC-Client sichtbaren Farben werden als Ziel benutzt', () => {
	// yellow/orange/red/teal/lime/brown/grey/deepPurple/lightBlue/lime sind
	// NICHT im Picker -- fuer Werte, die dort eindeutig hinfallen wuerden,
	// muss stattdessen eine sichtbare Nachbarfarbe rauskommen.
	const nonPicker = new Set(['red', 'yellow', 'orange', 'teal', 'lime', 'brown', 'grey', 'deepPurple', 'lightBlue']);
	for (const hex of ['#f44336', '#ffeb3b', '#ff9800', '#009688', '#cddc39', '#795548', '#616161', '#673ab7', '#03a9f4']) {
		const result = hexToNbcColor(hex);
		assert.ok(!nonPicker.has(result), `${hex} -> ${result} sollte nicht auf eine unsichtbare Farbe fallen`);
	}
});
