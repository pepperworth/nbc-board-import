'use strict';

// Regressionstest fuer den Bug, der eine hochgeladene PDF unbrauchbar
// gemacht hat: chrome.runtime.sendMessage serialisiert NICHT per
// structured clone -- ein rohes ArrayBuffer kam beim Empfaenger als
// leeres Objekt an, ohne Fehler, nur mit stillschweigend kaputten Bytes.
// arrayBufferToBase64 (background.js) + base64ToBytes (lib/exporter.js)
// sind der Fix; dieser Test haelt den Round-Trip fest.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadScript } = require('./harness');

createSandbox();
// background.js registriert beim Laden echte chrome.*-Listener -- fuer den
// Test genuegt ein Stub, der nicht wirft.
global.chrome = {
	runtime: { onMessage: { addListener: () => {} }, onInstalled: { addListener: () => {} } },
	tabs: { query: async () => [] },
	scripting: { executeScript: async () => {} },
};
loadScript('background.js');
// background.js ist ein klassisches (nicht-strict) Script ohne IIFE --
// Top-Level-Funktionen landen dadurch wie in einem echten Service Worker
// auf dem globalen Objekt und sind hier direkt aufrufbar.
const { arrayBufferToBase64 } = global;

function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

test('arrayBufferToBase64 + base64ToBytes: Round-Trip erhaelt beliebige Byte-Werte (0-255)', () => {
	const original = new Uint8Array(256);
	for (let i = 0; i < 256; i += 1) original[i] = i;
	const base64 = arrayBufferToBase64(original.buffer);
	const roundTripped = base64ToBytes(base64);
	assert.deepEqual(Array.from(roundTripped), Array.from(original));
});

test('Round-Trip funktioniert ueber Chunk-Grenzen hinweg (grosse Datei)', () => {
	// chunkSize in arrayBufferToBase64 ist 0x8000 -- ueber mehrere Chunks
	// testen, damit ein Off-by-one an der Grenze nicht durchrutscht.
	const size = 0x8000 * 2 + 17;
	const original = new Uint8Array(size);
	for (let i = 0; i < size; i += 1) original[i] = (i * 7) % 256;
	const roundTripped = base64ToBytes(arrayBufferToBase64(original.buffer));
	assert.equal(roundTripped.length, size);
	assert.deepEqual(Array.from(roundTripped), Array.from(original));
});

test('leerer Buffer ergibt leeren Base64-String', () => {
	assert.equal(arrayBufferToBase64(new ArrayBuffer(0)), '');
});
