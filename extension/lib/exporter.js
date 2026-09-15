// Export-Choreografie: gemeinsames Board-Format -> NBC-API-Aufrufe.
//
// Läuft im Content-Script (Tab bleibt offen, kein Service-Worker-Timeout
// bei hunderten sequentiellen Requests). Reihenfolge und Quirks portiert
// aus nbcimport (app/nbc/exporter.py) und edumaps-import/server.js#runImport
// (dort die vollständigste JS-Fassung, u.a. mit Ankerauflösung für interne
// Links -- server.js:385-476).
(function () {
	'use strict';

	const TITLE_MAX_CHARS = 100;
	const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
	const WIDGET_WARNING_MARKER = '⚠️ Edumaps-Element';

	/** Fragt den Service Worker nach einer Cross-Origin-Ressource. */
	function fetchResourceViaBackground(url, as, credentials) {
		return chrome.runtime.sendMessage({ type: 'nbcImport:fetchResource', url, as, credentials });
	}

	// background.js liefert Binärdaten als Base64-String zurück (siehe
	// Kommentar dort bei arrayBufferToBase64) -- chrome.runtime.sendMessage
	// verfälscht ein rohes ArrayBuffer sonst stillschweigend zu {}.
	function base64ToBytes(base64) {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	function nbcTitle(value, fallback) {
		let title = String(value || '').split(/\s+/).filter(Boolean).join(' ');
		if (!title && fallback) title = String(fallback).split(/\s+/).filter(Boolean).join(' ');
		if (title.length <= TITLE_MAX_CHARS) return title;
		return `${title.slice(0, TITLE_MAX_CHARS - 3).trimEnd()}...`;
	}

	function isSafeStoredLinkUrl(url) {
		try {
			const u = new URL(url);
			if (!SAFE_URL_SCHEMES.has(u.protocol)) return false;
			if ((u.protocol === 'http:' || u.protocol === 'https:') && !u.host) return false;
			return true;
		} catch {
			return false;
		}
	}

	function stripHtmlToPlaintext(html) {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
	}

	function altTextFromFilename(filename) {
		return String(filename || '').replace(/\.[^./]+$/, '');
	}

	function requiredEmptyElementsFor(elements) {
		return elements.filter((el) => el.type === 'videoConference').map(() => 'videoConference');
	}

	function precreatedElementsByType(cardResponse) {
		const result = new Map();
		const raw = (cardResponse && (cardResponse.elements || cardResponse.contentElements)) || [];
		for (const item of raw) {
			if (!item || !item.type || !item.id) continue;
			if (!result.has(item.type)) result.set(item.type, []);
			result.get(item.type).push(item.id);
		}
		return result;
	}

	// --- Widget-Warnungen / Zusammenfassungsspalte (Optionen aus dem Panel) ---

	function countWidgetWarnings(columns) {
		let count = 0;
		for (const col of columns) {
			for (const card of col.cards) {
				for (const el of card.elements || []) {
					if (el.type === 'text' && el.content && el.content.includes(WIDGET_WARNING_MARKER)) count += 1;
				}
			}
		}
		return count;
	}

	function stripWidgetWarnings(columns) {
		let removed = 0;
		for (const col of columns) {
			for (const card of col.cards) {
				const kept = [];
				for (const el of card.elements || []) {
					if (el.type === 'text' && el.content && el.content.includes(WIDGET_WARNING_MARKER)) { removed += 1; continue; }
					kept.push(el);
				}
				card.elements = kept;
			}
		}
		return removed;
	}

	function prependSummaryColumn(exportData, droppedWidgetCount) {
		const paragraphs = [];
		const src = exportData.sourceUrl || exportData.boardTitle || '';
		if (src) {
			const escaped = String(src).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
			paragraphs.push(`<p>Original-Board: <a href="${escaped}">${escaped}</a></p>`);
		}
		const pads = [];
		for (const col of exportData.columns) {
			for (const card of col.cards) {
				for (const el of card.elements || []) {
					if (el.type === 'collaborativeTextEditor' && el.originalUrl) {
						pads.push({ title: el.title || 'Etherpad', url: el.originalUrl });
					}
				}
			}
		}
		if (pads.length) {
			const items = pads.map((p) => `<li><a href="${p.url.replace(/"/g, '&quot;')}">${String(p.title).replace(/</g, '&lt;')}</a></li>`).join('');
			paragraphs.push(`<p><strong>Etherpads aus dem Original</strong> (Inhalt bitte manuell in den NBC-Pad kopieren):</p><ul>${items}</ul>`);
		}
		if (droppedWidgetCount > 0) {
			paragraphs.push(`<p>${droppedWidgetCount} Element(e) konnten nicht in die NBC übertragen werden (z.B. Quizze, Umfragen, Countdowns).</p>`);
		}
		if (!paragraphs.length) return false;
		exportData.columns.unshift({
			title: 'Zusammenfassung',
			cards: [{ title: 'Übersicht', content: paragraphs.join(''), elements: [{ order: 0, type: 'text', content: paragraphs.join('') }] }],
		});
		return true;
	}

	// --- QR-Code-Marker -> inline File-Element (vor dem Export) ---

	async function renderQrCodesInline(columns, logger) {
		let count = 0;
		for (const col of columns) {
			for (const card of col.cards) {
				for (const el of card.elements || []) {
					if (el.type !== 'qrCode') continue;
					try {
						const blob = await self.NBCImport.qr.renderQrCodePng(el.content);
						el.type = 'file';
						el.fileInfo = 'QR-Code, Edumaps';
						el._inlineBlob = blob;
						el.content = el.caption || '';
						count += 1;
					} catch (error) {
						logger.warn(`QR-Code "${el.fileName}" konnte nicht gerendert werden: ${error.message}`);
						el.type = 'text';
						el.content = `<p>QR-Code konnte nicht gerendert werden (${el.content}).</p>`;
					}
				}
			}
		}
		if (count > 0) logger.info(`${count} QR-Code(s) gerendert.`);
	}

	// --- Datei-Element ---

	async function addFileElement(client, cardId, order, el, warnings, logger) {
		const elem = await client.createElement(cardId, 'file', order);
		try {
			let blob = null;
			if (el._inlineBlob) {
				blob = el._inlineBlob;
			} else if (el._originalUrl) {
				try {
					await client.uploadFileFromUrl(elem.id, el._originalUrl, el.fileName);
				} catch (fromUrlError) {
					logger.info(`  upload-from-url für "${el.fileName}" fehlgeschlagen (${fromUrlError.message}), lade die Datei stattdessen selbst...`);
					const fetched = await fetchResourceViaBackground(el._originalUrl, 'bytes', 'omit');
					if (!fetched || !fetched.ok) throw new Error((fetched && fetched.error) || 'Download fehlgeschlagen');
					blob = new Blob([base64ToBytes(fetched.bytesBase64)], { type: el.mimeType || fetched.contentType || 'application/octet-stream' });
				}
			} else {
				throw new Error('Kein Dateiinhalt vorhanden.');
			}
			if (blob) await client.uploadFile(elem.id, el.fileName, blob, blob.type || el.mimeType || 'application/octet-stream');
			try {
				await client.setFileCaption(elem.id, el.content || el.fileName, altTextFromFilename(el.fileName));
			} catch (captionError) {
				// Kosmetisch (Bildunterschrift/Alt-Text) -- NBC antwortet hier in
				// der Praxis manchmal mit 500. Datei ist trotzdem hochgeladen.
				logger.info(`  Bildunterschrift für "${el.fileName}" konnte nicht gesetzt werden: ${captionError.message}`);
			}
			return true;
		} catch (error) {
			try {
				await client.deleteElement(elem.id);
			} catch (cleanupError) {
				warnings.push(`Datei "${el.fileName}" konnte nicht hochgeladen werden (${error.message}); das angelegte Element konnte auch nicht entfernt werden (${cleanupError.message}).`);
				return false;
			}
			warnings.push(`Datei "${el.fileName}" konnte nicht übertragen werden: ${error.message}`);
			return false;
		}
	}

	// --- RichText-Element mit Plaintext-Fallback ---

	async function addRichTextElement(client, cardId, order, html, warnings) {
		const elem = await client.createElement(cardId, 'richText', order);
		try {
			await client.setRichText(elem.id, html, 'richTextCk5');
			return elem.id;
		} catch (firstError) {
			const fallback = stripHtmlToPlaintext(html).slice(0, 5000);
			try {
				await client.setRichText(elem.id, fallback, 'plainText');
				warnings.push(`RichText wurde mit Plaintext-Fallback gespeichert (Original-Format vom Server abgelehnt: ${firstError.message}).`);
				return elem.id;
			} catch (secondError) {
				warnings.push(`RichText konnte nicht gespeichert werden: ${firstError.message}; Fallback ebenfalls fehlgeschlagen: ${secondError.message}`);
				try { await client.deleteElement(elem.id); } catch { /* letzter Fallschirm */ }
				return null;
			}
		}
	}

	/**
	 * @param {object} client   NbcApiClient-Instanz (lib/nbc-api.js)
	 * @param {object} exportData  {boardTitle, layout, columns, sourceUrl}
	 * @param {{roomId: string}} target
	 * @param {{importColors?: boolean, omitWidgetWarnings?: boolean, addSummaryCard?: boolean, createShareLink?: boolean, shareExpiresInDays?: number}} options
	 * @param {{step: Function, info: Function, ok: Function, err: Function, warn: Function}} logger
	 */
	async function exportBoard(client, exportData, target, options, logger) {
		const warnings = [];
		const summary = { columns: 0, cards: 0, cardsColored: 0, links: 0, filesUploaded: 0, filesFailed: 0 };

		await renderQrCodesInline(exportData.columns, logger);

		let warningCount = countWidgetWarnings(exportData.columns);
		if (options.omitWidgetWarnings) {
			const removed = stripWidgetWarnings(exportData.columns);
			if (removed > 0) {
				logger.info(`${removed} Platzhalter-Hinweise zu nicht abbildbaren Modulen wurden entfernt.`);
				warningCount = 0;
			}
		}
		if (options.addSummaryCard) {
			const added = prependSummaryColumn(exportData, warningCount);
			if (added) logger.info('Zusammenfassungs-Spalte als erste Spalte ergänzt.');
		}

		logger.step(`Board "${exportData.boardTitle}" wird angelegt...`);
		const boardId = await client.createBoard(
			nbcTitle(exportData.boardTitle, 'Import'),
			target.roomId,
			'room',
			exportData.layout || 'columns',
		);
		logger.ok(`✓ Board erstellt: ${boardId}`);

		const anchorToCardId = new Map();
		const pendingInternalLinks = [];
		const pendingAnchorTexts = [];

		for (const [ci, col] of exportData.columns.entries()) {
			logger.step(`[Spalte ${ci + 1}/${exportData.columns.length}] "${col.title}"`);
			const column = await client.createColumn(boardId);
			if (col.title) await client.setColumnTitle(column.id, nbcTitle(col.title));
			summary.columns += 1;

			for (const card of col.cards) {
				const requiredEmptyElements = requiredEmptyElementsFor(card.elements || []);
				const cardResp = await client.createCard(column.id, requiredEmptyElements.length ? requiredEmptyElements : undefined);
				const precreated = precreatedElementsByType(cardResp);
				summary.cards += 1;
				if (card.title) {
					try { await client.setCardTitle(cardResp.id, nbcTitle(card.title)); } catch { /* Titel ist Kosmetik */ }
				}
				if (card.anchorId) anchorToCardId.set(card.anchorId, cardResp.id);
				if (options.importColors && card.backgroundColor && card.backgroundColor !== 'transparent') {
					try {
						await client.setCardColor(cardResp.id, card.backgroundColor);
						summary.cardsColored += 1;
					} catch (error) {
						warnings.push(`Farbe für Karte "${card.title}" konnte nicht gesetzt werden: ${error.message}`);
					}
				}

				const sorted = [...(card.elements || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
				for (const el of sorted) {
					try {
						if (el.type === 'text') {
							const elementId = await addRichTextElement(client, cardResp.id, el.order, el.content, warnings);
							if (elementId && el.content.includes('__ANCHOR__')) {
								pendingAnchorTexts.push({ elementId, rawText: el.content });
							}
						} else if (el.type === 'link') {
							if (!isSafeStoredLinkUrl(el.url)) {
								warnings.push(`Link mit unzulässigem Schema verworfen: ${String(el.url).slice(0, 80)}`);
								continue;
							}
							const elem = await client.createElement(cardResp.id, 'link', el.order);
							await client.setLink(elem.id, { url: el.url, title: el.title || el.url });
							summary.links += 1;
						} else if (el.type === 'internalLink') {
							const elem = await client.createElement(cardResp.id, 'link', el.order);
							pendingInternalLinks.push({ elementId: elem.id, anchor: el.anchor, title: el.title });
						} else if (el.type === 'videoConference') {
							const ids = precreated.get('videoConference') || [];
							const elementId = ids.length ? ids.shift() : (await client.createElement(cardResp.id, 'videoConference', el.order)).id;
							await client.setVideoConference(elementId, el.title || 'Videokonferenz');
						} else if (el.type === 'collaborativeTextEditor') {
							await client.createElement(cardResp.id, 'collaborativeTextEditor', el.order);
							if (el.originalUrl && isSafeStoredLinkUrl(el.originalUrl)) {
								const note = await client.createElement(cardResp.id, 'link', (el.order || 0) + 1);
								await client.setLink(note.id, {
									url: el.originalUrl,
									title: `Original-Pad: ${el.title || 'Teamtext'}`,
									description: 'Der neue NBC-Etherpad oben ist leer. Inhalt aus dem Original-Pad bitte manuell rüberkopieren.',
								});
								summary.links += 1;
							} else if (el.originalUrl) {
								warnings.push(`Original-Pad-Link mit unzulässigem Schema verworfen: ${String(el.originalUrl).slice(0, 80)}`);
							}
						} else if (el.type === 'file') {
							const uploaded = await addFileElement(client, cardResp.id, el.order, el, warnings, logger);
							if (uploaded) summary.filesUploaded += 1;
							else summary.filesFailed += 1;
						} else {
							warnings.push(`Unbekannter Elementtyp übersprungen: ${el.type}`);
						}
					} catch (elementError) {
						warnings.push(`Karten-Element (${el.type}) auf "${card.title}" konnte nicht übernommen werden: ${elementError.message}`);
					}
				}
			}
		}

		const resolveAnchor = (anchorKey) => (
			anchorToCardId.has(anchorKey)
				? `${location.origin}/boards/${boardId}#card-${anchorToCardId.get(anchorKey)}`
				: `${location.origin}/boards/${boardId}`
		);

		if (pendingInternalLinks.length) {
			logger.step(`${pendingInternalLinks.length} interne Karten-Links werden aufgelöst...`);
			for (const { elementId, anchor, title } of pendingInternalLinks) {
				const anchorKey = String(anchor || '').replace(/^#/, '');
				const url = resolveAnchor(anchorKey);
				try {
					await client.setLink(elementId, { url, title });
					summary.links += 1;
					if (!anchorToCardId.has(anchorKey)) logger.warn(`  "${title}" (Anker #${anchorKey} nicht gefunden, Link zeigt auf das Board)`);
				} catch (error) {
					warnings.push(`Interner Link "${title}" konnte nicht aufgelöst werden: ${error.message}`);
				}
			}
		}

		if (pendingAnchorTexts.length) {
			logger.step(`${pendingAnchorTexts.length} Text-Element(e) mit internen Links werden aktualisiert...`);
			for (const { elementId, rawText } of pendingAnchorTexts) {
				const resolved = rawText.replace(/__ANCHOR__([^"]+)/g, (_, key) => resolveAnchor(key));
				try {
					await client.setRichText(elementId, resolved, 'richTextCk5');
				} catch (error) {
					warnings.push(`Text-Element mit internen Links konnte nicht aktualisiert werden: ${error.message}`);
				}
			}
		}

		let shareUrl = null;
		if (options.createShareLink) {
			try {
				logger.info('Teilen-Link wird erstellt...');
				const share = await client.createShareToken(boardId, 'columnBoard', options.shareExpiresInDays);
				shareUrl = client.shareUrl(share.token, 'columnBoard');
				logger.ok('✓ Teilen-Link erstellt.');
			} catch (error) {
				warnings.push(`Teilen-Link konnte nicht erstellt werden: ${error.message}`);
			}
		}

		return {
			boardId,
			boardUrl: `${location.origin}/boards/${boardId}`,
			shareUrl,
			warnings,
			summary,
		};
	}

	const api = { exportBoard, nbcTitle, isSafeStoredLinkUrl, fetchResourceViaBackground };
	self.NBCImport = self.NBCImport || {};
	self.NBCImport.exporter = api;
})();
