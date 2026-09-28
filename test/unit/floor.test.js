// The symbol versions a binary needs against what its image provides. The failure is at exec time on a
// customer's node and reads as the binary being missing, while every test on the build runner passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkFloor, checkFloors, compareVersions, referencedVersions } from '../../src/floor.js';

/** A buffer holding the version strings a linker leaves in a binary, amid unrelated bytes. */
const binaryWith = (/** @type {string[]} */ ...versions) =>
	Buffer.from(`\0\0ELF-ish\0${versions.join('\0')}\0libc.so.6\0`, 'latin1');

test('the versions a file names come back in order, highest last', () => {
	const contents = binaryWith('GLIBC_2.17', 'GLIBC_2.34', 'GLIBC_2.4');
	assert.deepEqual(referencedVersions(contents, 'GLIBC'), ['2.4', '2.17', '2.34']);
});

// A string sort puts 2.9 above 2.34, which is how a binary that needs more than the image provides passes.
test('NEGATIVE: versions compare numerically, not as strings', () => {
	assert.ok(compareVersions('2.34', '2.9') > 0);
	assert.ok(compareVersions('3.4.30', '3.4.9') > 0);
	assert.equal(compareVersions('2.36', '2.36'), 0);
	assert.ok(compareVersions('2.36', '2.36.1') < 0);
	assert.deepEqual(referencedVersions(binaryWith('GLIBC_2.9', 'GLIBC_2.34'), 'GLIBC').at(-1), '2.34');
});

// The two families have different floors, so a version from one must never count against the other.
test('NEGATIVE: GLIBC does not match GLIBCXX', () => {
	const contents = binaryWith('GLIBC_2.34', 'GLIBCXX_3.4.30');
	assert.deepEqual(referencedVersions(contents, 'GLIBC'), ['2.34']);
	assert.deepEqual(referencedVersions(contents, 'GLIBCXX'), ['3.4.30']);
});

test('a binary within the floor passes and says what it needs', () => {
	const { ok, lines } = checkFloor({
		file: '/build/agent',
		floor: { GLIBC: '2.36', GLIBCXX: '3.4.30' },
		read: () => binaryWith('GLIBC_2.34', 'GLIBCXX_3.4.29'),
	});
	assert.equal(ok, true);
	assert.match(String(lines[0]), /needs up to GLIBC_2\.34; the image provides GLIBC_2\.36/);
});

test('NEGATIVE: a binary above the floor fails, and the message says what to do', () => {
	const { ok, lines } = checkFloor({
		file: '/build/agent',
		floor: { GLIBC: '2.36' },
		read: () => binaryWith('GLIBC_2.38'),
	});
	assert.equal(ok, false);
	assert.match(String(lines[0]), /needs GLIBC_2\.38 and the target image provides GLIBC_2\.36/);
	assert.match(String(lines[0]), /older toolchain/);
	assert.match(String(lines[0]), /will not load at all/);
});

// A static binary, or a platform without the library: a silent pass hides that, and a failure breaks macOS.
test('a binary referencing nothing from a family is neither a pass nor a failure', () => {
	const { ok, lines } = checkFloor({
		file: '/build/agent',
		floor: { GLIBC: '2.36' },
		read: () => Buffer.from('a statically linked thing', 'latin1'),
	});
	assert.equal(ok, true);
	assert.match(String(lines[0]), /references no GLIBC_ version/);
});

test('NEGATIVE: a file that cannot be read fails rather than passing quietly', () => {
	const { ok, lines } = checkFloor({
		file: '/build/missing',
		floor: { GLIBC: '2.36' },
		read: () => {
			throw new Error('ENOENT: no such file');
		},
	});
	assert.equal(ok, false);
	assert.match(String(lines[0]), /could not be read: ENOENT/);
});

test('one binary over the floor fails the whole target', () => {
	/** @type {Record<string, Buffer>} */
	const contents = { '/build/a': binaryWith('GLIBC_2.17'), '/build/b': binaryWith('GLIBC_2.39') };
	const { ok, lines } = checkFloors({
		files: ['/build/a', '/build/b'],
		floor: { GLIBC: '2.36' },
		read: (path) => /** @type {Buffer} */ (contents[path]),
	});
	assert.equal(ok, false);
	assert.equal(lines.length, 2, 'every binary is reported, not just the first failure');
	assert.match(String(lines[1]), /\/build\/b: needs GLIBC_2\.39/);
});
