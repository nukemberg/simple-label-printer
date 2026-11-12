import catalog from './tapes.json';
import type { MediaInfo } from './printer/types';

/** A loaded tape, as far as layout and printing care. */
export interface Tape {
	/** Catalog id (e.g. 25004), 0 when unknown. */
	id: number;
	/** Across the tape, mm. */
	widthMm: number;
	/** Along the tape, mm (die-cut only; continuous tapes have no fixed length). */
	lengthMm: number;
	continuous: boolean;
	/** Gap between die-cut labels, mm. */
	gapMm: number;
	/** Hebrew description for the status line. */
	label: string;
	/** Preview background. */
	color: string;
}

interface Entry {
	ID: string;
	Name: string;
	TapeLength: number;
	TapeWidth: number;
	PaperType: number;
	DieCutGap: number;
}

const COLORS: [RegExp, string, string][] = [
	[/^White/i, '#ffffff', 'לבן'],
	[/^Yellow/i, '#fff3a6', 'צהוב'],
	[/^Green/i, '#c8f0c4', 'ירוק'],
	[/^Blue/i, '#c7e0ff', 'כחול'],
	[/^Pink/i, '#ffd1e3', 'ורוד'],
	[/^Purple/i, '#e4d4ff', 'סגול'],
	[/^Transparent/i, '#f2f2f2', 'שקוף']
];

function colorOf(name: string): { color: string; hebrew: string } {
	for (const [re, color, hebrew] of COLORS) if (re.test(name)) return { color, hebrew };
	return { color: '#ffffff', hebrew: 'מעוצב' };
}

const fmt = (mm: number) => String(Math.round(mm * 10) / 10);

export function describe(t: Omit<Tape, 'label'>, colorName?: string): string {
	const kind = t.continuous ? `גליל רציף ${fmt(t.widthMm)} מ״מ` : `מדבקות ${fmt(t.widthMm)}×${fmt(t.lengthMm)} מ״מ`;
	return colorName ? `${kind} ${colorName}` : kind;
}

/** Build a Tape from what the printer reports (RETURN_MAT), preferring the catalog entry. */
export function tapeFromMedia(m: MediaInfo): Tape | null {
	const e = (catalog as Entry[]).find((x) => Number(x.ID) === m.labelId);
	if (e) {
		const { color, hebrew } = colorOf(e.Name);
		const t = {
			id: m.labelId,
			widthMm: e.TapeWidth,
			lengthMm: e.TapeLength,
			continuous: e.PaperType === 0,
			gapMm: e.DieCutGap,
			color
		};
		return { ...t, label: describe(t, hebrew) };
	}
	// Unknown id: trust the raw size the chip reports, if any.
	if (!m.widthMm) return null;
	const t = {
		id: m.labelId,
		widthMm: m.widthMm,
		lengthMm: m.lengthMm ?? 0,
		continuous: m.paperType !== 1 || !m.lengthMm,
		gapMm: m.gap ?? 3,
		color: '#ffffff'
	};
	return { ...t, label: describe(t) };
}

/** Tapes offered in settings when detection fails. */
export const MANUAL_TAPES: Tape[] = [
	{ id: 0, widthMm: 15, lengthMm: 0, continuous: true, gapMm: 0, color: '#ffffff', label: '' },
	{ id: 0, widthMm: 12, lengthMm: 0, continuous: true, gapMm: 0, color: '#ffffff', label: '' },
	{ id: 0, widthMm: 12, lengthMm: 40, continuous: false, gapMm: 3, color: '#ffffff', label: '' },
	{ id: 0, widthMm: 12, lengthMm: 30, continuous: false, gapMm: 3, color: '#ffffff', label: '' },
	{ id: 0, widthMm: 15, lengthMm: 30, continuous: false, gapMm: 3, color: '#ffffff', label: '' },
	{ id: 0, widthMm: 15, lengthMm: 50, continuous: false, gapMm: 3, color: '#ffffff', label: '' }
].map((t) => ({ ...t, label: describe(t) }));

/** Phomemo Q30 rolls (the printer can't report which is loaded; picked once in settings). */
export const Q30_TAPES: Tape[] = [
	{ widthMm: 14, lengthMm: 40, continuous: false },
	{ widthMm: 12, lengthMm: 40, continuous: false },
	{ widthMm: 15, lengthMm: 30, continuous: false },
	{ widthMm: 15, lengthMm: 50, continuous: false },
	{ widthMm: 14, lengthMm: 30, continuous: false },
	{ widthMm: 12, lengthMm: 30, continuous: false },
	{ widthMm: 12, lengthMm: 22, continuous: false },
	{ widthMm: 15, lengthMm: 0, continuous: true },
	{ widthMm: 12, lengthMm: 0, continuous: true }
].map((t) => {
	const tape = { id: 0, gapMm: t.continuous ? 0 : 3, color: '#ffffff', ...t };
	return { ...tape, label: describe(tape) };
});
