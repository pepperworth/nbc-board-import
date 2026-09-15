// Typisierter NBC-API-Client -- läuft im Content-Script auf
// niedersachsen.cloud, also same-origin. Kein JWT, kein Login: die
// Session-Cookies des Tabs gehen mit (`credentials: "same-origin"`),
// dieselbe Technik wie nbc-files/userscript/nbc-team-tools.user.js:294
// (dort belegt für /me, /file/list, /file/upload).
//
// Port von nbcimport (app/nbc/client.py) + edumaps-import/src/api-client.ts,
// hier zusammengeführt und auf Cookie-Auth umgestellt.
(function () {
	'use strict';

	const API_BASE = '/api/v3';

	// Retry-Politik aus app/nbc/session.py:149-189: 429/502/503/504 werden
	// wiederholt (Exponential-Backoff mit Jitter, Retry-After hat Vorrang),
	// 500 bewusst NICHT -- ein 500 auf einen RichText-PATCH ist meist ein
	// Format-Problem, kein transienter Fehler, und der Exporter braucht das
	// schnelle Scheitern für seinen eigenen Plaintext-Fallback.
	const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
	const MAX_RETRIES = 3;
	const RETRY_BASE_DELAY_MS = 500;
	const RETRY_MAX_DELAY_MS = 30000;

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function backoffDelay(attempt, retryAfterHeader) {
		if (retryAfterHeader) {
			const seconds = Number(retryAfterHeader);
			if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		}
		const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
		const jitter = base * 0.2 * (Math.random() * 2 - 1);
		return Math.max(0, base + jitter);
	}

	class NbcApiError extends Error {
		constructor(message, status, body) {
			super(message);
			this.name = 'NbcApiError';
			this.status = status;
			this.body = body;
		}
	}

	async function request(method, path, { json, body, headers, expect } = {}) {
		const finalHeaders = Object.assign({ Accept: 'application/json' }, headers || {});
		let finalBody = body;
		if (json !== undefined) {
			finalHeaders['Content-Type'] = 'application/json';
			finalBody = JSON.stringify(json);
		}

		let lastError = null;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
			let response;
			try {
				response = await fetch(`${API_BASE}${path}`, {
					method,
					credentials: 'same-origin',
					headers: finalHeaders,
					body: finalBody,
				});
			} catch (error) {
				lastError = error;
				if (attempt < MAX_RETRIES) { await sleep(backoffDelay(attempt)); continue; }
				throw new NbcApiError(`${method} ${path}: Netzwerkfehler (${error.message || error})`, 0, null);
			}

			if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
				await sleep(backoffDelay(attempt, response.headers.get('retry-after')));
				continue;
			}

			const expectedCodes = expect || [200, 201, 204];
			if (!expectedCodes.includes(response.status)) {
				const text = await response.text().catch(() => '');
				throw new NbcApiError(
					`${method} ${path} -> HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`,
					response.status,
					text,
				);
			}

			if (response.status === 204 || response.headers.get('content-length') === '0') return null;
			const text = await response.text();
			if (!text) return null;
			try {
				return JSON.parse(text);
			} catch {
				return null;
			}
		}
		throw lastError || new NbcApiError(`${method} ${path}: unbekannter Fehler`, 0, null);
	}

	class NbcApiClient {
		constructor() {
			this._schoolId = null;
		}

		async me() {
			return request('GET', '/me');
		}

		async schoolId() {
			if (this._schoolId) return this._schoolId;
			const me = await this.me();
			const id = me && me.school && me.school.id;
			if (!id) throw new Error('NBC-schoolId konnte nicht aus /me gelesen werden.');
			this._schoolId = id;
			return id;
		}

		async createRoom(name, color = 'blue', features = []) {
			const r = await request('POST', '/rooms', { json: { name, color, features }, expect: [201] });
			return r.id;
		}

		async createBoard(title, parentId, parentType = 'room', layout = 'columns') {
			const r = await request('POST', '/boards', {
				json: { title, parentId, parentType, layout },
				expect: [201],
			});
			return r.id;
		}

		async createColumn(boardId) {
			return request('POST', `/boards/${boardId}/columns`, { json: {}, expect: [201] });
		}

		async setColumnTitle(columnId, title) {
			await request('PATCH', `/columns/${columnId}/title`, { json: { title }, expect: [204] });
		}

		async createCard(columnId, requiredEmptyElements) {
			const body = {};
			if (requiredEmptyElements && requiredEmptyElements.length) body.requiredEmptyElements = requiredEmptyElements;
			return request('POST', `/columns/${columnId}/cards`, { json: body, expect: [201] });
		}

		async setCardTitle(cardId, title) {
			await request('PATCH', `/cards/${cardId}/title`, { json: { title }, expect: [204] });
		}

		async setCardColor(cardId, backgroundColor) {
			await request('PATCH', `/cards/${cardId}/color`, { json: { backgroundColor }, expect: [204] });
		}

		async createElement(cardId, type, toPosition) {
			const body = { type };
			if (toPosition !== undefined && toPosition !== null) body.toPosition = toPosition;
			return request('POST', `/cards/${cardId}/elements`, { json: body, expect: [201] });
		}

		async deleteElement(elementId) {
			await request('DELETE', `/elements/${elementId}`, { expect: [200, 204] });
		}

		async _patchElementContent(elementId, type, content) {
			await request('PATCH', `/elements/${elementId}/content`, {
				json: { data: { type, content } },
				expect: [200, 204],
			});
		}

		async setRichText(elementId, text, inputFormat = 'richTextCk5Simple') {
			await this._patchElementContent(elementId, 'richText', { text, inputFormat });
		}

		async setLink(elementId, { url, title, description = '', imageUrl = '', originalImageUrl = '' }) {
			await this._patchElementContent(elementId, 'link', {
				url, title, description, imageUrl, originalImageUrl,
			});
		}

		async setFileCaption(elementId, caption, alternativeText = '') {
			await this._patchElementContent(elementId, 'file', { caption, alternativeText });
		}

		async setVideoConference(elementId, title) {
			await this._patchElementContent(elementId, 'videoConference', { title });
		}

		async uploadFile(elementId, filename, blob, mimeType, schoolId) {
			const resolvedSchoolId = schoolId || (await this.schoolId());
			const form = new FormData();
			form.append('file', blob, filename);
			// Kein eigener Content-Type-Header -- die Boundary setzt der
			// Browser, wie in nbc-team-tools.user.js:1109 dokumentiert.
			await request('POST', `/file/upload/school/${resolvedSchoolId}/boardnodes/${elementId}`, {
				body: form,
				headers: {},
				expect: [200, 201, 204],
			});
		}

		async uploadFileFromUrl(elementId, url, filename, schoolId, requestHeaders) {
			const resolvedSchoolId = schoolId || (await this.schoolId());
			const body = { url, fileName: filename };
			if (requestHeaders) body.headers = requestHeaders;
			return request('POST', `/file/upload-from-url/school/${resolvedSchoolId}/boardnodes/${elementId}`, {
				json: body,
				expect: [200, 201],
			});
		}

		async createShareToken(parentId, parentType = 'columnBoard', expiresInDays) {
			const body = { parentType, parentId, schoolExclusive: false };
			if (expiresInDays !== undefined && expiresInDays !== null) body.expiresInDays = expiresInDays;
			return request('POST', '/sharetoken', { json: body, expect: [201] });
		}

		shareUrl(token, parentType = 'columnBoard') {
			return `${location.origin}/rooms?import=${encodeURIComponent(token)}&importedType=${encodeURIComponent(parentType)}`;
		}
	}

	const api = { NbcApiClient, NbcApiError };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.nbcApi = api;
})();
