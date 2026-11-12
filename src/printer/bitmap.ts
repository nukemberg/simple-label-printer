/**
 * Bit grid helpers. Vendored (trimmed) from khromov/supvan-katasymbol-printer-web-ui (MIT,
 * see LICENSE-khromov), src/lib/printer/bitmap.ts.
 */
import type { Bitmap } from './types';

export interface Grid {
	rows: number;
	cols: number;
	data: Uint8Array;
}

export const fromBitmap = (b: Bitmap): Grid => ({ rows: b.height, cols: b.width, data: b.data });

/** Keep the centered `max` rows. */
export function cropRowsCentered(g: Grid, max: number): Grid {
	if (g.rows <= max) return g;
	const off = Math.floor((g.rows - max) / 2);
	return { rows: max, cols: g.cols, data: g.data.slice(off * g.cols, (off + max) * g.cols) };
}
