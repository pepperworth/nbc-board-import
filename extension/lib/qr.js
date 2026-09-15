// QR-Code-Rendering für Edumaps-QR-Widgets.
//
// Edumaps baut QR-Codes clientseitig aus einem data-url-Inhalt; die NBC hat
// kein QR-Element, also rendert nbcimport (app/importers/edumaps.py,
// _render_qrcode_png, per segno) das PNG serverseitig und legt es als
// inline Datei-Element an. Segno ist nicht ohne Bundler im Browser
// nutzbar, deshalb vendort diese Erweiterung stattdessen den MIT-lizenzierten
// "qrcode-generator" von Kazuhiko Arase (lib/vendor/qrcode-core.js +
// qrcode-utf8.js -- Basis + UTF-8-Encoder-Override, definiert global
// `qrcode`).
//
// Parameter an das Python-Original angelehnt (edumaps.py): Fehlerkorrektur
// M, Zellgrösse 10px, Rand 4 Module.
(function () {
	'use strict';

	const ERROR_CORRECTION_LEVEL = 'M';
	const CELL_SIZE = 10;
	const MARGIN_MODULES = 4;

	/**
	 * Rendert einen QR-Code als PNG-Blob.
	 *
	 * @param {string} content  Inhalt des QR-Codes (URL, Text, ...)
	 * @returns {Promise<Blob>} image/png
	 */
	async function renderQrCodePng(content) {
		if (typeof self.qrcode === 'undefined') {
			throw new Error('qrcode-generator ist nicht geladen -- lib/qr.js braucht lib/vendor/qrcode-core.js + qrcode-utf8.js davor.');
		}
		// typeNumber 0 = automatische Grössenwahl (kleinste Version, die den
		// Inhalt fasst) -- entspricht dem Python-Default von segno.
		const qr = self.qrcode(0, ERROR_CORRECTION_LEVEL);
		qr.addData(content);
		qr.make();

		const moduleCount = qr.getModuleCount();
		const size = moduleCount * CELL_SIZE + MARGIN_MODULES * CELL_SIZE * 2;

		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, size, size);
		ctx.fillStyle = '#000000';

		const offset = MARGIN_MODULES * CELL_SIZE;
		for (let row = 0; row < moduleCount; row += 1) {
			for (let col = 0; col < moduleCount; col += 1) {
				if (qr.isDark(row, col)) {
					ctx.fillRect(offset + col * CELL_SIZE, offset + row * CELL_SIZE, CELL_SIZE, CELL_SIZE);
				}
			}
		}

		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (blob) resolve(blob);
				else reject(new Error('QR-Code konnte nicht als PNG gerendert werden.'));
			}, 'image/png');
		});
	}

	const api = { renderQrCodePng };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.qr = api;
})();
