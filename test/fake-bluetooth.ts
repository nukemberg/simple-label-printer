// Test-only: a Web Bluetooth stand-in backed by the T15 emulator, for driving the real UI in a browser.
import { T15Emulator } from './t15-emulator';

export function install(material: Uint8Array | null) {
	const emu = new T15Emulator('T0126E2507010001');
	emu.material = material;
	const notifyHandlers = new Set<(e: { target: { value: DataView } }) => void>();
	emu.onData((chunk) => {
		const value = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		for (const h of notifyHandlers) h({ target: { value } });
	});
	const writeChar = {
		uuid: '0000ffe9-0000-1000-8000-00805f9b34fb',
		service: { uuid: '0000e0ff-3c17-d293-8e48-14fe2e4da212' },
		properties: { write: true, writeWithoutResponse: true },
		writeValueWithoutResponse: (d: Uint8Array) => emu.write(new Uint8Array(d)),
		writeValueWithResponse: (d: Uint8Array) => emu.write(new Uint8Array(d))
	};
	const notifyChar = {
		uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
		service: writeChar.service,
		properties: { notify: true },
		startNotifications: async () => notifyChar,
		stopNotifications: async () => notifyChar,
		addEventListener: (_: string, h: never) => notifyHandlers.add(h),
		removeEventListener: (_: string, h: never) => notifyHandlers.delete(h)
	};
	const service = {
		getCharacteristic: async (u: string) => (u.includes('ffe9') ? writeChar : notifyChar)
	};
	const gatt = {
		connected: false,
		connect: async () => {
			gatt.connected = true;
			return {
				getPrimaryService: async (u: string) => {
					if (!u.startsWith('0000e0ff')) throw new DOMException('no service', 'NotFoundError');
					return service;
				}
			};
		},
		disconnect: () => (gatt.connected = false)
	};
	const device = { name: emu.deviceName, gatt, addEventListener() {}, removeEventListener() {} };
	Object.defineProperty(navigator, 'bluetooth', {
		value: { requestDevice: async () => device, getAvailability: async () => true }
	});
	(window as unknown as { emu: T15Emulator }).emu = emu;
	return emu;
}
