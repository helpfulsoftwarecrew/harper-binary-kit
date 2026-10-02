// @ts-check
// Reads a release archive in memory and hands back its regular files, refusing the whole archive on any entry
// whose path could land outside the directory it is extracted into. Read here rather than shelling to `tar`,
// whose handling of `..`, absolute names and links differs between GNU, BSD and the one Windows ships.

import { crc32, gunzipSync, inflateRawSync } from 'node:zlib';

/**
 * @typedef {object} ArchiveEntry
 * @property {string} name The member path, `/`-separated and relative, as checked by `safeMemberPath`.
 * @property {'file' | 'dir' | 'link'} kind A link is listed so a request for it can be refused by name.
 * @property {number} mode Permission bits the archive recorded, or 0 when it recorded none.
 * @property {() => Uint8Array} read The member's bytes. Throws for anything but a file.
 */

/** The archive kinds this reads, from the asset's name. @param {string} name @returns {'tar.gz' | 'zip'} */
export function archiveKind(name) {
	if (/\.(tar\.gz|tgz)$/i.test(name)) return 'tar.gz';
	if (/\.zip$/i.test(name)) return 'zip';
	throw new Error(`${name} is neither a .tar.gz nor a .zip, and nothing else is read`);
}

/**
 * The member path normalised to `a/b/c`, or a throw. Absolute names, drive letters, backslashes and any `..`
 * segment are refused outright rather than cleaned, because a cleaned name is not the name the archive meant.
 *
 * @param {string} raw
 */
export function safeMemberPath(raw) {
	const name = raw.replace(/^(\.\/)+/, '');
	const refuse = (/** @type {string} */ why) => {
		throw new Error(`archive member ${JSON.stringify(raw)} ${why}; refusing the whole archive`);
	};
	if (name.includes('\0')) refuse('contains a NUL byte');
	if (name.includes('\\')) refuse('contains a backslash, which Windows reads as a separator');
	if (name.startsWith('/')) refuse('is an absolute path');
	if (/^[A-Za-z]:/.test(name)) refuse('names a drive');
	const segments = name.split('/').filter((s) => s !== '' && s !== '.');
	if (segments.includes('..')) refuse('climbs out of the extraction directory');
	return segments.join('/');
}

/** Every entry of an archive of `kind`. @param {Uint8Array} bytes @param {'tar.gz' | 'zip'} kind */
export const readArchive = (bytes, kind) => (kind === 'zip' ? readZip(bytes) : readTarGz(bytes));

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

/** A NUL-terminated header field. @param {Uint8Array} block @param {number} at @param {number} length */
const field = (block, at, length) => {
	const slice = block.subarray(at, at + length);
	const end = slice.indexOf(0);
	return utf8.decode(end === -1 ? slice : slice.subarray(0, end));
};

