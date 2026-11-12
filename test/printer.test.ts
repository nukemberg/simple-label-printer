import { describe, expect, it } from 'vitest';
import { T15BtDriver, t15Raster } from '../src/printer/t15';
import { tapeFromMedia } from '../src/tape';
import type { Bitmap, LabelSpec } from '../src/printer/types';
import { T15Emulator } from './t15-emulator';

/** RETURN_MAT payload (from frame byte 10): id at [27..28], type [29], width [30], length [31], gap [32]. */
function material(id: number, type: number, width: number, length: number, gap: number) {
	const p = new Uint8Array(40);
	p.set([1, 2, 3, 4, 5, 6, 7], 12);
	p[27] = id & 0xff;
	p[28] = id >> 8;
	p[29] = type;
	p[30] = width;
	p[31] = length;
	p[32] = gap;
	return p;
}

function testBitmap(width: number): Bitmap {
	const height = 88;
	const data = new Uint8Array(width * height);
	// A diagonal plus a solid block, so orientation errors show up.
	for (let x = 0; x < width; x++) data[(x % height) * width + x] = 1;
	for (let y = 10; y < 30; y++) for (let x = 40; x < 60; x++) data[y * width + x] = 1;
	return { width, height, data };
}

const label: LabelSpec = {
	id: '25001',
	name: 'test',
	lengthMm: 50,
	widthMm: 15,
	paperDirection: 0,
	paperType: 0,
	gap: 0,
	padding: { top: 0, bottom: 0, left: 0, right: 0 }
};

/** Decode the column bytes the printer received back into a 96-row grid. */
function decode(buffers: Uint8Array[]) {
	const cols: Uint8Array[] = [];
	let skip = 0;
	buffers.forEach((b, i) => {
		const n = b[4] | (b[5] << 8);
		if (i === 0) skip = b[12];
		for (let c = 0; c < n; c++) cols.push(b.subarray(14 + c * 12, 14 + (c + 1) * 12));
	});
	return { cols, skip };
}

describe('tape detection', () => {
	it('maps catalog ids', () => {
		const t = tapeFromMedia({ labelId: 25004, raw: new Uint8Array() });
		expect(t).toMatchObject({ widthMm: 12, lengthMm: 40, continuous: false });
		expect(t?.label).toContain('12×40');
		const c = tapeFromMedia({ labelId: 25001, raw: new Uint8Array() });
		expect(c).toMatchObject({ widthMm: 15, continuous: true });
	});

	it('falls back to the raw size for unknown ids', () => {
		expect(tapeFromMedia({ labelId: 9999, widthMm: 12, lengthMm: 30, paperType: 1, gap: 3, raw: new Uint8Array() })).toMatchObject({
			widthMm: 12,
			lengthMm: 30,
			continuous: false
		});
		expect(tapeFromMedia({ labelId: 0, raw: new Uint8Array() })).toBeNull();
	});

	it('reads the loaded tape from the printer', async () => {
		const emu = new T15Emulator();
		emu.material = material(25004, 1, 12, 40, 3);
		const d = new T15BtDriver(emu, emu.deviceName, 'ble');
		const m = await d.readMedia();
		expect(m).toMatchObject({ labelId: 25004, widthMm: 12, lengthMm: 40, paperType: 1, gap: 3 });
		expect(tapeFromMedia(m!)).toMatchObject({ widthMm: 12, lengthMm: 40, continuous: false });
	});
});

describe.each(['ble', 'spp'] as const)('print over %s', (link) => {
	it('sends a job the printer decodes to the same dots', async () => {
		const emu = new T15Emulator();
		emu.material = material(25001, 0, 15, 50, 0);
		const d = new T15BtDriver(emu, emu.deviceName, link);
		await d.handshake();
		await d.readMedia();
		const bmp = testBitmap(500); // > 332 columns: two buffers
		await d.print([bmp], label, { copies: 1, density: 4 });

		expect(emu.buffers.length).toBe(2);
		expect(emu.printing).toBe(false);
		const { cols, skip } = decode(emu.buffers);
		const expected = t15Raster(bmp);
		expect(cols.length + skip).toBe(expected.cols);
		for (let c = 0; c < cols.length; c++)
			for (let r = 0; r < 96; r++) {
				const got = (cols[c][r >> 3] >> (r & 7)) & 1;
				expect(got, `col ${c + skip} row ${r}`).toBe(expected.data[r * expected.cols + c + skip]);
			}
		// START, head rate, BUF_FULL x2 all went out.
		expect(emu.events.filter((e) => e.startsWith('cmd 10 ')).length).toBe(2);
		expect(emu.events.some((e) => e.startsWith('cmd 13 '))).toBe(true);
	});

	it('refuses to print without tape', async () => {
		const emu = new T15Emulator();
		emu.extra = [0x10, 0, 0, 0];
		const d = new T15BtDriver(emu, emu.deviceName, link);
		await expect(d.print([testBitmap(100)], label, { copies: 1, density: 4 })).rejects.toThrow(/not installed/);
	});
});
