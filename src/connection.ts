import { WebBluetoothTransport } from './printer/ble';
import { SPP_UUID, WebSerialTransport, type ByteTransport } from './printer/serial';
import { T15BtDriver, type T15Link } from './printer/t15';
import { sleep } from './printer/frame';
import { PrinterError, type Bitmap, type LabelSpec, type PrinterStatus } from './printer/types';
import { tapeFromMedia, type Tape } from './tape';
import { PhomemoQ30, Q30_SERVICE, type Q30Protocol } from './q30';
import type { Model } from './render';

export type LinkKind = 'ble' | 'serial';
export type State = 'off' | 'connecting' | 'ready' | 'printing';

export interface PrinterInfo {
	state: State;
	name?: string;
	/** Which printer is connected (set once connected). */
	model?: Model;
	/** Detected tape, null when none/unknown. */
	tape: Tape | null;
	/** Blocking problem reported by the printer (English, from the driver). */
	problem?: string;
	batteryLevel?: number;
	charging?: boolean;
}

const RD_DEV_NAME = 0x16;
const POLL_MS = 5000;

/** GATT services of the Supvan printers (see printer/ble.ts). */
const SUPVAN_SERVICES = [
	'0000e0ff-3c17-d293-8e48-14fe2e4da212',
	'0000a002-0000-1000-8000-00805f9b34fb',
	'000018f0-0000-1000-8000-00805f9b34fb',
	'0000fee7-0000-1000-8000-00805f9b34fb'
];
const isSupvan = (d: BluetoothDevice) => !!d.name?.startsWith('T0');
const isPhomemo = (d: BluetoothDevice) => !!d.name?.startsWith('Q');

export const bleSupported = () => typeof navigator !== 'undefined' && 'bluetooth' in navigator;
export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new PrinterError(`${what} timed out`, 'timeout')), ms))]);
}

export class Printer {
	info: PrinterInfo = { state: 'off', tape: null };
	log: string[] = [];
	private transport: ByteTransport | null = null;
	private driver: T15BtDriver | null = null;
	private q30: PhomemoQ30 | null = null;
	private bleDevice: BluetoothDevice | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private polling = false;

	constructor(private onChange: (info: PrinterInfo) => void) {}

	private set(patch: Partial<PrinterInfo>) {
		this.info = { ...this.info, ...patch };
		this.onChange(this.info);
	}

	logLine(line: string) {
		const t = new Date().toISOString().slice(11, 23);
		this.log.push(`${t} ${line}`);
		if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
	}

	get connected() {
		return this.info.state === 'ready' || this.info.state === 'printing';
	}

	/**
	 * Reconnect to a printer granted earlier, without any chooser. Returns false when there is none
	 * or it doesn't answer (e.g. switched off).
	 */
	async reconnect(kind: LinkKind): Promise<boolean> {
		if (this.connected || this.info.state === 'connecting') return this.connected;
		try {
			if (kind === 'serial' && serialSupported()) {
				const ports = await navigator.serial.getPorts();
				const port = ports.find((p) => (p.getInfo() as { bluetoothServiceClassId?: string }).bluetoothServiceClassId === SPP_UUID) ?? ports[0];
				if (!port) return false;
				await this.openSerial(port);
				return true;
			}
			if (kind === 'ble' && bleSupported()) {
				const device = this.bleDevice ?? (await this.grantedBle());
				if (!device) return false;
				await this.openBle(device);
				return true;
			}
		} catch (e) {
			this.logLine(`reconnect failed: ${String(e)}`);
			await this.disconnect();
		}
		return false;
	}

	/** Remembered BLE devices (needs Chrome's getDevices support; absent on some builds). */
	private async grantedBle(): Promise<BluetoothDevice | undefined> {
		const bt = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
		if (typeof bt.getDevices !== 'function') return undefined;
		const devices = await bt.getDevices();
		return devices.find((d) => isSupvan(d) || isPhomemo(d)) ?? devices[0];
	}

	/** Show the browser's chooser and connect. Must run inside a click handler. */
	async connectInteractive(kind: LinkKind): Promise<void> {
		if (kind === 'serial') {
			const port = await navigator.serial.requestPort({
				filters: [{ bluetoothServiceClassId: SPP_UUID }],
				allowedBluetoothServiceClassIds: [SPP_UUID]
			});
			await this.openSerial(port);
		} else {
			const device = await navigator.bluetooth.requestDevice({
				// Supvan E10: "T0…" serial; Phomemo Q30: "Q30…"/"Q…", or its ff00 service.
				filters: [{ namePrefix: 'T0' }, { namePrefix: 'Q' }, { services: [Q30_SERVICE] }],
				optionalServices: [...SUPVAN_SERVICES, Q30_SERVICE]
			});
			await this.openBle(device);
		}
	}

