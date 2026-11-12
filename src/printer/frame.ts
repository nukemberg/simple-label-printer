/**
 * Supvan Bluetooth framing: 16-byte "7E 5A" command frames and a request/response channel over a
 * byte stream (BLE notifications or an RFCOMM serial port).
 *
 * Vendored from khromov/supvan-katasymbol-printer-web-ui (MIT, see LICENSE-khromov),
 * src/lib/printer/families/t5080-bt.ts and channel.ts, trimmed to what the E10 (T15) driver uses.
 */
import type { ByteTransport } from './serial';
import { PrinterError } from './types';

/** Command opcodes shared by the Supvan Bluetooth printers. */
export const CMD = {
	BUF_FULL: 0x10,
	INQUIRY_STA: 0x11,
	CHECK_DEVICE: 0x12,
	START_PRINT: 0x13,
	STOP_PRINT: 0x14,
	RETURN_MAT: 0x30,
	NEXTFRM_BULK: 0x5c
} as const;

export const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new PrinterError('Cancelled', 'cancelled'));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(t);
				reject(new PrinterError('Cancelled', 'cancelled'));
			},
			{ once: true }
		);
	});

const sum16 = (b: Uint8Array, from: number, to: number) => {
	let s = 0;
	for (let i = from; i < to; i++) s += b[i];
	return s & 0xffff;
};

/** 16-byte command frame: 7E 5A 0C 00 10 01 AA <cmd> <sum LE> 00 01 <a LE16> <b LE16>. */
export function btCommandFrame(cmd: number, a = 0, b = 0): Uint8Array {
	const f = new Uint8Array(16);
	f.set([0x7e, 0x5a, 0x0c, 0x00, 0x10, 0x01, 0xaa, cmd & 0xff, 0, 0, 0x00, 0x01, a & 0xff, (a >> 8) & 0xff, b & 0xff, (b >> 8) & 0xff]);
	const s = sum16(f, 10, 16);
	f[8] = s & 0xff;
	f[9] = s >> 8;
	return f;
}

export interface FrameChannelOptions {
	/** Default true (classic Bluetooth); false for BLE. */
	acksDataFrames?: boolean;
	/** Reply timeout for commands (default 2000 ms like the app over SPP; the app uses 4 s on BLE). */
	commandTimeoutMs?: number;
	/**
	 * Fail the transfer when a data frame gets no reply within `ackTimeoutMs`, taking any received
	 * bytes as the reply (the E10/T10 apps do both; the T50/T80 driver carries on).
	 */
	strictAcks?: boolean;
	/** How long to wait for each data frame's reply (default 2000 ms). */
	ackTimeoutMs?: number;
}

/**
 * Request/response channel over the Bluetooth byte stream. Replies are reassembled from the
 * length field (u16 LE at [2..3], plus 4) and matched to their request by the echoed command
 * byte at [7]. Like the app, input left over from earlier exchanges is discarded before each
 * write.
 */
export class FrameChannel {
	private pending = new Uint8Array(0);
	private frames: Uint8Array[] = [];
	private wake: (() => void) | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private unsubscribe: () => void;
	debug = false;
	/** Where debug lines go (defaults to console.debug). */
	log: (line: string) => void = (line) => console.debug(line);
	/**
	 * Whether the printer answers every 512-byte data frame. It does over classic Bluetooth, where
	 * the app reads one reply per frame; over BLE it doesn't (BasePrint.transferSplitData never
	 * waits there), so waiting would stall each frame for the full timeout.
	 */
	readonly acksDataFrames: boolean;
	readonly commandTimeoutMs: number;
	readonly strictAcks: boolean;
	readonly ackTimeoutMs: number;
	/** Bytes received so far (never reset), to tell whether anything arrived. */
	private received = 0;

	constructor(
		readonly transport: ByteTransport,
		opts: FrameChannelOptions = {}
	) {
		this.acksDataFrames = opts.acksDataFrames ?? true;
		this.commandTimeoutMs = opts.commandTimeoutMs ?? 2000;
		this.strictAcks = opts.strictAcks ?? false;
		this.ackTimeoutMs = opts.ackTimeoutMs ?? 2000;
		this.unsubscribe = transport.onData((chunk) => this.receive(chunk));
	}

	dispose() {
		this.unsubscribe();
	}

