// RichText-Sanitizer für Taskcards- und Edumaps-Importe.
//
// Port von nbcimport (app/importers/rich_text_sanitizer.py). Der Python-
// Sanitizer ist ein *transformierender* Sanitizer -- er macht mehr als
// filtern: Inline-Style wird zu semantischen Tags (font-weight:bold ->
// <strong> usw.), CSS wird auf color/background-color/font-size geklemmt,
// und reiner Text wird in <p>/<br> gewrappt. Zum Schluss lief dort ein
// nh3-Pass (html5ever, dieselbe Parser-Engine wie der Browser) als
// browser-grade Sicherheitsschicht über das Ergebnis.
//
// Dieser Port spiegelt dieselbe Aufteilung: ein DOM-Walk übernimmt die
// NBC-spezifischen Transforms, DOMPurify (lib/vendor/purify.min.js, davor
// geladen) übernimmt die abschliessende Sicherheits-Autorität -- dieselbe
// Allowlist, eine einzige Quelle der Wahrheit.
(function () {
	'use strict';

	const SAFE_TAGS = {
		a: new Set(['href', 'title']),
		b: new Set(),
		blockquote: new Set(),
		br: new Set(),
		code: new Set(),
		div: new Set(['style']),
		em: new Set(),
		figure: new Set(['class']),
		figcaption: new Set(),
		h1: new Set(), h2: new Set(), h3: new Set(), h4: new Set(), h5: new Set(), h6: new Set(),
		i: new Set(),
		img: new Set(['src', 'alt', 'title', 'width', 'height', 'style']),
		li: new Set(['style']),
		ol: new Set(),
		p: new Set(['style']),
		pre: new Set(),
		s: new Set(),
		span: new Set(['style', 'class']),
		strong: new Set(),
		sub: new Set(),
		sup: new Set(),
		u: new Set(),
		ul: new Set(),
		table: new Set(),
		thead: new Set(), tbody: new Set(), tfoot: new Set(), tr: new Set(),
		th: new Set(['colspan', 'rowspan']),
		td: new Set(['colspan', 'rowspan']),
		caption: new Set(),
		video: new Set(['src', 'controls', 'width', 'height', 'poster']),
		audio: new Set(['src', 'controls']),
		source: new Set(['src', 'type']),
		math: new Set(['xmlns', 'display']),
		mrow: new Set(), mi: new Set(), mn: new Set(), mo: new Set(),
		msup: new Set(), msub: new Set(), mfrac: new Set(), msqrt: new Set(), mtext: new Set(),
	};

	const VOID_TAGS = new Set(['br', 'img', 'source']);
	const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed']);
	const REQUIRED_ATTRS = { a: ['href'], img: ['src'], source: ['src'] };
	const SAFE_CSS_PROPS = new Set(['color', 'background-color', 'font-size']);
	const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
	const RGB_COLOR_RE = /^rgba?\(\s*[\d.\s,%]+\s*\)$/i;
	const NAMED_COLOR_RE = /^[a-z][a-z\d-]{1,30}$/i;
	const FONT_SIZE_RE = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i;
	const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

	const FONT_SIZE_LIMITS = {
		px: [8.0, 48.0],
		pt: [6.0, 36.0],
		em: [0.5, 3.0],
		rem: [0.5, 3.0],
		'%': [50.0, 300.0],
	};

	function htmlEscape(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#x27;');
	}

	// Entspricht html.unescape(): dekodiert benannte + numerische Entities.
	function htmlUnescape(s) {
		const ta = document.createElement('textarea');
		ta.innerHTML = s;
		return ta.value;
	}

	function looksLikeHtml(raw) {
		return /<\/?[a-z][\s\S]*>/i.test(raw);
	}

	function tagsForInlineStyle(style) {
		const s = (style || '').toLowerCase();
		if (!s) return [];
		const tags = [];
		if (s.includes('font-weight') && (s.includes('bold') || /\b[6-9]\d{2}\b/.test(s))) tags.push('strong');
		if (s.includes('font-style') && s.includes('italic')) tags.push('em');
		if (s.includes('text-decoration') && s.includes('underline')) tags.push('u');
		if (s.includes('text-decoration') && s.includes('line-through')) tags.push('s');
		return tags;
	}

	function normalizeFontSize(value) {
		const raw = value.trim().toLowerCase();
		const m = FONT_SIZE_RE.exec(raw);
		if (!m) return '';
		const amount = parseFloat(m[1]);
		const unit = m[2].toLowerCase();
		const [low, high] = FONT_SIZE_LIMITS[unit];
		if (!(amount >= low && amount <= high)) return '';
		return `${m[1]}${unit}`;
	}

	function normalizeStyle(value) {
		const parts = [];
		for (const chunk of (value || '').split(';')) {
			const idx = chunk.indexOf(':');
			if (idx === -1) continue;
			const prop = chunk.slice(0, idx).trim().toLowerCase();
			let val = chunk.slice(idx + 1).trim();
			if (!SAFE_CSS_PROPS.has(prop)) continue;
			if (prop === 'font-size') {
				val = normalizeFontSize(val);
				if (!val) continue;
			} else if (!(HEX_COLOR_RE.test(val) || RGB_COLOR_RE.test(val) || NAMED_COLOR_RE.test(val))) {
				continue;
			}
			parts.push(`${prop}:${val}`);
		}
		return parts.join(';');
	}

	function parseUrlScheme(raw) {
		try {
			// Relative URLs (kein Schema) werfen -- das ist gewollt, die
			// NBC braucht ohnehin absolute Adressen.
			return new URL(raw);
		} catch {
			return null;
		}
	}

	function normalizeHref(value) {
		const raw = value.trim();
		const parsed = parseUrlScheme(raw);
		if (!parsed) return '';
		if (!SAFE_URL_SCHEMES.has(parsed.protocol)) return '';
		if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.host) return '';
		return raw;
	}

	function normalizeSrc(value) {
		const raw = value.trim();
		const parsed = parseUrlScheme(raw);
		if (!parsed) return '';
		if (parsed.protocol !== 'https:' || !parsed.host) return '';
		return raw;
	}

	function safeAttrs(tag, node) {
		const allowed = SAFE_TAGS[tag];
		const safe = [];
		for (const attr of Array.from(node.attributes || [])) {
			const name = attr.name.toLowerCase();
			if (!allowed.has(name)) continue;
			let value = attr.value || '';
			if (name === 'href') {
				value = normalizeHref(value);
				if (!value) continue;
			} else if (name === 'src' || name === 'poster') {
				value = normalizeSrc(value);
				if (!value) continue;
			} else if (name === 'style') {
				value = normalizeStyle(value);
				if (!value) continue;
			}
			safe.push([name, value]);
		}
		return safe;
	}

	// DOM-Walk: übernimmt die NBC-Transforms (Style -> semantische Tags,
	// CSS-Clamping, Escaping). Die Sicherheitsgarantie kommt danach von
	// DOMPurify, nicht von diesem Walk -- siehe Kommentar oben im Modul.
	function walk(node, parts, dropDepth) {
		if (node.nodeType === Node.TEXT_NODE) {
			if (dropDepth === 0) {
				const normalized = node.nodeValue.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
				parts.push(htmlEscape(normalized).replace(/\n/g, '<br>'));
			}
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const tag = node.tagName.toLowerCase();

		if (DROPPED_TAGS.has(tag)) {
			// Kompletter Unterbaum verworfen, kein Rekurs.
			return;
		}
		if (dropDepth > 0 || !SAFE_TAGS[tag]) {
			// Tag selbst nicht erlaubt (und nicht gefährlich) -- Inhalt
			// bleibt erhalten, der Wrapper fällt weg ("unwrap").
			for (const child of Array.from(node.childNodes)) walk(child, parts, dropDepth);
			return;
		}

		const styleAttr = node.getAttribute('style');
		const styleTags = tagsForInlineStyle(styleAttr);
		for (const t of styleTags) parts.push(`<${t}>`);

		const rendered = safeAttrs(tag, node);
		const required = REQUIRED_ATTRS[tag];
		const missingRequired = required && !required.every((name) => rendered.some(([n]) => n === name));

		if (missingRequired) {
			// Pflichtattribut fehlt (z.B. <a> ohne href) -- Tag unwrappen,
			// Style-Wrapper bleibt erhalten.
			for (const child of Array.from(node.childNodes)) walk(child, parts, dropDepth);
			for (let i = styleTags.length - 1; i >= 0; i -= 1) parts.push(`</${styleTags[i]}>`);
			return;
		}

		const attrText = rendered.map(([n, v]) => ` ${n}="${htmlEscape(v)}"`).join('');
		parts.push(`<${tag}${attrText}>`);
		if (!VOID_TAGS.has(tag)) {
			for (const child of Array.from(node.childNodes)) walk(child, parts, dropDepth);
			parts.push(`</${tag}>`);
		}
		for (let i = styleTags.length - 1; i >= 0; i -= 1) parts.push(`</${styleTags[i]}>`);
	}

	function sanitizeRichText(raw) {
		const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
		const parts = [];
		for (const child of Array.from(doc.body.childNodes)) walk(child, parts, 0);
		const fragment = parts.join('').trim();
		return hardenWithDomPurify(fragment);
	}

	function hardenWithDomPurify(fragment) {
		if (typeof self.DOMPurify === 'undefined') {
			// Sollte nie passieren (purify.min.js läuft vor dieser Datei im
			// manifest) -- kein stiller Fallback ohne Sanitize-Schicht.
			throw new Error('DOMPurify ist nicht geladen -- sanitize.js kann RichText nicht absichern.');
		}
		const allowedTags = Object.keys(SAFE_TAGS);
		const allowedAttrs = new Set();
		for (const attrs of Object.values(SAFE_TAGS)) {
			for (const a of attrs) allowedAttrs.add(a);
		}
		return self.DOMPurify.sanitize(fragment, {
			ALLOWED_TAGS: allowedTags,
			ALLOWED_ATTR: Array.from(allowedAttrs),
			ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
		}).trim();
	}

	function sanitizeRichTextFragment(raw) {
		if (looksLikeHtml(raw)) return sanitizeRichText(raw);
		const escaped = htmlEscape(htmlUnescape(raw)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		return escaped.replace(/\n/g, '<br>');
	}

	function normalizeRichText(raw) {
		if (looksLikeHtml(raw)) return sanitizeRichTextFragment(raw);
		const escaped = htmlEscape(htmlUnescape(raw)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
	}

	// LaTeX-Inline-/Display-Syntax für den CK5-Mathe-Plugin-Wrapper.
	function wrapLatexForCk5(inner) {
		if (!inner || !inner.includes('\\')) return inner;
		let out = inner.replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `<span class="math-tex">\\[${body.trim()}\\]</span>`);
		out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `<span class="math-tex">\\(${body.trim()}\\)</span>`);
		return out;
	}

	const api = { normalizeRichText, sanitizeRichTextFragment, wrapLatexForCk5 };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.sanitize = api;
})();
