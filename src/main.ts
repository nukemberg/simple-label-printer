import '@fontsource/heebo/500.css';
import '@fontsource/heebo/700.css';
import '@fontsource/heebo/900.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { bleSupported, Printer, serialSupported, type LinkKind, type PrinterInfo } from './connection';
import { BAND_DOTS, DEFAULT_RENDER, DPMM, renderLabel, rotate180, type Rendered } from './render';
import { MANUAL_TAPES, type Tape } from './tape';
import type { Bitmap } from './printer/types';

registerSW({ immediate: true });

// ---------- settings (per browser) ----------

interface Settings {
	link: LinkKind;
	density: number;
	weight: number;
	rotate: boolean;
	/** Text height on continuous tape, share of the band. */
	size: number;
	/** -1 = auto-detect, else index into MANUAL_TAPES. */
	tape: number;
	lastTape: Tape | null;
	recent: string[];
}

const defaults: Settings = {
	link: bleSupported() || !serialSupported() ? 'ble' : 'serial',
	density: 4,
	weight: 700,
	rotate: false,
	size: 1,
	tape: -1,
	lastTape: null,
	recent: []
};

function load(): Settings {
	try {
		return { ...defaults, ...JSON.parse(localStorage.getItem('settings') ?? '{}') };
	} catch {
		return { ...defaults };
	}
}
const settings = load();
function save() {
	try {
		localStorage.setItem('settings', JSON.stringify(settings));
	} catch {
		/* private mode: settings just won't stick */
	}
}

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const textEl = $<HTMLTextAreaElement>('text');
const statusBtn = $<HTMLButtonElement>('status');
const statusText = $('status-text');
const batteryEl = $('battery');
const tapeEl = $('tape');
const previewEl = $<HTMLCanvasElement>('preview');
const noteEl = $('preview-note');
const copiesEl = $<HTMLOutputElement>('copies');
const messageEl = $('message');
const printBtn = $<HTMLButtonElement>('print');
const recentEl = $('recent');
const dialog = $<HTMLDialogElement>('settings');
const setLink = $<HTMLSelectElement>('set-link');
const setTape = $<HTMLSelectElement>('set-tape');
const setDensity = $<HTMLInputElement>('set-density');
const densityOut = $<HTMLOutputElement>('density-out');
const setWeight = $<HTMLSelectElement>('set-weight');
const setRotate = $<HTMLInputElement>('set-rotate');
const setSize = $<HTMLSelectElement>('set-size');
const logEl = $<HTMLTextAreaElement>('log');

// ---------- printer ----------

const printer = new Printer(onPrinterChange);
let copies = 1;
let rendered: Rendered | null = null;
let busy = false;

const PROBLEMS: [RegExp, string][] = [
	[/tape is not installed|install the label tape/i, 'אין גליל מדבקות במדפסת. צריך להכניס גליל.'],
	[/low battery/i, 'הסוללה חלשה. צריך לחבר את המדפסת למטען.'],
	[/cover is open/i, 'המכסה של המדפסת פתוח. צריך לסגור אותו.'],
	[/no label detected/i, 'המדפסת לא מזהה מדבקות. צריך לבדוק את הגליל.'],
	[/used up/i, 'המדבקות נגמרו. צריך גליל חדש.'],
	[/stopped on the device/i, 'ההדפסה נעצרה במדפסת.'],
	[/did not respond|timed out|did not acknowledge|did not start|did not finish/i, 'המדפסת לא עונה. לוודא שהיא דלוקה וקרובה לטלפון.'],
	[/not connected|gatt|network|disconnected/i, 'החיבור למדפסת נותק. לנסות שוב.'],
	[/does not offer|no services|getPrimaryService/i, 'זו לא מדפסת מוכרת.']
];

function hebrewError(e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	for (const [re, he] of PROBLEMS) if (re.test(msg)) return he;
	return `משהו השתבש: ${msg}`;
}

/** The user closed the browser's chooser without picking anything. */
const cancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'AbortError');

function currentTape(): Tape {
	if (settings.tape >= 0 && MANUAL_TAPES[settings.tape]) return MANUAL_TAPES[settings.tape];
	return printer.info.tape ?? settings.lastTape ?? MANUAL_TAPES[0];
}

function onPrinterChange(info: PrinterInfo) {
	if (info.tape && JSON.stringify(info.tape) !== JSON.stringify(settings.lastTape)) {
		settings.lastTape = info.tape;
		save();
	}
	let state: string = info.state;
	let text: string;
	switch (info.state) {
		case 'off':
			text = 'לא מחוברת · לחצו לחיבור';
			break;
		case 'connecting':
			text = 'מתחברים למדפסת…';
			break;
		case 'printing':
			text = 'מדפיסים…';
			break;
		default:
			if (info.problem) {
				state = 'problem';
				text = hebrewError(info.problem);
			} else if (settings.tape >= 0) text = `${currentTape().label} (ידני)`;
			else text = info.tape ? info.tape.label : 'מחוברת · סוג המדבקה לא זוהה';
	}
	statusBtn.dataset.state = state;
	statusText.textContent = text;
	if (info.state !== 'off' && info.batteryLevel !== undefined) {
		batteryEl.hidden = false;
		batteryEl.textContent = `${info.charging ? '⚡' : '🔋'} ${Math.round((info.batteryLevel / 4) * 100)}%`;
	} else batteryEl.hidden = true;
	updatePrintButton();
	draw();
}

