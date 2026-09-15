// Hex-Farbe -> NBC-CardColor.
//
// Quellen wie Taskcards liefern Karten-Hintergrundfarben als freie 24-bit-
// Hex-Werte (z.B. "#dd3c3c"). Die NBC-API akzeptiert nur eine geschlossene
// Palette von 20 Werten. Diese Datei bildet beliebige Hex-Werte auf den
// nächstliegenden Paletten-Wert ab -- perzeptuelle Distanz im CIE-Lab-Raum,
// weil RGB-Distanz bei Mittel-/Hellbereich systematisch danebenliegt.
//
// Port von nbcimport (app/pipeline/colors.py + app/nbc/colors.py). Basis war
// die JS-Fassung aus edumaps-import/edumaps-parser.js, hier ergänzt um eine
// Erkenntnis aus dem Python-Original, die dort fehlte:
//
// Das CardColor-Enum der NBC-API hat 20 Werte, aber der Nuxt-Client rendert
// nur 11 davon in seiner Picker-Liste (DEFAULT_COLORS in
// nuxt-client/src/utils/color.utils.ts). Für jeden anderen Wert liefert der
// Farb-Lookup dort "undefined", und die Karte sieht im UI komplett
// uneingefärbt aus -- der Server speichert den Wert klaglos, nur sichtbar
// wird er nie. Deshalb bildet PICKER_COLORS die Zielmenge und filtert die
// Ankerliste, bevor die Nearest-Neighbour-Suche läuft.
(function () {
	'use strict';

	const CARD_COLORS = [
		'transparent', 'red', 'pink', 'purple', 'deepPurple', 'indigo', 'blue',
		'lightBlue', 'cyan', 'teal', 'green', 'lightGreen', 'lime', 'yellow',
		'amber', 'orange', 'deepOrange', 'brown', 'grey', 'blueGrey',
	];

	// Nur diese 11 werden vom NBC-Client tatsächlich gerendert -- siehe
	// Kommentar oben. Lieber eine minimale Farbtonverschiebung (RED -> PINK)
	// als eine unsichtbar eingefärbte Karte.
	const PICKER_COLORS = new Set([
		'transparent', 'lightGreen', 'green', 'cyan', 'blue', 'indigo',
		'purple', 'pink', 'deepOrange', 'amber', 'blueGrey',
	]);

	// Alle 10 Vuetify-Schattierungen (lighten5..1, base, darken1..4) je
	// CardColor als Ankerpunkte -- Quellen wie Taskcards nutzen für
	// Kartenhintergründe meist Pastelltöne, die in CIE-Lab nahe an Unbunt
	// liegen. Mit nur der Base-Farbe als Anker würde die Suche für Pastelle
	// fast immer GREY liefern; mit allen Schattierungen findet sie den
	// korrekten Farbton unabhängig von der Helligkeit der Quelle.
	const PALETTE_ANCHORS = [
		['red', '#ffebee'], ['red', '#ffcdd2'], ['red', '#ef9a9a'],
		['red', '#e57373'], ['red', '#ef5350'], ['red', '#f44336'],
		['red', '#e53935'], ['red', '#d32f2f'], ['red', '#c62828'],
		['red', '#b71c1c'],
		['pink', '#fce4ec'], ['pink', '#f8bbd0'], ['pink', '#f48fb1'],
		['pink', '#f06292'], ['pink', '#ec407a'], ['pink', '#e91e63'],
		['pink', '#d81b60'], ['pink', '#c2185b'], ['pink', '#ad1457'],
		['pink', '#880e4f'],
		['purple', '#f3e5f5'], ['purple', '#e1bee7'], ['purple', '#ce93d8'],
		['purple', '#ba68c8'], ['purple', '#ab47bc'], ['purple', '#9c27b0'],
		['purple', '#8e24aa'], ['purple', '#7b1fa2'], ['purple', '#6a1b9a'],
		['purple', '#4a148c'],
		['deepPurple', '#ede7f6'], ['deepPurple', '#d1c4e9'], ['deepPurple', '#b39ddb'],
		['deepPurple', '#9575cd'], ['deepPurple', '#7e57c2'], ['deepPurple', '#673ab7'],
		['deepPurple', '#5e35b1'], ['deepPurple', '#512da8'], ['deepPurple', '#4527a0'],
		['deepPurple', '#311b92'],
		['indigo', '#e8eaf6'], ['indigo', '#c5cae9'], ['indigo', '#9fa8da'],
		['indigo', '#7986cb'], ['indigo', '#5c6bc0'], ['indigo', '#3f51b5'],
		['indigo', '#3949ab'], ['indigo', '#303f9f'], ['indigo', '#283593'],
		['indigo', '#1a237e'],
		['blue', '#e3f2fd'], ['blue', '#bbdefb'], ['blue', '#90caf9'],
		['blue', '#64b5f6'], ['blue', '#42a5f5'], ['blue', '#2196f3'],
		['blue', '#1e88e5'], ['blue', '#1976d2'], ['blue', '#1565c0'],
		['blue', '#0d47a1'],
		['lightBlue', '#e1f5fe'], ['lightBlue', '#b3e5fc'], ['lightBlue', '#81d4fa'],
		['lightBlue', '#4fc3f7'], ['lightBlue', '#29b6f6'], ['lightBlue', '#03a9f4'],
		['lightBlue', '#039be5'], ['lightBlue', '#0288d1'], ['lightBlue', '#0277bd'],
		['lightBlue', '#01579b'],
		['cyan', '#e0f7fa'], ['cyan', '#b2ebf2'], ['cyan', '#80deea'],
		['cyan', '#4dd0e1'], ['cyan', '#26c6da'], ['cyan', '#00bcd4'],
		['cyan', '#00acc1'], ['cyan', '#0097a7'], ['cyan', '#00838f'],
		['cyan', '#006064'],
		['teal', '#e0f2f1'], ['teal', '#b2dfdb'], ['teal', '#80cbc4'],
		['teal', '#4db6ac'], ['teal', '#26a69a'], ['teal', '#009688'],
		['teal', '#00897b'], ['teal', '#00796b'], ['teal', '#00695c'],
		['teal', '#004d40'],
		['green', '#e8f5e9'], ['green', '#c8e6c9'], ['green', '#a5d6a7'],
		['green', '#81c784'], ['green', '#66bb6a'], ['green', '#4caf50'],
		['green', '#43a047'], ['green', '#388e3c'], ['green', '#2e7d32'],
		['green', '#1b5e20'],
		['lightGreen', '#f1f8e9'], ['lightGreen', '#dcedc8'], ['lightGreen', '#c5e1a5'],
		['lightGreen', '#aed581'], ['lightGreen', '#9ccc65'], ['lightGreen', '#8bc34a'],
		['lightGreen', '#7cb342'], ['lightGreen', '#689f38'], ['lightGreen', '#558b2f'],
		['lightGreen', '#33691e'],
		['lime', '#f9fbe7'], ['lime', '#f0f4c3'], ['lime', '#e6ee9c'],
		['lime', '#dce775'], ['lime', '#d4e157'], ['lime', '#cddc39'],
		['lime', '#c0ca33'], ['lime', '#afb42b'], ['lime', '#9e9d24'],
		['lime', '#827717'],
		['yellow', '#fffde7'], ['yellow', '#fff9c4'], ['yellow', '#fff59d'],
		['yellow', '#fff176'], ['yellow', '#ffee58'], ['yellow', '#ffeb3b'],
		['yellow', '#fdd835'], ['yellow', '#fbc02d'], ['yellow', '#f9a825'],
		['yellow', '#f57f17'],
		['amber', '#fff8e1'], ['amber', '#ffecb3'], ['amber', '#ffe082'],
		['amber', '#ffd54f'], ['amber', '#ffca28'], ['amber', '#ffc107'],
		['amber', '#ffb300'], ['amber', '#ffa000'], ['amber', '#ff8f00'],
		['amber', '#ff6f00'],
		['orange', '#fff3e0'], ['orange', '#ffe0b2'], ['orange', '#ffcc80'],
		['orange', '#ffb74d'], ['orange', '#ffa726'], ['orange', '#ff9800'],
		['orange', '#fb8c00'], ['orange', '#f57c00'], ['orange', '#ef6c00'],
		['orange', '#e65100'],
		['deepOrange', '#fbe9e7'], ['deepOrange', '#ffccbc'], ['deepOrange', '#ffab91'],
		['deepOrange', '#ff8a65'], ['deepOrange', '#ff7043'], ['deepOrange', '#ff5722'],
		['deepOrange', '#f4511e'], ['deepOrange', '#e64a19'], ['deepOrange', '#d84315'],
		['deepOrange', '#bf360c'],
		['brown', '#efebe9'], ['brown', '#d7ccc8'], ['brown', '#bcaaa4'],
		['brown', '#a1887f'], ['brown', '#8d6e63'], ['brown', '#795548'],
		['brown', '#6d4c41'], ['brown', '#5d4037'], ['brown', '#4e342e'],
		['brown', '#3e2723'],
		// grey -- die hellsten Schattierungen fehlen absichtlich; isWhiteish()
		// faengt sie vorher ab und liefert "transparent".
		['grey', '#eeeeee'], ['grey', '#e0e0e0'], ['grey', '#bdbdbd'],
		['grey', '#9e9e9e'], ['grey', '#757575'], ['grey', '#616161'],
		['grey', '#424242'], ['grey', '#212121'],
		['blueGrey', '#eceff1'], ['blueGrey', '#cfd8dc'], ['blueGrey', '#b0bec5'],
		['blueGrey', '#90a4ae'], ['blueGrey', '#78909c'], ['blueGrey', '#607d8b'],
		['blueGrey', '#546e7a'], ['blueGrey', '#455a64'], ['blueGrey', '#37474f'],
		['blueGrey', '#263238'],
	];

	function parseHex(value) {
		const s = String(value || '').trim();
		if (!s) return null;
		const m6 = s.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
		if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
		const m3 = s.match(/^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/);
		if (m3) return m3.slice(1).map((c) => parseInt(c + c, 16));
		return null;
	}

	function srgbToLinear(c) {
		const x = c / 255;
		return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
	}

	function rgbToLab(r, g, b) {
		const rl = srgbToLinear(r);
		const gl = srgbToLinear(g);
		const bl = srgbToLinear(b);
		// sRGB -> XYZ (D65)
		const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
		const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.0;
		const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
		const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
		const fx = f(x);
		const fy = f(y);
		const fz = f(z);
		return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
	}

	// Nur Picker-Farben als Anker -- alles andere waere im Client unsichtbar.
	const PALETTE_LAB = PALETTE_ANCHORS
		.filter(([name]) => PICKER_COLORS.has(name))
		.map(([name, hex]) => [name, rgbToLab(...parseHex(hex))]);

	// Taskcards nutzt "#ffffff" als Spalten-/Karten-Default. Weiss hat in der
	// NBC-Palette keine Entsprechung; die naechstliegende Wahl (GREY) waere
	// sichtbar grau, also kippen wir es auf TRANSPARENT.
	function isWhiteish([r, g, b]) {
		return Math.min(r, g, b) >= 240 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;
	}

	/**
	 * Ordnet eine Hex-Farbe der naechsten NBC-CardColor zu.
	 *
	 * @param {string|null|undefined} value  "#rgb", "#rrggbb" oder "transparent"
	 * @returns {string|null} CardColor-Wert oder null bei leerem/unparsbarem Input
	 */
	function hexToNbcColor(value) {
		if (value == null) return null;
		const s = String(value).trim().toLowerCase();
		if (!s) return null;
		if (s === 'transparent') return 'transparent';
		const rgb = parseHex(s);
		if (rgb === null) return null;
		if (isWhiteish(rgb)) return 'transparent';
		const target = rgbToLab(...rgb);
		let best = null;
		let bestD2 = Infinity;
		for (const [name, lab] of PALETTE_LAB) {
			const dl = target[0] - lab[0];
			const da = target[1] - lab[1];
			const db = target[2] - lab[2];
			const d2 = dl * dl + da * da + db * db;
			if (d2 < bestD2) {
				bestD2 = d2;
				best = name;
			}
		}
		return best;
	}

	const api = { hexToNbcColor, CARD_COLORS, PICKER_COLORS };
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	} else {
		self.NBCImport = self.NBCImport || {};
		self.NBCImport.colors = api;
	}
})();
