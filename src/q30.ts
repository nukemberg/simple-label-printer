/**
 * Phomemo Q30 over Bluetooth LE: ESC/POS raster.
 *
 * Protocol from flyingmaulwurf/ha-phomemo-q30 (MIT; sequence confirmed on a real Q30 with gap
 * labels), dmsc/web-label-printer (BLE ids, browser chunking) and vivier/phomemo-tools (M110-family
 * command meanings):
 *   service ff00, write ff02 (ff03 notifies an ack per write, not needed here)
 *   1B 4E 0D <speed 1..5>   print speed
 *   1B 4E 04 <density 1..F> print density
 *   1F 11 <media>           0A = labels with gaps, 0B = continuous
 *   1D 76 30 00 <bytes/line LE16> <lines LE16> <data>   raster, at most 255 lines per block
 *   1F F0 05 00, 1F F0 03 00                            end of job / feed to the next gap
 *
 * The printer reports nothing usable about the loaded labels, so the label size is chosen by hand.
 */
import { sleep } from './printer/frame';
import type { Bitmap } from './printer/types';

export const Q30_SERVICE = '0000ff00-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR = '0000ff02-0000-1000-8000-00805f9b34fb';
const MAX_BLOCK_LINES = 255;
const CHUNK = 128;

export interface Q30JobOptions {
	/** 1..7 like the E10 setting; mapped to the printer's 1..15. */
	density: number;
	continuous: boolean;
}

/** Printer density (1..15) for the app's 1..7 scale: 1→3, 4→9, 7→15. */
export const q30Density = (d: number) => Math.min(15, Math.max(1, 3 + 2 * (Math.round(d) - 1)));

/**
 * Encode one label. The bitmap's columns run along the tape, rows across it (row 0 = top of the
 * text). Each printed line is one column, last column first (the printer feeds the label end first),
 * 8 dots per byte, MSB = row 0, 1 = black.
 */
export function encodeQ30(b: Bitmap, opts: Q30JobOptions): Uint8Array[] {
	const bpl = Math.ceil(b.height / 8);
	const lines = b.width;
	const data = new Uint8Array(bpl * lines);
	for (let i = 0; i < lines; i++) {
		const col = b.width - 1 - i;
		for (let r = 0; r < b.height; r++) if (b.data[r * b.width + col]) data[i * bpl + (r >> 3)] |= 0x80 >> (r & 7);
	}
	const parts: Uint8Array[] = [
		Uint8Array.of(0x1b, 0x4e, 0x0d, 0x05, 0x1b, 0x4e, 0x04, q30Density(opts.density), 0x1f, 0x11, opts.continuous ? 0x0b : 0x0a)
	];
	for (let start = 0; start < lines; start += MAX_BLOCK_LINES) {
		const n = Math.min(MAX_BLOCK_LINES, lines - start);
		parts.push(Uint8Array.of(0x1d, 0x76, 0x30, 0x00, bpl & 0xff, bpl >> 8, n & 0xff, n >> 8));
		parts.push(data.slice(start * bpl, (start + n) * bpl));
	}
	parts.push(Uint8Array.of(0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00));
	return parts;
}

export class PhomemoQ30 {
	private constructor(
		readonly device: BluetoothDevice,
		private write: BluetoothRemoteGATTCharacteristic
	) {}

	static async open(device: BluetoothDevice): Promise<PhomemoQ30> {
		if (!device.gatt) throw new Error('This device has no GATT server');
		const server = await device.gatt.connect();
		const service = await server.getPrimaryService(Q30_SERVICE);
		return new PhomemoQ30(device, await service.getCharacteristic(WRITE_CHAR));
	}

	get summary() {
		const p = this.write.properties;
		return `Phomemo service ff00, write ff02 (${[p.write && 'write', p.writeWithoutResponse && 'write without response'].filter(Boolean).join(' + ')})`;
	}

	private async send(data: Uint8Array, signal?: AbortSignal) {
		const noResponse = this.write.properties.writeWithoutResponse;
		for (let o = 0; o < data.length; o += CHUNK) {
			if (signal?.aborted) throw new Error('Cancelled');
			const piece = data.slice(o, o + CHUNK);
			if (noResponse) {
				await this.write.writeValueWithoutResponse(piece);
				await sleep(5);
			} else await this.write.writeValueWithResponse(piece);
		}
	}

	async print(b: Bitmap, opts: Q30JobOptions & { copies: number; signal?: AbortSignal }) {
		const parts = encodeQ30(b, opts);
		for (let c = 0; c < opts.copies; c++) {
			// The printer reports no progress; give it time to finish the previous label.
			if (c) await sleep(2000 + b.width * 2, opts.signal);
			for (const part of parts) {
				await this.send(part, opts.signal);
				await sleep(50, opts.signal);
			}
		}
		await sleep(500, opts.signal);
	}

	close() {
		if (this.device.gatt?.connected) this.device.gatt.disconnect();
	}
}