	private receive(chunk: Uint8Array) {
		this.received += chunk.length;
		const buf = new Uint8Array(this.pending.length + chunk.length);
		buf.set(this.pending);
		buf.set(chunk, this.pending.length);
		let i = 0;
		for (;;) {
			while (i + 1 < buf.length && !(buf[i] === 0x7e && buf[i + 1] === 0x5a)) i++;
			if (i + 4 > buf.length) break;
			const total = (buf[i + 2] | (buf[i + 3] << 8)) + 4;
			if (total < 8 || total > 2048) {
				i++; // not a plausible frame header; resync
				continue;
			}
			if (i + total > buf.length) break;
			const frame = buf.slice(i, i + total);
			if (this.debug) this.log(`<- ${hexs(frame.subarray(0, 32))}${frame.length > 32 ? ` … (${frame.length} bytes)` : ''}`);
			this.frames.push(frame);
			i += total;
		}
		this.pending = buf.slice(i);
		this.wake?.();
	}

	/** Drop received but unclaimed input (the app's clear()). */
	private clear() {
		this.frames = [];
		this.pending = new Uint8Array(0);
	}

	private async write(data: Uint8Array) {
		if (this.debug) this.log(`-> ${hexs(data.subarray(0, 16))}${data.length > 16 ? ` … (${data.length} bytes)` : ''}`);
		await this.transport.write(data);
	}

	/** Wait for the first frame accepted by `match` (others are dropped); null on timeout. */
	private async next(match: (f: Uint8Array) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array | null> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			while (this.frames.length) {
				const f = this.frames.shift()!;
				if (match(f)) return f;
			}
			const left = deadline - Date.now();
			if (left <= 0) return null;
			await this.idle(left, signal);
		}
	}

	/** Wait up to `ms` for more input; throws if `signal` aborts meanwhile. */
	private async idle(ms: number, signal?: AbortSignal) {
		const cancelled = () => new PrinterError('Cancelled', 'cancelled');
		if (signal?.aborted) throw cancelled();
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(t);
				signal?.removeEventListener('abort', done);
				resolve();
			};
			const t = setTimeout(done, ms);
			this.wake = done;
			signal?.addEventListener('abort', done, { once: true });
		});
		this.wake = null;
		if (signal?.aborted) throw cancelled();
	}

	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const p = this.queue.then(run, run);
		this.queue = p.catch(() => {});
		return p;
	}

	/** Send a command and wait for the reply echoing it. Retries once, like BasePrint.sendCmd. */
	command(cmd: number, a = 0, b = 0, timeoutMs = this.commandTimeoutMs, retry = true): Promise<Uint8Array> {
		return this.serialize(async () => {
			for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
				this.clear();
				await this.write(btCommandFrame(cmd, a, b));
				await sleep(10);
				const reply = await this.next((f) => f[7] === cmd, timeoutMs);
				if (reply) return reply;
			}
			throw new PrinterError('Printer did not respond over Bluetooth', 'timeout');
		});
	}

	/**
	 * Send already announced data frames, each as `pieceSize` writes 10 ms apart (plus `pauseMs`
	 * before every piece after the first, like BasePrint.transferSplitData), reading one reply per
	 * frame where the link acknowledges them.
	 */
	sendFrames(frames: Uint8Array[], opts: { pieceSize: number; pauseMs?: number }, signal?: AbortSignal): Promise<void> {
		return this.serialize(() => this.writeFrames(frames, opts.pieceSize, opts.pauseMs ?? 0, signal));
	}

	private async writeFrames(frames: Uint8Array[], pieceSize: number, pauseMs: number, signal?: AbortSignal) {
		for (const f of frames) {
			if (signal?.aborted) throw new PrinterError('Cancelled', 'cancelled');
			this.clear();
			const before = this.received;
			for (let o = 0; o < f.length; o += pieceSize) {
				if (o && pauseMs) await sleep(pauseMs);
				await this.write(f.subarray(o, o + pieceSize));
				await sleep(10);
			}
			if (this.strictAcks) {
				if (!(await this.input(before, this.ackTimeoutMs, signal))) throw new PrinterError('Printer did not acknowledge the print data', 'timeout');
			} else if (this.acksDataFrames) await this.next(() => true, this.ackTimeoutMs, signal);
		}
	}

	/** Wait until more than `since` bytes have been received in total; false on timeout. */
	private async input(since: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.received <= since) {
			const left = deadline - Date.now();
			if (left <= 0) return false;
			await this.idle(left, signal);
		}
		return true;
	}
}

const hexs = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join(' ');