function updatePrintButton() {
	const s = printer.info.state;
	printBtn.disabled = busy || s === 'connecting' || s === 'printing';
	printBtn.textContent = s === 'printing' ? 'מדפיסים…' : s === 'connecting' ? 'מתחברים…' : s === 'off' ? 'חיבור והדפסה' : 'הדפסה';
}

let messageTimer: ReturnType<typeof setTimeout> | undefined;
function showMessage(text: string, ok = false) {
	clearTimeout(messageTimer);
	messageEl.textContent = text;
	messageEl.classList.toggle('ok', ok);
	messageEl.hidden = !text;
	if (ok) messageTimer = setTimeout(() => (messageEl.hidden = true), 3500);
}

// ---------- rendering / preview ----------

function render(text: string): Rendered {
	return renderLabel(text, currentTape(), { ...DEFAULT_RENDER, weight: settings.weight, continuousScale: settings.size });
}

function draw() {
	const tape = currentTape();
	rendered = render(textEl.value);
	const { bitmap } = rendered;
	// Show the whole tape width; the printed band sits in the middle.
	const tapeRows = Math.max(BAND_DOTS, Math.round(tape.widthMm * DPMM));
	const top = Math.floor((tapeRows - BAND_DOTS) / 2);
	previewEl.width = bitmap.width;
	previewEl.height = tapeRows;
	const c = previewEl.getContext('2d')!;
	const img = c.createImageData(bitmap.width, tapeRows);
	for (let r = 0; r < BAND_DOTS; r++)
		for (let col = 0; col < bitmap.width; col++)
			if (bitmap.data[r * bitmap.width + col]) {
				const i = ((r + top) * bitmap.width + col) * 4;
				img.data[i + 3] = 255;
			}
	c.putImageData(img, 0, 0);

	const avail = Math.min(tapeEl.parentElement!.clientWidth || 340, 608) - 2;
	const scale = Math.min(avail / bitmap.width, 150 / tapeRows, 4);
	previewEl.style.width = `${Math.round(bitmap.width * scale)}px`;
	previewEl.style.height = `${Math.round(tapeRows * scale)}px`;
	tapeEl.style.background = tape.color;
	tapeEl.classList.toggle('continuous', tape.continuous);
	tapeEl.classList.toggle('die-cut', !tape.continuous);

	const mm = Math.round(rendered.lengthMm);
	if (rendered.overflow) noteEl.textContent = 'הטקסט ארוך מדי למדבקה הזו';
	else if (!textEl.value.trim()) noteEl.textContent = '';
	else noteEl.textContent = tape.continuous ? `אורך המדבקה: ${mm} מ״מ` : `מדבקה ${tape.widthMm}×${tape.lengthMm} מ״מ`;
}

// ---------- recent texts ----------

function drawRecent() {
	recentEl.replaceChildren(
		...settings.recent.map((t) => {
			const b = document.createElement('button');
			b.type = 'button';
			b.dir = 'auto';
			b.textContent = t.replace(/\n/g, ' ⏎ ');
			b.addEventListener('click', () => {
				textEl.value = t;
				showMessage('');
				draw();
			});
			return b;
		})
	);
}

function remember(text: string) {
	settings.recent = [text, ...settings.recent.filter((t) => t !== text)].slice(0, 6);
	save();
	drawRecent();
}

// ---------- actions ----------

async function connect(): Promise<boolean> {
	if (printer.connected) return true;
	const kind = settings.link;
	if (kind === 'ble' && !bleSupported()) {
		showMessage('הדפדפן הזה לא תומך בבלוטות׳. צריך לפתוח את הדף ב-Chrome.');
		return false;
	}
	if (kind === 'serial' && !serialSupported()) {
		showMessage('הדפדפן הזה לא תומך בחיבור Serial. אפשר לבחור BLE בהגדרות.');
		return false;
	}
	try {
		// The chooser must open straight from the click; try the remembered printer only if allowed.
		if (kind === 'serial' && (await printer.reconnect('serial'))) return true;
		await printer.connectInteractive(kind);
		showMessage('');
		return true;
	} catch (e) {
		if (!cancelled(e)) showMessage(hebrewError(e));
		return false;
	}
}

