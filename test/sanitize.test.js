'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSandbox, loadScript } = require('./harness');

createSandbox();
loadScript('lib/vendor/purify.min.js');
loadScript('lib/sanitize.js');
const { normalizeRichText, sanitizeRichTextFragment } = global.NBCImport.sanitize;

test('reiner Text wird in <p> gewrappt und Zeilenumbrueche zu <br>', () => {
	assert.equal(normalizeRichText('Zeile 1\nZeile 2'), '<p>Zeile 1<br>Zeile 2</p>');
});

test('reiner Text wird HTML-escaped', () => {
	assert.equal(normalizeRichText('3 < 5 & 5 > 3'), '<p>3 &lt; 5 &amp; 5 &gt; 3</p>');
});

test('Text, der wie HTML aussieht (Tag-Syntax), nimmt den Sanitize-Pfad -- <script> verschwindet komplett', () => {
	// looksLikeHtml() erkennt "<script>...</script>" an der Tag-Syntax und
	// routet auf sanitizeRichTextFragment statt auf reines Escaping --
	// identisch zum Python-Original (regex </?[a-z][\s\S]*>).
	assert.equal(normalizeRichText('<script>alert(1)</script>'), '');
});

test('script/style/iframe werden komplett entfernt (samt Inhalt)', () => {
	const out = normalizeRichText('<p>vor</p><script>evil()</script><iframe src="x"></iframe><p>nach</p>');
	assert.ok(!out.includes('evil'));
	assert.ok(!out.includes('iframe'));
	assert.ok(out.includes('vor'));
	assert.ok(out.includes('nach'));
});

test('nicht erlaubte, ungefaehrliche Tags werden entfernt, Inhalt bleibt (unwrap)', () => {
	const out = normalizeRichText('<marquee>Text</marquee>');
	assert.ok(!out.includes('marquee'));
	assert.ok(out.includes('Text'));
});

test('erlaubte Tags/Attribute bleiben erhalten', () => {
	const out = sanitizeRichTextFragment('<p>Hallo <strong>Welt</strong></p>');
	assert.equal(out, '<p>Hallo <strong>Welt</strong></p>');
});

test('a ohne href wird unwrapped (required attr fehlt)', () => {
	const out = sanitizeRichTextFragment('<a>Linktext</a>');
	assert.ok(!out.includes('<a'));
	assert.ok(out.includes('Linktext'));
});

test('a mit http(s)-href bleibt, javascript:-href wird verworfen', () => {
	const good = sanitizeRichTextFragment('<a href="https://example.org">Link</a>');
	assert.ok(good.includes('href="https://example.org"'));

	const bad = sanitizeRichTextFragment('<a href="javascript:alert(1)">Link</a>');
	assert.ok(!bad.includes('javascript:'));
});

test('inline font-weight:bold wird zu <strong>', () => {
	const out = sanitizeRichTextFragment('<span style="font-weight:bold">fett</span>');
	assert.ok(out.includes('<strong>'));
	assert.ok(out.includes('fett'));
});

test('style wird auf color/background-color/font-size geklemmt', () => {
	const out = sanitizeRichTextFragment('<p style="color:#ff0000;position:absolute;font-size:14px">x</p>');
	assert.ok(out.includes('color:#ff0000'));
	assert.ok(!out.includes('position'));
	assert.ok(out.includes('font-size:14px'));
});

test('font-size ausserhalb des erlaubten Bereichs wird verworfen', () => {
	const out = sanitizeRichTextFragment('<p style="font-size:999px">x</p>');
	assert.ok(!out.includes('font-size'));
});

test('img ohne https-src wird unwrapped', () => {
	const out = sanitizeRichTextFragment('<img src="http://example.org/x.png" alt="a">');
	assert.ok(!out.includes('<img'));
});

test('img mit https-src bleibt', () => {
	const out = sanitizeRichTextFragment('<img src="https://example.org/x.png" alt="a">');
	assert.ok(out.includes('<img'));
	assert.ok(out.includes('src="https://example.org/x.png"'));
});

test('DOMPurify-Schlusspass faengt mXSS-artige Konstrukte ab, die der Walk allein durchliesse', () => {
	const out = sanitizeRichTextFragment('<p><img src="https://example.org/x.png" onerror="alert(1)"></p>');
	assert.ok(!out.includes('onerror'));
});
