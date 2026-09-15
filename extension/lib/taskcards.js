// Taskcards-Board -> gemeinsames Import-Format.
//
// Der Netzteil (Visitor-Token, Token-Unlock, die GraphQL-Board-Query) läuft
// im Service Worker (background.js), portiert aus
// app/static/taskcards_client_ingest.js -- der läuft dort schon heute im
// Browser des Nutzers gegen taskcards.de/graphql.
//
// Diese Datei ist der neue Teil: das Mapping vom rohen GraphQL-Board auf
// unser gemeinsames Format (dieselbe Form wie Edumaps-Exporte --
// {title, layout, columns:[{title, cards:[{title, elements:[...]}]}]}).
// Port von nbcimport (app/importers/taskcards.py).
(function () {
	'use strict';

	const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
	const TASKCARDS_HOST_RE = /(^|\.)taskcards\.(de|app)$/i;
	const TASKCARDS_BASE_URL = 'https://www.taskcards.de';

	const LAYOUT_BY_TYPE = { 0: 'kanban', 1: 'timeline', 2: 'chalkboard', 3: 'worldmap', 4: 'story' };
	const SINGLE_COLUMN_TITLE_BY_LAYOUT = { chalkboard: 'Tafel', worldmap: 'Weltkarte', story: 'Blog', cards: 'Karten' };

	/** Erkennt einen Taskcards-Board-Link (Pfad oder Hash-Route, optional Token). */
	function parseBoardLink(sourceUrl) {
		let url;
		try {
			url = new URL(sourceUrl);
		} catch {
			return null;
		}
		if (!TASKCARDS_HOST_RE.test(url.hostname)) return null;

		const pathMatch = url.pathname.match(/\/board\/([^/?#]+)/);
		const hashPath = url.hash ? url.hash.slice(1) : '';
		const hashMatch = hashPath.match(/\/board\/([^/?#]+)/);
		const boardId = (hashMatch && hashMatch[1]) || (pathMatch && pathMatch[1]) || '';
		if (!UUID_RE.test(boardId) || boardId.length !== 36) return null;

		let token = url.searchParams.get('token') || '';
		const hashQueryIndex = hashPath.indexOf('?');
		if (!token && hashQueryIndex !== -1) {
			token = new URLSearchParams(hashPath.slice(hashQueryIndex + 1)).get('token') || '';
		}

		return { boardId, token, baseUrl: taskcardsBaseUrl(url.hostname) };
	}

	function taskcardsBaseUrl(hostname) {
		const host = String(hostname || '').toLowerCase();
		if (host === 'taskcards.de' || host === 'www.taskcards.de') return TASKCARDS_BASE_URL;
		return `https://${host}`;
	}

	function boardLayout(board) {
		const boardType = board.type;
		if (boardType === null || boardType === undefined) return inferBoardLayout(board);
		const n = Number(boardType);
		if (Number.isInteger(n) && LAYOUT_BY_TYPE[n]) return LAYOUT_BY_TYPE[n];
		throw new Error(`Dieses Taskcards-Layout wird noch nicht unterstützt (board.type=${boardType}).`);
	}

	function inferBoardLayout(board) {
		const cards = asList(board.cards);
		if ((board.lists && board.lists.length) || cards.some((c) => isObj(c.kanbanPosition))) return 'kanban';
		if (cards.some((c) => isObj(c.timeLinePosition))) return 'timeline';
		if (cards.some((c) => isObj(c.chalkBoardPosition))) return 'chalkboard';
		if (cards.some((c) => isObj(c.worldMapPosition))) return 'worldmap';
		if (cards.some((c) => isObj(c.storyPosition))) return 'story';
		return 'cards';
	}

	function nbcBoardLayout(layout) {
		return layout === 'story' ? 'list' : 'columns';
	}

	function mapColumns(board, cards, layout) {
		if (layout === 'kanban') return mapKanbanColumns(board, cards);
		if (layout === 'timeline') return mapTimelineColumns(cards);
		return mapSingleColumn(cards, layout);
	}

	function mapKanbanColumns(board, cards) {
		const lists = asList(board.lists)
			.filter(isObj)
			.slice()
			.sort((a, b) => number(a.position, 0) - number(b.position, 0) || String(a.name || '').localeCompare(String(b.name || '')));
		const listIndexById = new Map();
		lists.forEach((item, idx) => { if (item.id) listIndexById.set(String(item.id), idx); });
		const columns = lists.map((item, idx) => ({ title: String(item.name || `Spalte ${idx + 1}`).trim(), cards: [] }));

		if (columns.length) {
			const unassigned = [];
			const sorted = cards.slice().sort((a, b) => compareSortKey(cardSortKey(a, 'kanban'), cardSortKey(b, 'kanban')));
			sorted.forEach((apiCard, idx) => {
				const mapped = mapCard(apiCard, idx);
				const listId = String((apiCard.kanbanPosition || {}).listId || '');
				const columnIndex = listIndexById.has(listId) ? listIndexById.get(listId) : null;
				if (columnIndex === null) unassigned.push(mapped);
				else columns[columnIndex].cards.push(mapped);
			});
			if (unassigned.length) columns.push({ title: 'Ohne Spalte', cards: unassigned });
			return columns;
		}
		return mapSingleColumn(cards, 'cards');
	}

	function mapTimelineColumns(cards) {
		const sorted = cards.slice().sort((a, b) => compareSortKey(cardSortKey(a, 'timeline'), cardSortKey(b, 'timeline')));
		if (!sorted.length) return [{ title: 'Timeline', cards: [] }];
		return sorted.map((apiCard, idx) => ({ title: `Zeitpunkt ${idx + 1}`, cards: [mapCard(apiCard, idx)] }));
	}

	function mapSingleColumn(cards, layout) {
		const sorted = cards.slice().sort((a, b) => compareSortKey(cardSortKey(a, layout), cardSortKey(b, layout)));
		return [{
			title: SINGLE_COLUMN_TITLE_BY_LAYOUT[layout] || 'Karten',
			cards: sorted.map((apiCard, idx) => mapCard(apiCard, idx)),
		}];
	}

	function mapCard(apiCard, index) {
		const title = cardTitle(apiCard);
		const elements = [];
		let order = 0;

		const coordsHtml = worldMapCoordinatesHtml(apiCard);
		if (coordsHtml) elements.push({ order: order++, type: 'text', content: coordsHtml });

		if (hasVideoConference(apiCard)) {
			elements.push({ order: order++, type: 'videoConference', title: title || 'Videokonferenz', content: '' });
		}

		const description = normalizeRichText(apiCard.description);
		if (description) elements.push({ order: order++, type: 'text', content: description });

		const link = normalizeOptionalUrl(apiCard.link);
		if (link) elements.push({ order: order++, type: 'link', url: link, title: link, content: `🔗 ${link}` });

		for (const attachment of asList(apiCard.attachments)) {
			if (!isObj(attachment)) continue;
			const el = mapAttachment(attachment);
			if (el) { el.order = order++; elements.push(el); }
		}

		const contractNote = contractFallbackHtml(apiCard);
		if (contractNote) elements.push({ order: order++, type: 'text', content: contractNote });

		const contactNote = contactFallbackHtml(apiCard);
		if (contactNote) elements.push({ order: order++, type: 'text', content: contactNote });

		const commentsNote = commentsNoteHtml(apiCard);
		if (commentsNote) elements.push({ order: order++, type: 'text', content: commentsNote });

		let backgroundColor = null;
		const rawColor = typeof apiCard.color === 'string' && apiCard.color.trim() ? apiCard.color.trim() : null;
		if (rawColor && self.NBCImport.colors) backgroundColor = self.NBCImport.colors.hexToNbcColor(rawColor);

		return {
			title,
			content: elements.map((e) => e.content || '').join(''),
			elements,
			backgroundColorRaw: rawColor,
			backgroundColor,
		};
	}

	function mapAttachment(attachment) {
		const filename = String(attachment.filename || 'Anhang').trim() || 'Anhang';
		const sourceUrl = String(attachment.downloadLink || attachment.previewLink || '').trim();
		if (!sourceUrl) {
			return { type: 'text', content: `<p>Anhang ohne Download-Link: ${escapeHtml(filename)}</p>` };
		}
		return {
			type: 'file',
			fileName: filename,
			fileInfo: 'Anhang, Taskcards',
			content: `📎 ${filename}`,
			mimeType: String(attachment.mimetype || 'application/octet-stream'),
			sizeBytes: optionalInt(attachment.length),
			_originalUrl: sourceUrl,
		};
	}

	function commentsNoteHtml(apiCard) {
		const comments = [];
		for (const [idx, comment] of asList(apiCard.comments).entries()) {
			if (!isObj(comment)) continue;
			const text = normalizeRichText(comment.text);
			if (!text) continue;
			const modified = number(comment.modified, null);
			comments.push([modified === null ? idx : modified, text]);
		}
		if (!comments.length) return '';
		comments.sort((a, b) => a[0] - b[0]);
		const items = comments.map(([, text]) => `<li>${text}</li>`).join('');
		return `<p><em>Kommentare aus Taskcards (nicht interaktiv übernommen):</em></p><ul>${items}</ul>`;
	}

	function cardTitle(apiCard) {
		const value = String(apiCard.title || '').replace(/\n/g, ' ').trim();
		if (!value) return '';
		return value.replace(/\s+/g, ' ').slice(0, 160);
	}

	function normalizeRichText(value) {
		const raw = String(value || '').trim();
		if (!raw) return '';
		return self.NBCImport.sanitize.normalizeRichText(raw);
	}

	function normalizeOptionalUrl(value) {
		const raw = String(value || '').trim();
		if (!raw) return '';
		try {
			const parsed = new URL(raw);
			if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host) return '';
			return raw;
		} catch {
			return '';
		}
	}

	function hasVideoConference(apiCard) {
		const value = apiCard.videoConference;
		if (typeof value === 'boolean') return value;
		const normalized = String(value || '').trim().toLowerCase();
		return normalized === 'moderator' || normalized === 'public';
	}

	function contractFallbackHtml(apiCard) {
		const value = apiCard.enableContract;
		if (value === true || ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase())) {
			return '<p><em>Hinweis: Diese Taskcards-Karte war ausklappbar; der Inhalt wird in der NBC dauerhaft sichtbar angezeigt.</em></p>';
		}
		return '';
	}

	function contactFallbackHtml(apiCard) {
		const values = [apiCard.mode, apiCard.type, apiCard.cardType, apiCard.contentType, apiCard.contactType];
		const flags = [apiCard.contact, apiCard.enableContact, apiCard.contactForm, apiCard.enableContactForm];
		const hasFlag = flags.some((v) => v === true);
		const hasKeyword = values.some((v) => /(contact|kontakt)/i.test(String(v || '')));
		if (hasFlag || hasKeyword) {
			return '<p><em>Hinweis: Diese Taskcards-Karte enthielt eine Kontaktfunktion. Die NBC unterstützt dafür kein eigenes Element.</em></p>';
		}
		return '';
	}

	function worldMapCoordinatesHtml(apiCard) {
		const position = apiCard.worldMapPosition;
		if (!isObj(position)) return '';
		const { lat, lng } = position;
		if (lat === null || lat === undefined || lng === null || lng === undefined) return '';
		return `<p><strong>Koordinaten:</strong> ${escapeHtml(String(lat))}, ${escapeHtml(String(lng))}</p>`;
	}

	function cardSortKey(apiCard, layout) {
		const kanban = isObj(apiCard.kanbanPosition) ? apiCard.kanbanPosition : {};
		const timeline = isObj(apiCard.timeLinePosition) ? apiCard.timeLinePosition : {};
		const story = isObj(apiCard.storyPosition) ? apiCard.storyPosition : {};
		const chalk = isObj(apiCard.chalkBoardPosition) ? apiCard.chalkBoardPosition : {};
		const worldmap = isObj(apiCard.worldMapPosition) ? apiCard.worldMapPosition : {};

		let primary;
		let secondary;
		if (layout === 'timeline') { primary = number(timeline.position, 0); secondary = 0; }
		else if (layout === 'story') { primary = number(story.position, 0); secondary = 0; }
		else if (layout === 'chalkboard') { primary = number(chalk.top, 0); secondary = number(chalk.left, 0); }
		else if (layout === 'worldmap') { primary = number(worldmap.lng, 0); secondary = number(worldmap.lat, 0); }
		else {
			primary = firstNumber([kanban.position, timeline.position, story.position], null);
			if (primary === null) primary = number(chalk.top, 0);
			secondary = number(chalk.left, 0);
		}
		return [primary || 0, secondary || 0, number(apiCard.created, 0), String(apiCard.id || '')];
	}

	function compareSortKey(a, b) {
		for (let i = 0; i < a.length; i += 1) {
			if (a[i] < b[i]) return -1;
			if (a[i] > b[i]) return 1;
		}
		return 0;
	}

	function firstNumber(values, fallback) {
		for (const v of values) {
			const n = number(v, null);
			if (n !== null) return n;
		}
		return fallback;
	}

	/**
	 * Mappt das rohe GraphQL-Board (board-Objekt aus der Board-Query) auf
	 * unser gemeinsames Format.
	 *
	 * @param {object} board      board-Objekt aus der GraphQL-Antwort
	 * @param {string} sourceUrl  ursprüngliche Board-URL (für die Zusammenfassungsspalte)
	 */
	function mapBoard(board, sourceUrl) {
		const layout = boardLayout(board);
		const title = String(board.name || 'TaskCards Board').trim() || 'TaskCards Board';
		const cards = asList(board.cards).filter(isObj);
		const columns = mapColumns(board, cards, layout);

		const description = normalizeRichText(board.description);
		if (description) {
			if (!columns.length) columns.push({ title: 'Karten', cards: [] });
			columns[0].cards.unshift({
				title: 'Beschreibung',
				content: description,
				elements: [{ order: 0, type: 'text', content: description }],
			});
		}

		let totalCards = 0;
		let totalElements = 0;
		let totalFiles = 0;
		let totalLinks = 0;
		let totalCardsColored = 0;
		for (const col of columns) {
			for (const card of col.cards) {
				totalCards += 1;
				if (card.backgroundColor && card.backgroundColor !== 'transparent') totalCardsColored += 1;
				for (const el of card.elements || []) {
					totalElements += 1;
					if (el.type === 'file') totalFiles += 1;
					if (el.type === 'link') totalLinks += 1;
				}
			}
		}

		return {
			exportDate: new Date().toISOString(),
			version: '0.1-taskcards',
			boardTitle: title,
			sourceUrl: sourceUrl || '',
			totalColumns: columns.length,
			totalCards,
			totalCardsColored,
			totalFiles,
			totalLinks,
			totalElements,
			layout: nbcBoardLayout(layout),
			columns,
		};
	}

	function asList(value) { return Array.isArray(value) ? value : []; }
	function isObj(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
	function number(value, fallback) {
		const n = Number(value);
		return Number.isFinite(n) ? n : fallback;
	}
	function optionalInt(value) {
		const n = parseInt(value, 10);
		return Number.isFinite(n) && n >= 0 ? n : null;
	}
	function escapeHtml(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	const api = { parseBoardLink, mapBoard, taskcardsBaseUrl };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.taskcards = api;
})();
