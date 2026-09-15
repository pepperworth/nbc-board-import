// Service Worker: die einzige Stelle, die Cross-Origin-Requests macht.
//
// MV3-Content-Scripts unterliegen bei Cross-Origin-Fetches derselben CORS-
// Prüfung wie die Seite selbst; Fetches aus dem Service Worker dagegen
// nicht, solange die Ziel-Hosts in host_permissions stehen (siehe
// manifest.json). Deshalb laufen alle Requests gegen taskcards.de und
// edumaps.de hier, nicht im Content-Script.
//
// Zwei Aufgaben:
//   1. Ein generischer fetchResource-Handler für Edumaps-HTML und
//      Mediendateien.
//   2. Die vollständige Taskcards-GraphQL-Choreografie (Visitor-Token,
//      optionaler Token-Unlock, Board-Query) -- portiert aus
//      app/static/taskcards_client_ingest.js (nbcimport), das denselben
//      Ablauf schon heute im Browser fährt, nur als Page-Script statt im
//      Worker.

const TASKCARDS_BOARD_QUERY = `
query ($id: String!) {
  board(id: $id) {
    id
    name
    description
    type
    lists {
      id
      name
      position
      color
    }
    cards {
      id
      title
      description
      link
      videoConference
      color
      enableContract
      enableThumbnails
      mode
      created
      modified
      attachments { id filename length mimetype downloadLink previewLink }
      comments { id modified text writeable }
      chalkBoardPosition {
        height
        width
        left
        top
        connections { id toId arrowFrom arrowTo color thick label fromId dashed }
      }
      kanbanPosition { listId position }
      timeLinePosition { position }
      storyPosition { position }
      worldMapPosition { lat lng }
    }
  }
}
`.trim();

const TASKCARDS_BOARD_RETRY_DELAYS_MS = [300, 800];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (!message || typeof message.type !== 'string') return undefined;

	if (message.type === 'nbcImport:fetchResource') {
		fetchResource(message.url, message.as || 'text', message.credentials || 'omit')
			.then((result) => sendResponse({ ok: true, ...result }))
			.catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
		return true;
	}

	if (message.type === 'nbcImport:taskcardsFetchBoard') {
		taskcardsFetchBoard(message.boardId, message.token, message.baseUrl)
			.then((board) => sendResponse({ ok: true, board }))
			.catch((error) => sendResponse({ ok: false, error: String((error && error.message) || error) }));
		return true;
	}

	return undefined;
});

/**
 * Holt eine Ressource cross-origin. `as` steuert das Rückgabeformat:
 * "text" (HTML/JSON-Strings), "bytes" (ArrayBuffer, für Datei-Downloads).
 * `credentials: "include"` schickt die Cookies der Zielseite mit -- nötig
 * für nicht-öffentliche Boards, die Login voraussetzen.
 */
async function fetchResource(url, as, credentials) {
	const response = await fetch(url, { credentials, redirect: 'follow' });
	const contentType = response.headers.get('content-type') || '';
	const finalUrl = response.url || url;
	if (as === 'bytes') {
		const bytes = await response.arrayBuffer();
		return { status: response.status, contentType, finalUrl, bytes };
	}
	const text = await response.text();
	return { status: response.status, contentType, finalUrl, text };
}

async function taskcardsFetchBoard(boardId, token, baseUrl) {
	const base = baseUrl || 'https://www.taskcards.de';

	const visitor = await taskcardsGraphql(base, { query: 'mutation { createVisitor { id noActive } }' }, null);
	const xToken = visitor && visitor.data && visitor.data.createVisitor && visitor.data.createVisitor.id;
	if (!xToken) throw new Error('Taskcards hat keinen Visitor-Token geliefert.');

	if (token) {
		const accessResponse = await fetch(
			`${base}/api/boards/${encodeURIComponent(boardId)}/permissions/${encodeURIComponent(token)}/accesses`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-token': xToken },
				body: JSON.stringify({ password: '' }),
			},
		);
		if (!accessResponse.ok && accessResponse.status !== 409) {
			throw new Error(`Taskcards-Zugriff konnte nicht freigeschaltet werden: HTTP ${accessResponse.status}.`);
		}
	}

	const boardResponse = await taskcardsFetchBoardWithRetry(base, boardId, token, xToken);
	const board = boardResponse && boardResponse.data && boardResponse.data.board;
	if (!board) throw new Error('Taskcards hat keine Boarddaten geliefert (Board nicht gefunden oder nicht öffentlich).');
	return board;
}

async function taskcardsFetchBoardWithRetry(base, boardId, token, xToken) {
	const payload = { operationName: null, variables: { id: boardId }, query: TASKCARDS_BOARD_QUERY };
	const maxAttempts = token ? TASKCARDS_BOARD_RETRY_DELAYS_MS.length + 1 : 1;
	let lastError = null;
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			return await taskcardsGraphql(base, payload, xToken);
		} catch (error) {
			lastError = error;
			if (!token || !isRetryableBoardError(error) || attempt >= maxAttempts - 1) throw error;
			await sleep(TASKCARDS_BOARD_RETRY_DELAYS_MS[attempt]);
		}
	}
	throw lastError || new Error('Taskcards hat keine Boarddaten geliefert.');
}

async function taskcardsGraphql(base, payload, xToken) {
	const headers = { 'Content-Type': 'application/json' };
	if (xToken) headers['x-token'] = xToken;

	let response;
	try {
		response = await fetch(`${base}/graphql`, { method: 'POST', headers, body: JSON.stringify(payload) });
	} catch (error) {
		throw new Error(`Taskcards GraphQL konnte nicht geladen werden: ${error.message || error}`);
	}

	const text = await response.text();
	let data = {};
	if (text.trim()) {
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error('Taskcards GraphQL hat kein gültiges JSON geliefert.');
		}
	}
	if (!response.ok) throw new Error(`Taskcards GraphQL antwortet mit HTTP ${response.status}.`);
	if (Array.isArray(data.errors) && data.errors.length) {
		const first = data.errors[0] || {};
		const error = new Error(`Taskcards GraphQL-Fehler: ${first.message || 'Unbekannter Fehler'}`);
		error.graphqlErrors = data.errors;
		throw error;
	}
	return data;
}

function isRetryableBoardError(error) {
	const errors = error && error.graphqlErrors;
	if (!Array.isArray(errors) || !errors.length) return false;
	return errors.some((item) => {
		const code = item && item.extensions && item.extensions.code;
		const message = item && item.message;
		return code === 'BOARD_ERROR' && !String(message || '').trim();
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chrome spritzt Content-Scripts nur bei einer echten Navigation ein. Nach
// Installation oder Update haetten offene NBC-Tabs deshalb keinen Button,
// bis man sie neu laedt -- hier wird das Script einmalig nachgereicht.
// Muster aus nbc-files/extension/background.js.
chrome.runtime.onInstalled.addListener(async () => {
	const tabs = await chrome.tabs.query({ url: 'https://niedersachsen.cloud/*' });
	const files = [
		'lib/vendor/purify.min.js',
		'lib/vendor/qrcode-core.js',
		'lib/vendor/qrcode-utf8.js',
		'lib/colors.js',
		'lib/sanitize.js',
		'lib/qr.js',
		'lib/edumaps-parser.js',
		'lib/taskcards.js',
		'lib/nbc-api.js',
		'lib/exporter.js',
		'content-nbc.js',
	];
	for (const tab of tabs) {
		try {
			await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
		} catch {
			// Entladener oder gesperrter Tab -- beim naechsten Laden greift
			// ohnehin das normale Content-Script.
		}
	}
});
