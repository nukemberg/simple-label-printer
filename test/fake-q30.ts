// Test-only: a Web Bluetooth stand-in for a Phomemo Q30 that records every write.
export function install() {
	const writes: Uint8Array[] = [];
	const write = {
		properties: { write: true, writeWithoutResponse: true },
		writeValueWithoutResponse: async (d: Uint8Array) => void writes.push(new Uint8Array(d)),
		writeValueWithResponse: async (d: Uint8Array) => void writes.push(new Uint8Array(d))
	};
	const gatt = {
		connected: false,
		connect: async () => {
			gatt.connected = true;
			return {
				getPrimaryService: async (u: string) => {
					if (!u.startsWith('0000ff00')) throw new DOMException('no service', 'NotFoundError');
					return { getCharacteristic: async () => write };
				}
			};
		},
		disconnect: () => (gatt.connected = false)
	};
	const device = { name: 'Q30S_1A2B', gatt, addEventListener() {}, removeEventListener() {} };
	Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device } });
	(window as unknown as { q30writes: Uint8Array[] }).q30writes = writes;
}