async function print(bitmap?: Bitmap) {
	if (busy) return;
	busy = true;
	updatePrintButton();
	try {
		if (!(await connect())) return;
		const text = textEl.value;
		if (!bitmap) {
			if (!text.trim()) {
				showMessage('צריך קודם לכתוב משהו.');
				textEl.focus();
				return;
			}
			draw();
			if (!rendered || rendered.overflow) {
				showMessage('הטקסט ארוך מדי למדבקה הזו.');
				return;
			}
			bitmap = rendered.bitmap;
		}
		if (printer.info.problem) {
			// Re-check: the problem may have been fixed since the last poll.
			await printer.refresh().catch(() => {});
			if (printer.info.problem) {
				showMessage(hebrewError(printer.info.problem));
				return;
			}
		}
		showMessage('');
		const isText = bitmap === rendered?.bitmap;
		await printer.print(settings.rotate ? rotate180(bitmap) : bitmap, currentTape(), { copies, density: settings.density });
		if (isText) remember(text);
		copies = 1;
		copiesEl.value = '1';
		showMessage('הודפס ✓', true);
	} catch (e) {
		showMessage(hebrewError(e));
	} finally {
		busy = false;
		updatePrintButton();
	}
}

function testBitmap(): Bitmap {
	const r = renderLabel('בדיקה 123 ABC', currentTape(), { ...DEFAULT_RENDER, weight: settings.weight });
	const b = r.bitmap;
	const d = b.data.slice();
	const w = b.width;
	const band = Math.round((BAND_DOTS - Math.min(BAND_DOTS, Math.round((currentTape().widthMm - 2) * DPMM))) / 2);
	for (let x = 8; x < w - 8; x++) {
		d[band * w + x] = 1;
		d[(BAND_DOTS - 1 - band) * w + x] = 1;
	}
	for (let y = band; y < BAND_DOTS - band; y++) {
		d[y * w + 8] = 1;
		d[y * w + w - 9] = 1;
	}
	return { ...b, data: d };
}

// ---------- wiring ----------

textEl.addEventListener('input', () => {
	if (!messageEl.classList.contains('ok')) showMessage('');
	draw();
});
printBtn.addEventListener('click', () => void print());
$('plus').addEventListener('click', () => {
	copies = Math.min(20, copies + 1);
	copiesEl.value = String(copies);
});
$('minus').addEventListener('click', () => {
	copies = Math.max(1, copies - 1);
	copiesEl.value = String(copies);
});
statusBtn.addEventListener('click', async () => {
	if (printer.info.state === 'off') {
		busy = true;
		updatePrintButton();
		await connect();
		busy = false;
		updatePrintButton();
	} else if (printer.info.state === 'ready') await printer.refresh().catch(() => {});
});

// Settings dialog
setTape.replaceChildren(
	new Option('זיהוי אוטומטי', '-1'),
	...MANUAL_TAPES.map((t, i) => new Option(t.label, String(i)))
);
$('open-settings').addEventListener('click', () => {
	setLink.value = settings.link;
	setTape.value = String(settings.tape);
	setDensity.value = String(settings.density);
	densityOut.value = String(settings.density);
	setWeight.value = String(settings.weight);
	setRotate.checked = settings.rotate;
	setSize.value = String(settings.size);
	logEl.value = printer.log.join('\n');
	dialog.showModal();
});
setLink.addEventListener('change', async () => {
	settings.link = setLink.value as LinkKind;
	save();
	await printer.disconnect();
});
setTape.addEventListener('change', () => {
	settings.tape = Number(setTape.value);
	save();
	onPrinterChange(printer.info);
});
setDensity.addEventListener('input', () => {
	settings.density = Number(setDensity.value);
	densityOut.value = setDensity.value;
	save();
});
setWeight.addEventListener('change', () => {
	settings.weight = Number(setWeight.value);
	save();
	draw();
});
setSize.addEventListener('change', () => {
	settings.size = Number(setSize.value);
	save();
	draw();
});
setRotate.addEventListener('change', () => {
	settings.rotate = setRotate.checked;
	save();
});
$('test-print').addEventListener('click', () => {
	dialog.close();
	void print(testBitmap());
});
$('disconnect').addEventListener('click', () => void printer.disconnect());
$('copy-log').addEventListener('click', () => {
	logEl.value = printer.log.join('\n');
	void navigator.clipboard?.writeText(logEl.value).catch(() => {});
});

window.addEventListener('resize', () => draw());
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'visible' && printer.info.state === 'off') void printer.reconnect(settings.link);
});

// ---------- start ----------

async function start() {
	// The canvas only uses a web font once it has loaded; load the Hebrew and Latin parts.
	await Promise.all(
		[500, 700, 900].map((w) => document.fonts.load(`${w} 40px Heebo`, 'אבג abc 123').catch(() => [])),
	);
	drawRecent();
	onPrinterChange(printer.info);
	textEl.focus();
	void printer.reconnect(settings.link).then((ok) => ok && showMessage(''));
}
void start();
