// Test-Harness: lädt die extension/lib/*.js -- klassische Scripts, die
// sich window.NBCImport teilen -- in einer jsdom-Umgebung, in der `self`,
// `window` und `globalThis` (wie im echten Content-Script) dasselbe Objekt
// sind. Kein Bundler, kein Transpile -- die Dateien laufen unverändert.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');

function createSandbox({ url } = {}) {
	const dom = new JSDOM('<!doctype html><html><body></body></html>', {
		url: url || 'https://niedersachsen.cloud/rooms/000000000000000000000001',
	});
	const { window } = dom;
	global.document = window.document;
	// DOMPurify feature-detektiert breit (Element, SVGElement, MathMLElement,
	// HTMLTemplateElement, NodeFilter, ...) -- statt jeden Konstruktor
	// einzeln zu benennen, kopieren wir alle Konstruktor-artigen Globals
	// (Grossbuchstabe am Anfang) von jsdoms window auf den echten Node-
	// global, wie sie in einem echten Content-Script ohnehin vorhanden
	// waeren. `Blob`/`navigator` bleiben Node-eigen (read-only Getter).
	for (const key of Object.getOwnPropertyNames(window)) {
		if (key === 'Blob' || key === 'navigator') continue;
		if (!/^[A-Z]/.test(key)) continue;
		try {
			global[key] = window[key];
		} catch {
			// Ein paar wenige (z.B. bereits als Getter definierte) ueberspringen.
		}
	}
	// `Blob`/`navigator` existieren bereits nativ in Node >= 18 und sind
	// dort read-only Getter -- die Node-eigenen reichen für die Tests.
	// location/URL/URLSearchParams: Node-eigene Implementierungen reichen
	// und vermeiden jsdom-Navigation-Nebenwirkungen.
	global.location = window.location;
	global.window = global;
	global.self = global;
	global.NBCImport = {};
	return dom;
}

function loadScript(relPath) {
	const full = path.join(EXTENSION_DIR, relPath);
	const code = fs.readFileSync(full, 'utf8');
	vm.runInThisContext(code, { filename: full });
}

module.exports = { createSandbox, loadScript };
