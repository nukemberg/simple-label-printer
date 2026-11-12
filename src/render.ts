import type { Bitmap } from './printer/types';
import type { Tape } from './tape';

/** E10: 8 dots/mm, 96-dot head of which the middle 88 are printed. */
export const DPMM = 8;
export const BAND_DOTS = 88;

export interface RenderOptions {
	font: string;
	weight: number;
	/** Blank space before and after the text on continuous tape, mm. */
	marginMm: number;
	/** Shortest continuous label, mm. */
	minLengthMm: number;
	/** Longest continuous label, mm (text shrinks beyond this). */
	maxLengthMm: number;
	/** Share of the printable band the text may take on continuous tape (1 = full height). */
	continuousScale: number;
}

export const DEFAULT_RENDER: RenderOptions = {
	font: 'Heebo',
	weight: 700,
	marginMm: 3,
	minLengthMm: 20,
	maxLengthMm: 250,
	continuousScale: 1
};

export interface Rendered {
	/** Rows run across the tape (BAND_DOTS), columns along it. 1 = black. */
	bitmap: Bitmap;
	lengthMm: number;
	fontPx: number;
	lines: string[];
	/** Text did not fit even at the smallest size. */
	overflow: boolean;
}

const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/** Base direction from the first strong character (Unicode bidi rule P2), default RTL. */
export function directionOf(line: string): 'rtl' | 'ltr' {
	for (const ch of line) {
		if (RTL_CHAR.test(ch)) return 'rtl';
		if (LTR_CHAR.test(ch)) return 'ltr';
	}
	return 'rtl';
}

/** Rows available for text: tape width minus 1 mm at each edge, at most the head's 88 dots. */
export function bandRows(tape: Tape): number {
	return Math.max(24, Math.min(BAND_DOTS, Math.round((tape.widthMm - 2) * DPMM)));
}

interface Metrics {
	width: number;
	left: number;
	right: number;
	ascent: number;
	descent: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx2d(): CanvasRenderingContext2D {
	if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!;
	return measureCtx;
}

const fontSpec = (o: RenderOptions, px: number) => `${o.weight} ${px}px "${o.font}", "Noto Sans Hebrew", Arial, sans-serif`;

function measure(line: string, o: RenderOptions, px: number): Metrics {
	const c = ctx2d();
	c.font = fontSpec(o, px);
	c.direction = directionOf(line);
	c.textAlign = 'center';
	c.textBaseline = 'alphabetic';
	const m = c.measureText(line || ' ');
	const left = m.actualBoundingBoxLeft;
	const right = m.actualBoundingBoxRight;
	// Empty lines still take a line's height.
	const ascent = line.trim() ? m.actualBoundingBoxAscent : px * 0.7;
	const descent = line.trim() ? m.actualBoundingBoxDescent : 0;
	return { width: left + right, left, right, ascent, descent };
}

const lineGap = (px: number) => Math.round(px * 0.18);

function blockSize(lines: string[], o: RenderOptions, px: number) {
	const ms = lines.map((l) => measure(l, o, px));
	const width = Math.max(...ms.map((m) => m.width));
	const height = ms.reduce((h, m) => h + m.ascent + m.descent, 0) + lineGap(px) * (lines.length - 1);
	return { ms, width, height };
}

/** Largest font size (px == dots) at which `lines` fit in maxW x maxH. */
function fitSize(lines: string[], o: RenderOptions, maxW: number, maxH: number): number {
	let lo = 4;
	let hi = 400;
	if (!fits(lo)) return 0;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (fits(mid)) lo = mid;
		else hi = mid - 1;
	}
	return lo;
	function fits(px: number) {
		const b = blockSize(lines, o, px);
		return b.width <= maxW && b.height <= maxH;
	}
}

