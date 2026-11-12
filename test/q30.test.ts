import { describe, expect, it } from 'vitest';
import { encodeQ30, q30Density } from '../src/q30';
import type { Bitmap } from '../src/printer/types';

function bitmap(width: number, height: number, dots: [number, number][]): Bitmap {
	const data = new Uint8Array(width * height);
	for (const [x, y] of dots) data[y * width + x] = 1;
	return { width, height, data };
}

/** Rebuild the bitmap from the raster blocks, undoing the line order and bit packing. */
function decode(parts: Uint8Array[], width: number, height: number): Uint8Array {
	const out = new Uint8Array(width * height);
	let line = 0;
	for (let i = 1; i < parts.length - 1; i += 2) {
		const h = parts[i];
		expect([...h.subarray(0, 4)]).toEqual([0x1d, 0x76, 0x30, 0x00]);
		const bpl = h[4] | (h[5] << 8);
		const n = h[6] | (h[7] << 8);
		expect(n).toBeLessThanOrEqual(255);
		expect(parts[i + 1].length).toBe(bpl * n);
		for (let k = 0; k < n; k++, line++)
			for (let r = 0; r < height; r++)
				if (parts[i + 1][k * bpl + (r >> 3)] & (0x80 >> (r & 7))) out[r * width + (width - 1 - line)] = 1;
	}
	expect(line).toBe(width);
	return out;
}

describe('Phomemo Q30 encoding', () => {
	it('wraps the raster in the confirmed start/end sequence', () => {
		const parts = encodeQ30(bitmap(10, 96, []), { density: 7, continuous: false });
		expect([...parts[0]]).toEqual([0x1b, 0x4e, 0x0d, 0x05, 0x1b, 0x4e, 0x04, 0x0f, 0x1f, 0x11, 0x0a]);
		expect([...parts[parts.length - 1]]).toEqual([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]);
		expect([...parts[1]]).toEqual([0x1d, 0x76, 0x30, 0x00, 12, 0, 10, 0]);
		expect(encodeQ30(bitmap(10, 96, []), { density: 4, continuous: true })[0][10]).toBe(0x0b);
	});

	it('has a plain ESC/POS alternative', () => {
		const parts = encodeQ30(bitmap(10, 96, []), { density: 4, continuous: false, protocol: 'escpos' });
		expect([...parts[0]]).toEqual([0x1b, 0x40]);
		expect([...parts[1]]).toEqual([0x1d, 0x76, 0x30, 0x00, 12, 0, 10, 0]);
		expect([...parts[parts.length - 1]]).toEqual([0x1b, 0x64, 0x00]);
	});

	it('maps density 1..7 onto 3..15', () => {
		expect([1, 4, 7].map(q30Density)).toEqual([3, 9, 15]);
	});

	it('round-trips dots through 255-line blocks (last column first, MSB = top row)', () => {
		const w = 600;
		const h = 120;
		const dots: [number, number][] = [];
		for (let x = 0; x < w; x += 7) dots.push([x, (x * 13) % h]);
		const b = bitmap(w, h, dots);
		const parts = encodeQ30(b, { density: 4, continuous: false });
		expect(parts.length).toBe(1 + 2 * 3 + 1); // 255 + 255 + 90 lines
		expect(decode(parts, w, h)).toEqual(b.data);
		// Top-left dot of the image: last line sent, first byte, MSB.
		const one = encodeQ30(bitmap(4, 96, [[0, 0]]), { density: 4, continuous: false });
		expect(one[2][3 * 12]).toBe(0x80);
	});
});