/** An octal number field, or a base-256 one when its high bit is set. @param {Uint8Array} block @param {number} at @param {number} length */
const numeric = (block, at, length) => {
	if ((block[at] ?? 0) & 0x80) {
		let value = 0;
		for (let i = at + 1; i < at + length; i++) value = value * 256 + (block[i] ?? 0);
		return value;
	}
	const text = latin1
		.decode(block.subarray(at, at + length))
		.replace(/[\0 ]+$/, '')
		.trim();
	const value = text === '' ? 0 : Number.parseInt(text, 8);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar header has an unreadable number "${text}"`);
	return value;
};

/** Pax extended-header records, `<len> <key>=<value>\n`. @param {Uint8Array} body @returns {Record<string, string>} */
function paxRecords(body) {
	/** @type {Record<string, string>} */
	const records = {};
	let at = 0;
	while (at < body.byteLength) {
		const space = body.indexOf(0x20, at);
		if (space === -1) break;
		const length = Number.parseInt(latin1.decode(body.subarray(at, space)), 10);
		if (!Number.isInteger(length) || length <= 0) throw new Error('tar pax header has an unreadable record');
		const record = utf8.decode(body.subarray(space + 1, at + length - 1));
		const eq = record.indexOf('=');
		if (eq !== -1) records[record.slice(0, eq)] = record.slice(eq + 1);
		at += length;
	}
	return records;
}

/** Entries of a gzipped tar: ustar, pax and GNU long names. @param {Uint8Array} bytes @returns {ArchiveEntry[]} */
export function readTarGz(bytes) {
	const tar = gunzipSync(bytes);
	/** @type {ArchiveEntry[]} */
	const entries = [];
	/** @type {string | undefined} */
	let longName;
	/** @type {Record<string, string>} */
	let pax = {};
	let at = 0;
	while (at + 512 <= tar.byteLength) {
		const header = tar.subarray(at, at + 512);
		if (header.every((b) => b === 0)) break;
		const stored = numeric(header, 148, 8);
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
		if (sum !== stored) throw new Error(`tar header at ${at} fails its checksum`);

		const type = String.fromCharCode(header[156] ?? 0);
		const size = pax.size === undefined ? numeric(header, 124, 12) : Number(pax.size);
		const dataAt = at + 512;
		if (dataAt + size > tar.byteLength) throw new Error(`tar member at ${at} runs past the end of the archive`);
		const body = tar.subarray(dataAt, dataAt + size);
		at = dataAt + Math.ceil(size / 512) * 512;

		if (type === 'L') {
			longName = field(body, 0, body.byteLength);
			continue;
		}
		if (type === 'x') {
			pax = paxRecords(body);
			continue;
		}
		// A global header and GNU's volume and multi-volume entries carry no member.
		if (type === 'g' || type === 'V' || type === 'M') continue;

		const prefix = latin1.decode(header.subarray(257, 262)) === 'ustar' ? field(header, 345, 155) : '';
		const short = field(header, 0, 100);
		const raw = pax.path ?? longName ?? (prefix ? `${prefix}/${short}` : short);
		longName = undefined;
		pax = {};

		const name = safeMemberPath(raw);
		const mode = numeric(header, 100, 8) & 0o7777;
		if (type === '0' || type === '\0' || type === '7') {
			entries.push({ name, kind: 'file', mode, read: () => body });
		} else if (type === '5') {
			entries.push({ name, kind: 'dir', mode, read: notAFile(name) });
		} else if (type === '1' || type === '2') {
			entries.push({ name, kind: 'link', mode, read: notAFile(name) });
		} else {
			throw new Error(`tar member ${name} has type "${type}", which is neither a file, a directory nor a link`);
		}
	}
	return entries;
}

/** @param {string} name */
const notAFile = (name) => () => {
	throw new Error(`archive member ${name} is not a regular file`);
};

/** Entries of a zip, through its central directory. Zip64 and encryption are refused. @param {Uint8Array} bytes @returns {ArchiveEntry[]} */
export function readZip(bytes) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (/** @type {number} */ at) => view.getUint16(at, true);
	const u32 = (/** @type {number} */ at) => view.getUint32(at, true);

	// The end record sits in the last 22 bytes plus a comment of at most 65535.
	let end = -1;
	for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at--) {
		if (u32(at) === 0x06054b50) {
			end = at;
			break;
		}
	}
	if (end === -1) throw new Error('not a zip archive: no end-of-central-directory record');
	const count = u16(end + 10);
	const dirAt = u32(end + 16);
	if (count === 0xffff || dirAt === 0xffffffff) throw new Error('zip64 archives are not read');

	/** @type {ArchiveEntry[]} */
	const entries = [];
	let at = dirAt;
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.byteLength || u32(at) !== 0x02014b50)
			throw new Error(`zip central directory entry ${i} is not where the end record says`);
		const madeBy = u16(at + 4) >> 8;
		const flags = u16(at + 8);
		const method = u16(at + 10);
		const crc = u32(at + 16);
		const compressed = u32(at + 20);
		const size = u32(at + 24);
		const nameLength = u16(at + 28);
		const extraLength = u16(at + 30);
		const commentLength = u16(at + 32);
		const external = u32(at + 38);
		const localAt = u32(at + 42);
		const raw = (flags & 0x800 ? utf8 : latin1).decode(bytes.subarray(at + 46, at + 46 + nameLength));
		at += 46 + nameLength + extraLength + commentLength;

		const name = safeMemberPath(raw);
		if (compressed === 0xffffffff || size === 0xffffffff || localAt === 0xffffffff)
			throw new Error(`zip member ${name} needs zip64, which is not read`);
		if (flags & 0x1) throw new Error(`zip member ${name} is encrypted`);
		// Unix hosts (3) keep st_mode in the high half of the external attributes; others keep none.
		const unixMode = madeBy === 3 ? external >>> 16 : 0;
		const fileType = unixMode & 0o170000;
		const mode = unixMode & 0o7777;
		if (raw.endsWith('/') || fileType === 0o040000) {
			entries.push({ name, kind: 'dir', mode, read: notAFile(name) });
			continue;
		}
		if (fileType === 0o120000) {
			entries.push({ name, kind: 'link', mode, read: notAFile(name) });
			continue;
		}
		if (method !== 0 && method !== 8) throw new Error(`zip member ${name} uses compression method ${method}`);
		entries.push({
			name,
			kind: 'file',
			mode,
			read: () => {
				if (u32(localAt) !== 0x04034b50) throw new Error(`zip member ${name} has no local header`);
				const dataAt = localAt + 30 + u16(localAt + 26) + u16(localAt + 28);
				const stored = bytes.subarray(dataAt, dataAt + compressed);
				const data = method === 0 ? stored : new Uint8Array(inflateRawSync(stored));
				if (data.byteLength !== size || crc32(data) !== crc)
					throw new Error(`zip member ${name} does not match its recorded size and CRC`);
				return data;
			},
		});
	}
	return entries;
}