	private async openBle(device: BluetoothDevice) {
		this.set({ state: 'connecting', name: device.name ?? undefined, problem: undefined });
		this.bleDevice = device;
		device.removeEventListener('gattserverdisconnected', this.onDropped);
		device.addEventListener('gattserverdisconnected', this.onDropped);
		if (!isSupvan(device)) {
			const q30 = await withTimeout(PhomemoQ30.open(device, (l) => this.logLine(l)), 12000, 'Bluetooth connect');
			this.q30 = q30;
			this.logLine(`BLE ${device.name}: ${q30.summary}`);
			this.set({ state: 'ready', model: 'q30', tape: null, problem: undefined, batteryLevel: undefined });
			return;
		}
		const transport = await withTimeout(WebBluetoothTransport.open(device, { preferWithoutResponse: true }), 12000, 'Bluetooth connect');
		this.logLine(`BLE ${device.name}: ${transport.summary}`);
		await this.attach(transport, device.name ?? '', 'ble');
	}

	private async openSerial(port: SerialPort) {
		this.set({ state: 'connecting', problem: undefined });
		const transport = await withTimeout(WebSerialTransport.open(port), 12000, 'Serial connect');
		port.addEventListener('disconnect', this.onDropped);
		await this.attach(transport, '', 'spp');
	}

	private async attach(transport: ByteTransport, name: string, link: T15Link) {
		this.transport = transport;
		try {
			let driver = new T15BtDriver(transport, name, link);
			this.wireLog(driver);
			await driver.handshake();
			if (!name) {
				// Classic Bluetooth: the model name ("E10pro") picks pacing/head-rate like SUPRINT.
				name = await this.readDeviceName(driver).catch(() => '');
				driver.channel.dispose();
				driver = new T15BtDriver(transport, name, link);
				this.wireLog(driver);
			}
			this.driver = driver;
			this.set({ state: 'ready', name: name || this.info.name, model: 'e10' });
			await this.refresh();
			this.schedulePoll();
		} catch (e) {
			await this.disconnect();
			throw e;
		}
	}

	private wireLog(d: T15BtDriver) {
		d.channel.debug = true;
		d.channel.log = (l) => this.logLine(l);
	}

	private async readDeviceName(d: T15BtDriver): Promise<string> {
		const f = await d.channel.command(RD_DEV_NAME, 0, 0, 2000, false);
		const len = Math.max(0, (f[2] | (f[3] << 8)) - 18);
		return String.fromCharCode(...Array.from(f.subarray(22, 22 + len)).filter((c) => c >= 0x20 && c < 0x7f));
	}

	private onDropped = () => {
		this.logLine('link dropped');
		void this.disconnect();
	};

	async disconnect() {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
		this.driver?.channel.dispose();
		this.driver = null;
		this.q30?.close();
		this.q30 = null;
		const t = this.transport;
		this.transport = null;
		await t?.close().catch(() => {});
		this.set({ state: 'off', problem: undefined });
	}

	private applyStatus(s: PrinterStatus) {
		this.set({ problem: s.errors[0], batteryLevel: s.batteryLevel, charging: s.charging });
	}

	/** Read status and the loaded tape. */
	async refresh() {
		const d = this.driver;
		if (!d || this.info.state !== 'ready') return;
		const s = await d.getStatus();
		this.applyStatus(s);
		if (s.busy || s.printing) return;
		if (s.errors.length) {
			// No tape / cover open: whatever was detected before is no longer valid.
			if (/tape|label/i.test(s.errors[0])) this.set({ tape: null });
			return;
		}
		const m = await d.readMedia();
		if (m) {
			const tape = tapeFromMedia(m);
			this.logLine(`media id=${m.labelId} w=${m.widthMm} l=${m.lengthMm} type=${m.paperType} gap=${m.gap}`);
			this.set({ tape });
		}
	}

	private schedulePoll() {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(async () => {
			if (!this.polling && this.info.state === 'ready' && document.visibilityState === 'visible') {
				this.polling = true;
				try {
					await this.refresh();
				} catch (e) {
					this.logLine(`poll: ${String(e)}`);
				} finally {
					this.polling = false;
				}
			}
			if (this.driver) this.schedulePoll();
		}, POLL_MS);
	}

	async print(bitmap: Bitmap, tape: Tape, opts: { copies: number; density: number; q30Protocol?: Q30Protocol; signal?: AbortSignal }) {
		if (this.q30) {
			this.set({ state: 'printing' });
			try {
				this.logLine(`Q30 job: ${bitmap.width} lines x ${bitmap.height} dots, ${opts.q30Protocol ?? 'm110'}`);
				await this.q30.print(bitmap, { ...opts, continuous: tape.continuous, protocol: opts.q30Protocol });
			} finally {
				if (this.q30) this.set({ state: 'ready' });
			}
			return;
		}
		const d = this.driver;
		if (!d) throw new PrinterError('Not connected', 'offline');
		while (this.polling) await sleep(50);
		this.set({ state: 'printing' });
		try {
			const label: LabelSpec = {
				id: String(tape.id),
				name: tape.label,
				lengthMm: bitmap.width / 8,
				widthMm: tape.widthMm,
				paperDirection: 0,
				paperType: tape.continuous ? 0 : 1,
				gap: tape.gapMm,
				padding: { top: 0, bottom: 0, left: 0, right: 0 }
			};
			await d.print([bitmap], label, { copies: opts.copies, density: opts.density, signal: opts.signal });
		} finally {
			if (this.driver) this.set({ state: 'ready' });
		}
		await this.refresh().catch(() => {});
	}
}
