// Button + Panel auf einer Raum-Seite (https://niedersachsen.cloud/rooms/:id).
//
// Style-Muster (Overlay/Panel/Log-Farben) aus
// nbc-files/userscript/nbc-team-tools.user.js:1207-1252 übernommen, damit
// beide Werkzeuge auf derselben Seite gleich aussehen.
(function () {
	'use strict';

	// background.js reicht dieses Script nach einem Extension-Reload/-Update
	// in schon offene NBC-Tabs nach (chrome.runtime.onInstalled), damit man
	// nicht jedes Mal F5 drücken muss. Eine bereits laufende ALTE Instanz
	// in genau diesem Tab hat dann aber ein totes `chrome.runtime` --
	// die Extension-Seite dahinter existiert nicht mehr ("Cannot read
	// properties of undefined (reading 'sendMessage')"). Ein simples
	// "schon geladen, dann nichts tun"-Flag würde die neue, funktionierende
	// Instanz aussperren und den Tab dauerhaft an der toten hängen lassen
	// -- deshalb hier stattdessen: alte UI/Poller wegräumen und neu
	// aufsetzen, statt früh auszusteigen.
	const existingOverlay = document.getElementById('nbcimp-overlay');
	if (existingOverlay) existingOverlay.remove();
	const existingButton = document.getElementById('nbcimp-btn');
	if (existingButton) existingButton.remove();
	if (window.__nbcBoardImportInterval) clearInterval(window.__nbcBoardImportInterval);

	const CSS = `
	#nbcimp-btn { position: fixed; bottom: 24px; right: 24px; z-index: 9998; padding: 8px 16px;
		border-radius: 4px; border: 1px solid #4a90d9; background: #4a90d9; color: #fff;
		font-family: "PT Sans", system-ui, sans-serif; font-size: 14px; cursor: pointer;
		box-shadow: 0 2px 8px rgba(0,0,0,.2); }
	#nbcimp-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 99999;
		display: flex; align-items: center; justify-content: center; font-family: "PT Sans", system-ui, sans-serif; }
	#nbcimp-panel { background: #fff; width: min(760px, 94vw); max-height: 88vh; overflow: auto;
		border-radius: 8px; padding: 24px 28px; box-shadow: 0 10px 40px rgba(0,0,0,.3); color: #222; }
	#nbcimp-panel h2 { margin: 0 0 4px; font-size: 20px; }
	#nbcimp-panel .nbcimp-sub { color: #666; font-size: 13px; margin-bottom: 18px; }
	#nbcimp-panel .nbcimp-row { display: flex; gap: 12px; align-items: center; margin: 10px 0; flex-wrap: wrap; }
	#nbcimp-panel label { font-size: 13px; color: #444; display: flex; align-items: center; gap: 6px; }
	#nbcimp-panel input[type=url], #nbcimp-panel input[type=number] {
		padding: 7px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
	#nbcimp-panel input[type=url] { flex: 1 1 auto; min-width: 260px; }
	#nbcimp-panel input[type=number] { width: 90px; }
	#nbcimp-panel .nbcimp-warn { background: #fff4e5; border-left: 3px solid #e8a33d; padding: 10px 14px;
		font-size: 13px; margin: 12px 0; border-radius: 0 4px 4px 0; }
	#nbcimp-panel .nbcimp-note { background: #f5f7f9; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin: 12px 0; }
	#nbcimp-panel .nbcimp-log { font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: #1e2227;
		color: #d4d7dd; border-radius: 6px; padding: 12px; max-height: 260px; overflow: auto; white-space: pre-wrap; margin-top: 14px; }
	#nbcimp-panel .nbcimp-log .ok { color: #7ec87e; }
	#nbcimp-panel .nbcimp-log .bad { color: #ff8b7b; }
	#nbcimp-panel .nbcimp-log .warn { color: #f0c060; }
	#nbcimp-panel .nbcimp-log .step { color: #7fb8f0; }
	#nbcimp-panel button { padding: 8px 16px; border-radius: 4px; border: 1px solid #b8c4cc;
		background: #fff; cursor: pointer; font-size: 14px; }
	#nbcimp-panel button.primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
	#nbcimp-panel button:disabled { opacity: .5; cursor: not-allowed; }
	#nbcimp-status { font-size: 13px; color: #333; margin-top: 12px; min-height: 18px; }
	`;

	function injectStyle() {
		if (document.getElementById('nbcimp-style')) return;
		const style = document.createElement('style');
		style.id = 'nbcimp-style';
		style.textContent = CSS;
		document.head.appendChild(style);
	}

	function getRoomContext() {
		const m = location.pathname.match(/\/rooms\/([0-9a-f]{24})/i);
		return m ? { roomId: m[1] } : null;
	}

	function detectSourceType(url) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return null;
		}
		if (self.NBCImport.taskcards.parseBoardLink(url)) return 'taskcards';
		const host = parsed.hostname.toLowerCase();
		if (host === 'edumaps.de' || host.endsWith('.edumaps.de')) return 'edumaps';
		return null;
	}

	async function fetchEdumapsBoard(url) {
		const fetched = await self.NBCImport.exporter.fetchResourceViaBackground(url, 'text', 'omit');
		if (!fetched || !fetched.ok) throw new Error((fetched && fetched.error) || 'Edumaps-Seite konnte nicht geladen werden.');
		if (fetched.status >= 400) throw new Error(`Edumaps antwortet mit HTTP ${fetched.status}.`);
		const doc = new DOMParser().parseFromString(fetched.text, 'text/html');
		const pathname = new URL(fetched.finalUrl || url).pathname;
		const { columns, boardTitle } = self.NBCImport.edumapsParser.parseDocument(doc, pathname);
		if (!columns || columns.length === 0 || columns.every((c) => !c.cards || c.cards.length === 0)) {
			throw new Error('Keine Inhalte auf der Seite gefunden. Ist die URL öffentlich und ein Board?');
		}
		const exportData = self.NBCImport.edumapsParser.buildExport(columns, boardTitle);
		exportData.sourceUrl = url;
		exportData.layout = 'columns';
		return exportData;
	}

	async function fetchTaskcardsBoard(url) {
		const link = self.NBCImport.taskcards.parseBoardLink(url);
		if (!link) throw new Error('Keine gültige Taskcards-Board-URL.');
		const response = await chrome.runtime.sendMessage({
			type: 'nbcImport:taskcardsFetchBoard',
			boardId: link.boardId,
			token: link.token,
			baseUrl: link.baseUrl,
		});
		if (!response || !response.ok) throw new Error((response && response.error) || 'Taskcards-Board konnte nicht geladen werden.');
		return self.NBCImport.taskcards.mapBoard(response.board, url);
	}

	function makeLogger(logEl, statusEl) {
		const addLine = (text, cls) => {
			const line = document.createElement('div');
			if (cls) line.className = cls;
			line.textContent = text;
			logEl.appendChild(line);
			logEl.scrollTop = logEl.scrollHeight;
		};
		return {
			step: (t) => { statusEl.textContent = t; addLine(t, 'step'); },
			info: (t) => addLine(t),
			ok: (t) => addLine(t, 'ok'),
			err: (t) => addLine(t, 'bad'),
			warn: (t) => addLine(t, 'warn'),
		};
	}

	function openPanel(ctx) {
		injectStyle();
		const overlay = document.createElement('div');
		overlay.id = 'nbcimp-overlay';
		overlay.innerHTML = `
			<div id="nbcimp-panel">
				<h2>Board importieren</h2>
				<div class="nbcimp-sub">Taskcards- oder Edumaps-Link einfügen -- das Board entsteht als neuer Bereich in diesem Raum.</div>
				<div class="nbcimp-row">
					<input type="url" id="nbcimp-url" placeholder="https://www.taskcards.de/#/board/... oder https://www.edumaps.de/...">
				</div>
				<div class="nbcimp-row">
					<label><input type="checkbox" id="nbcimp-colors" checked> Karten-Farben übernehmen</label>
					<label><input type="checkbox" id="nbcimp-omit-warnings"> Platzhalter für nicht abbildbare Module weglassen</label>
				</div>
				<div class="nbcimp-row">
					<label><input type="checkbox" id="nbcimp-summary"> Zusammenfassungs-Spalte voranstellen</label>
					<label><input type="checkbox" id="nbcimp-share"> Teilen-Link erzeugen</label>
				</div>
				<div class="nbcimp-note">
					Öffentliche Boards reichen normalerweise aus. Bei einer Quelle mit
					eigenem Login läuft der Abruf mit der Session dieses Browsers --
					vorher auf der Quellseite einloggen.
				</div>
				<div id="nbcimp-status"></div>
				<div class="nbcimp-log" id="nbcimp-log" hidden></div>
				<div class="nbcimp-row" style="margin-top:18px; justify-content:flex-end;">
					<button id="nbcimp-close">Schließen</button>
					<button id="nbcimp-start" class="primary">Import starten</button>
				</div>
			</div>`;
		document.body.appendChild(overlay);

		const urlInput = overlay.querySelector('#nbcimp-url');
		const statusEl = overlay.querySelector('#nbcimp-status');
		const logEl = overlay.querySelector('#nbcimp-log');
		const startBtn = overlay.querySelector('#nbcimp-start');
		const closeBtn = overlay.querySelector('#nbcimp-close');
		const logger = makeLogger(logEl, statusEl);

		closeBtn.addEventListener('click', () => overlay.remove());
		overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });

		startBtn.addEventListener('click', async () => {
			const url = urlInput.value.trim();
			if (!url) { statusEl.textContent = 'Bitte zuerst eine Board-URL einfügen.'; return; }
			const sourceType = detectSourceType(url);
			if (!sourceType) {
				statusEl.textContent = 'Diese URL wird nicht erkannt -- unterstützt sind Taskcards- und Edumaps-Board-Links.';
				return;
			}

			startBtn.disabled = true;
			urlInput.disabled = true;
			logEl.hidden = false;

			const options = {
				importColors: overlay.querySelector('#nbcimp-colors').checked,
				omitWidgetWarnings: overlay.querySelector('#nbcimp-omit-warnings').checked,
				addSummaryCard: overlay.querySelector('#nbcimp-summary').checked,
				createShareLink: overlay.querySelector('#nbcimp-share').checked,
			};

			try {
				logger.step(`${sourceType === 'taskcards' ? 'Taskcards' : 'Edumaps'}-Board wird geladen...`);
				const exportData = sourceType === 'taskcards' ? await fetchTaskcardsBoard(url) : await fetchEdumapsBoard(url);
				logger.ok(`✓ "${exportData.boardTitle}" geladen -- ${exportData.totalColumns} Spalte(n), ${exportData.totalCards} Karte(n).`);

				const client = new self.NBCImport.nbcApi.NbcApiClient();
				const result = await self.NBCImport.exporter.exportBoard(client, exportData, { roomId: ctx.roomId }, options, logger);

				for (const warning of result.warnings) logger.warn(warning);
				logger.ok(`✓ Import abgeschlossen: ${result.summary.cards} Karte(n), ${result.summary.filesUploaded} Datei(en)${result.summary.filesFailed ? `, ${result.summary.filesFailed} Datei(en) fehlgeschlagen` : ''}.`);
				if (result.shareUrl) logger.info(`Teilen-Link: ${result.shareUrl}`);

				statusEl.textContent = result.warnings.length
					? `Import beendet -- mit ${result.warnings.length} Hinweis(en), siehe Protokoll.`
					: 'Import abgeschlossen.';

				startBtn.textContent = 'Schließen + Neu laden';
				startBtn.disabled = false;
				startBtn.onclick = () => { overlay.remove(); location.reload(); };
			} catch (error) {
				// Bricht der Import mittendrin ab, sind die Spalten/Karten/
				// Dateien bis zu diesem Punkt trotzdem schon im Raum angelegt
				// -- exportBoard() arbeitet die Struktur sequentiell ab und
				// jeder API-Aufruf, der im Protokoll oben als "✓" steht, ist
				// bereits passiert. "Abgebrochen" klingt nach "nichts
				// passiert" und ist damit irreführend; die Meldung schickt
				// deshalb erst zur Kontrolle in den Raum, statt reflexhaft
				// zu einem Neuladen zu raten.
				const message = (error && error.message) || String(error);
				const staleExtension = /Extension context invalidated|reading 'sendMessage'|receiving end does not exist/i.test(message);
				logger.err(`Import angehalten: ${message}`);
				if (staleExtension) {
					logger.warn('Das deutet auf einen Extension-Reload während des Imports hin -- nicht auf einen Fehler in den Daten.');
				}
				statusEl.textContent = staleExtension
					? 'Import angehalten (vermutlich Extension währenddessen neu geladen) -- im Raum kontrollieren, was schon da ist, und nur bei Bedarf die Seite neu laden.'
					: 'Import angehalten -- im Raum kontrollieren, was bis hierhin angelegt wurde (siehe Protokoll oben), bevor du es erneut versuchst.';
				startBtn.disabled = false;
				urlInput.disabled = false;
			}
		});
	}

	function ensureButton() {
		const ctx = getRoomContext();
		const existing = document.getElementById('nbcimp-btn');
		if (!ctx) {
			if (existing) existing.remove();
			return;
		}
		if (existing) return;
		injectStyle();
		const btn = document.createElement('button');
		btn.id = 'nbcimp-btn';
		btn.textContent = 'Board importieren';
		btn.addEventListener('click', () => openPanel(ctx));
		document.body.appendChild(btn);
	}

	// Die NBC ist eine Nuxt-SPA -- Raumwechsel passieren meist ohne volle
	// Navigation, das Content-Script läuft aber nur einmal pro echter
	// Navigation. Ein einfacher Href-Poller reicht hier aus (kein
	// zuverlässiger SPA-Router-Hook verfügbar) und hält den Button in Sync,
	// wenn zwischen Räumen gewechselt wird.
	let lastHref = location.href;
	window.__nbcBoardImportInterval = setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			ensureButton();
		}
	}, 800);

	ensureButton();
})();
