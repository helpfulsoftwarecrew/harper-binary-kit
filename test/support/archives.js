// Archive writers for fixtures, and a loopback server to fetch them from. Written byte by byte rather than through
// `tar` or `zip`, so a hostile entry is exactly the one under test and no tool normalised it first.

import { createServer } from 'node:http';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

/**
 * @typedef {object} FixtureEntry
 * @property {string} name Written as given, `..` and all.
 * @property {string | Uint8Array} [data]
 * @property {number} [mode]
 * @property {'file' | 'dir' | 'symlink'} [kind]
 * @property {string} [linkTo]
 */

const bytesOf = (/** @type {string | Uint8Array | undefined} */ data) =>
	typeof data === 'string' ? new TextEncoder().encode(data) : (data ?? new Uint8Array());

/** One 512-byte ustar header. @param {string} name @param {number} size @param {number} mode @param {string} type @param {string} [linkTo] */
function tarHeader(name, size, mode, type, linkTo = '') {
	const header = Buffer.alloc(512);
	header.write(name.slice(0, 100), 0, 'utf-8');
	header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
	header.write('0000000\0', 108);
	header.write('0000000\0', 116);
	header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
	header.write('00000000000\0', 136);
	header.write(type, 156);
	header.write(linkTo.slice(0, 100), 157);
	header.write('ustar\0', 257);
	header.write('00', 263);
	header.fill(0x20, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
	return header;
}

const padded = (/** @type {Uint8Array} */ data) => {
	const out = Buffer.alloc(Math.ceil(data.byteLength / 512) * 512);
	out.set(data);
	return out;
};

/** A gzipped tar. A name over 100 bytes goes through a pax header, as GNU tar and Go's archive/tar write it. @param {FixtureEntry[]} entries */
export function tarGz(entries) {
	/** @type {Uint8Array[]} */
	const parts = [];
	for (const entry of entries) {
		if (Buffer.byteLength(entry.name) > 100) {
			const record = (/** @type {string} */ body) => {
				let length = body.length + 3;
				while (`${length} ${body}\n`.length !== length) length = `${length} ${body}\n`.length;
				return `${length} ${body}\n`;
			};
			const pax = bytesOf(record(`path=${entry.name}`));
			parts.push(tarHeader('PaxHeader', pax.byteLength, 0o644, 'x'), padded(pax));
		}
		const kind = entry.kind ?? 'file';
		const data = kind === 'file' ? bytesOf(entry.data) : new Uint8Array();
		const type = kind === 'dir' ? '5' : kind === 'symlink' ? '2' : '0';
		parts.push(tarHeader(entry.name, data.byteLength, entry.mode ?? 0o644, type, entry.linkTo), padded(data));
	}
	parts.push(Buffer.alloc(1024));
	return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

/** A zip from a Unix host, deflated unless a member is empty. @param {FixtureEntry[]} entries @param {{ corruptCrc?: boolean }} [options] */
export function zip(entries, { corruptCrc = false } = {}) {
	/** @type {Buffer[]} */
	const locals = [];
	/** @type {Buffer[]} */
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const kind = entry.kind ?? 'file';
		const data = kind === 'symlink' ? bytesOf(entry.linkTo) : kind === 'file' ? bytesOf(entry.data) : new Uint8Array();
		const method = data.byteLength > 0 ? 8 : 0;
		const stored = method === 8 ? deflateRawSync(data) : Buffer.from(data);
		const crc = (crc32(data) ^ (corruptCrc ? 1 : 0)) >>> 0;
		const name = Buffer.from(entry.name, 'utf-8');
		const fileType = kind === 'dir' ? 0o040000 : kind === 'symlink' ? 0o120000 : 0o100000;
		const external = ((fileType | (entry.mode ?? 0o644)) << 16) >>> 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.byteLength, 18);
		local.writeUInt32LE(data.byteLength, 22);
		local.writeUInt16LE(name.byteLength, 26);
		locals.push(local, name, stored);

		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE((3 << 8) | 20, 4);
		record.writeUInt16LE(20, 6);
		record.writeUInt16LE(0x800, 8);
		record.writeUInt16LE(method, 10);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(stored.byteLength, 20);
		record.writeUInt32LE(data.byteLength, 24);
		record.writeUInt16LE(name.byteLength, 28);
		record.writeUInt32LE(external, 38);
		record.writeUInt32LE(offset, 42);
		central.push(record, name);
		offset += local.byteLength + name.byteLength + stored.byteLength;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.byteLength, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/**
 * A loopback server answering `/<path>` from `files` and 404 for anything else, for `run`'s duration. Every
 * path asked for is recorded, so a test can say what was never fetched.
 *
 * @param {Record<string, Uint8Array | string>} files
 * @param {(baseUrl: string, asked: string[]) => Promise<any>} run
 */
export async function withReleaseServer(files, run) {
	/** @type {string[]} */
	const asked = [];
	const server = createServer((request, response) => {
		const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
		asked.push(path);
		const body = files[path];
		if (body === undefined) {
			response.writeHead(404).end('Not Found');
			return;
		}
		response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(bytesOf(body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('the fixture server has no port');
	try {
		return await run(`http://127.0.0.1:${address.port}`, asked);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(() => resolve(undefined)));
	}
}