/** Every way to break the words into 1..maxLines lines (in order). */
function wraps(text: string, maxLines: number): string[][] {
	const words = text.split(/\s+/).filter(Boolean);
	const out: string[][] = [[words.join(' ')]];
	if (words.length < 2) return out;
	const n = words.length;
	for (let i = 1; i < n; i++) {
		out.push([words.slice(0, i).join(' '), words.slice(i).join(' ')]);
		if (maxLines >= 3) for (let j = i + 1; j < n; j++) out.push([words.slice(0, i).join(' '), words.slice(i, j).join(' '), words.slice(j).join(' ')]);
	}
	return out;
}

/**
 * Lay the text out on the tape at the largest size that fits:
 * - continuous tape: the text's own lines at the full band height; the label is as long as the text;
 * - die-cut labels: fixed box; a single typed line may be wrapped into up to 3 lines if that is bigger.
 */
export function renderLabel(text: string, tape: Tape, o: RenderOptions = DEFAULT_RENDER): Rendered {
	const rows = BAND_DOTS;
	const maxH = bandRows(tape);
	const typed = text.replace(/\r/g, '').split('\n');
	while (typed.length > 1 && !typed[typed.length - 1].trim()) typed.pop();
	const empty = !text.trim();

	let lines = typed;
	let px: number;
	let cols: number;
	let overflow = false;

	if (tape.continuous) {
		const margin = Math.round(o.marginMm * DPMM);
		const maxW = Math.round(o.maxLengthMm * DPMM) - 2 * margin;
		px = empty ? 0 : fitSize(lines, o, maxW, Math.round(maxH * o.continuousScale));
		const w = px ? blockSize(lines, o, px).width : 0;
		cols = Math.max(Math.round(o.minLengthMm * DPMM), Math.ceil(w) + 2 * margin);
	} else {
		cols = Math.round(tape.lengthMm * DPMM);
		// 2 mm clear of each die-cut edge.
		const maxW = cols - 4 * DPMM;
		px = 0;
		if (!empty) {
			const candidates = typed.length === 1 ? wraps(typed[0], maxH >= 64 ? 3 : 2) : [typed];
			const fitted = candidates
				.map((c) => {
					const s = fitSize(c, o, maxW, maxH);
					return { px: s, lines: c, width: s ? blockSize(c, o, s).width / s : Infinity };
				})
				.filter((f) => f.px);
			const top = Math.max(0, ...fitted.map((f) => f.px));
			// Within 10% of the biggest possible text: fewest lines, then the most balanced lines.
			const best = fitted
				.filter((f) => f.px >= top * 0.9)
				.sort((a, b) => a.lines.length - b.lines.length || a.width - b.width || b.px - a.px)[0];
			if (best) {
				px = best.px;
				lines = best.lines;
			}
		}
	}
	if (!empty && !px) overflow = true;

	const canvas = document.createElement('canvas');
	canvas.width = cols;
	canvas.height = rows;
	const c = canvas.getContext('2d', { willReadFrequently: true })!;
	c.fillStyle = '#fff';
	c.fillRect(0, 0, cols, rows);
	if (px) {
		const { ms, height } = blockSize(lines, o, px);
		c.fillStyle = '#000';
		c.font = fontSpec(o, px);
		c.textAlign = 'center';
		c.textBaseline = 'alphabetic';
		let y = (rows - height) / 2;
		lines.forEach((line, i) => {
			const m = ms[i];
			y += m.ascent;
			c.direction = directionOf(line);
			// Center the ink, not the advance box.
			c.fillText(line, cols / 2 - (m.right - m.left) / 2, Math.round(y));
			y += m.descent + lineGap(px);
		});
	}
	const img = c.getImageData(0, 0, cols, rows).data;
	const data = new Uint8Array(cols * rows);
	for (let i = 0; i < data.length; i++) data[i] = img[i * 4] < 128 ? 1 : 0;
	return { bitmap: { width: cols, height: rows, data }, lengthMm: cols / DPMM, fontPx: px, lines, overflow };
}

/** Rotate a bitmap 180° (for printers/tapes that come out upside down). */
export function rotate180(b: Bitmap): Bitmap {
	return { width: b.width, height: b.height, data: b.data.slice().reverse() };
}
