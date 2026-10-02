// The archive reader against archives written byte by byte, hostile entries included.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';

import { archiveKind, readArchive, readTarGz, readZip, safeMemberPath } from '../../src/archive.js';
import { tarGz, zip } from '../support/archives.js';

const text = (/** @type {Uint8Array} */ bytes) => new TextDecoder().decode(bytes);

test('a tar.gz reads back its files, directories, modes and a pax long name', () => {
	const long = `deep/${'d'.repeat(120)}/file.txt`;
	const entries = readTarGz(
		tarGz([
			{ name: './otelcol', data: 'binary', mode: 0o755 },
			{ name: 'docs/', kind: 'dir', mode: 0o755 },
			{ name: 'docs/LICENSE', data: 'Apache-2.0' },
			{ name: long, data: 'long' },
		])
	);
	assert.deepEqual(
		entries.map((e) => [e.name, e.kind, e.mode]),
		[
			['otelcol', 'file', 0o755],
			['docs', 'dir', 0o755],
			['docs/LICENSE', 'file', 0o644],
			[long, 'file', 0o644],
		]
	);
	assert.equal(text(entries[0]?.read() ?? new Uint8Array()), 'binary');
	assert.equal(text(entries[3]?.read() ?? new Uint8Array()), 'long');
});

test('a zip reads back stored and deflated members with their Unix modes', () => {
	const entries = readZip(
		zip([
			{ name: 'alloy-linux-amd64', data: 'x'.repeat(5000), mode: 0o755 },
			{ name: 'empty', data: '' },
			{ name: 'dir/', kind: 'dir' },
		])
	);
	assert.deepEqual(
		entries.map((e) => [e.name, e.kind, e.mode]),
		[
			['alloy-linux-amd64', 'file', 0o755],
			['empty', 'file', 0o644],
			['dir', 'dir', 0o644],
		]
	);
	assert.equal(text(entries[0]?.read() ?? new Uint8Array()), 'x'.repeat(5000));
	assert.equal(entries[1]?.read().byteLength, 0);
});

test('archiveKind goes by the asset name and refuses anything else', () => {
	assert.equal(archiveKind('otelcol_0.162.0_linux_amd64.tar.gz'), 'tar.gz');
	assert.equal(archiveKind('alloy-windows-amd64.exe.zip'), 'zip');
	assert.throws(() => archiveKind('otelcol_0.162.0_linux_amd64.deb'), /neither a \.tar\.gz nor a \.zip/);
});

test('safeMemberPath drops a leading ./ and empty segments', () => {
	assert.equal(safeMemberPath('./a//b/./c'), 'a/b/c');
});

for (const [kind, write] of /** @type {const} */ ([
	['tar.gz', tarGz],
	['zip', zip],
])) {
	for (const hostile of ['../evil', 'ok/../../evil', '/etc/passwd', 'C:/Windows/evil.exe', 'a\\..\\..\\evil']) {
		test(`NEGATIVE: a ${kind} with member ${JSON.stringify(hostile)} is refused whole`, () => {
			const bytes = write([
				{ name: 'otelcol', data: 'fine', mode: 0o755 },
				{ name: hostile, data: 'payload' },
			]);
			assert.throws(() => readArchive(bytes, kind), /refusing the whole archive/);
		});
	}

	test(`a ${kind} symlink is listed as a link and refuses to be read`, () => {
		const [link] = readArchive(write([{ name: 'bin/agent', kind: 'symlink', linkTo: '/etc/passwd' }]), kind);
		assert.equal(link?.kind, 'link');
		assert.throws(() => link?.read(), /not a regular file/);
	});
}

test('NEGATIVE: a zip member whose CRC does not match is refused on read', () => {
	const [member] = readZip(zip([{ name: 'alloy', data: 'bytes' }], { corruptCrc: true }));
	assert.throws(() => member?.read(), /does not match its recorded size and CRC/);
});

test('NEGATIVE: a tar header that fails its checksum is refused', () => {
	const good = tarGz([{ name: 'otelcol', data: 'binary' }]);
	const raw = gunzipSync(good);
	raw[0] = 'X'.charCodeAt(0);
	assert.throws(() => readTarGz(new Uint8Array(gzipSync(raw))), /fails its checksum/);
});

test('NEGATIVE: bytes that are not a zip are refused', () => {
	assert.throws(
		() => readZip(new TextEncoder().encode('not a zip at all, just some text padding it out')),
		/not a zip/
	);
});
