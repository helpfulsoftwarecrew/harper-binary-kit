// The gate, which reads the tarball rather than the tree, since `files` and `.npmignore` apply at pack time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageDir } from '../../src/layout.js';
import { packagesFor } from '../../src/packages.js';
import { verifyAll, verifyPackage } from '../../src/verify.js';
import { target } from '../../src/targets.js';
import { one, withTempDir } from '../support/sandbox.js';

const CONFIG = {
	scope: '@x/agent',
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'agent', symbol: 'CONNECTIONS_CHECK' }, { shipsAs: 'trace-agent' }],
};
const LINUX = target('linux-x86_64');
const PKG = one(packagesFor(CONFIG, LINUX), 'package');

/** npm's `pack --dry-run --json`, as the real one answers. */
const packs =
	(/** @type {string[]} */ files, { name = PKG.name, version = '1.0.0' } = {}) =>
	() =>
		JSON.stringify([{ name, version, size: 1024, files: files.map((/** @type {string} */ path) => ({ path })) }]);

/** Stage just enough on disk for the symbol read, which is the one check that opens a file. */
function withBinaries(/** @type {string} */ root, /** @type {Record<string, string>} */ contents) {
	const dir = join(packageDir(root, PKG.dirName), 'bin');
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(contents)) writeFileSync(join(dir, name), body);
	return root;
}

const COMPLETE = ['bin/agent', 'bin/trace-agent', 'index.js', 'package.json', 'README.md'];

test('a complete tarball at the right version has nothing to say', () =>
	withTempDir('kit-verify-', async (root) => {
		withBinaries(root, { 'agent': 'built with CONNECTIONS_CHECK inside', 'trace-agent': 'x' });
		assert.deepEqual(verifyPackage({ root, pkg: PKG, version: '1.0.0', run: packs(COMPLETE) }), []);
	}));

test('NEGATIVE: a tarball missing a binary is refused, naming the file', () =>
	withTempDir('kit-missing-file-', async (root) => {
		withBinaries(root, { 'agent': 'CONNECTIONS_CHECK', 'trace-agent': 'x' });
		const reasons = verifyPackage({
			root,
			pkg: PKG,
			version: '1.0.0',
			run: packs(['bin/agent', 'index.js', 'package.json']),
		});
		assert.deepEqual(reasons, ['@x/agent-linux-x86_64: the tarball does not carry bin/trace-agent']);
	}));

// A platform package a version behind is not installed, it is refused: the base package pins its
// optionalDependencies at exactly one version.
test('NEGATIVE: a package staged at the wrong version is refused', () =>
	withTempDir('kit-version-', async (root) => {
		withBinaries(root, { 'agent': 'CONNECTIONS_CHECK', 'trace-agent': 'x' });
		const reasons = verifyPackage({
			root,
			pkg: PKG,
			version: '1.1.0',
			run: packs(COMPLETE, { version: '1.0.0' }),
		});
		assert.deepEqual(reasons, ['@x/agent-linux-x86_64: staged at 1.0.0, and this release is 1.1.0']);
	}));

// A file listing cannot see this: present, correctly named, right size, and built without what it exists for.
test('NEGATIVE: a binary built without its capability is refused, whatever the listing says', () =>
	withTempDir('kit-symbol-', async (root) => {
		withBinaries(root, { 'agent': 'a build with the check compiled out', 'trace-agent': 'x' });
		const reasons = verifyPackage({ root, pkg: PKG, version: '1.0.0', run: packs(COMPLETE) });
		assert.equal(reasons.length, 1);
		assert.match(String(reasons[0]), /agent does not contain "CONNECTIONS_CHECK"/);
		assert.match(String(reasons[0]), /built without the capability/);
	}));

test('every reason is reported, not just the first', () =>
	withTempDir('kit-all-reasons-', async (root) => {
		withBinaries(root, { 'agent': 'no marker here', 'trace-agent': 'x' });
		const reasons = verifyPackage({
			root,
			pkg: PKG,
			version: '2.0.0',
			run: packs(['bin/agent', 'index.js'], { version: '1.0.0' }),
		});
		// Wrong version, missing binary, missing manifest and missing symbol, all named in one run.
		assert.equal(reasons.length, 4, reasons.join('\n'));
	}));

test('NEGATIVE: a package npm cannot pack at all is a reason, not a crash', () =>
	withTempDir('kit-unpackable-', async (root) => {
		const reasons = verifyPackage({
			root,
			pkg: PKG,
			version: '1.0.0',
			run: () => {
				throw new Error('ENOENT: no such file or directory');
			},
		});
		assert.equal(reasons.length, 1);
		assert.match(String(reasons[0]), /npm could not pack/);
	}));

test('NEGATIVE: a staged manifest naming a different package is refused', () =>
	withTempDir('kit-wrongname-', async (root) => {
		withBinaries(root, { 'agent': 'CONNECTIONS_CHECK', 'trace-agent': 'x' });
		const reasons = verifyPackage({
			root,
			pkg: PKG,
			version: '1.0.0',
			run: packs(COMPLETE, { name: '@x/agent-linux-arm64' }),
		});
		assert.deepEqual(reasons, ['@x/agent-linux-x86_64: the staged manifest names @x/agent-linux-arm64']);
	}));

test('the whole release is checked, and one bad package does not hide another', () =>
	withTempDir('kit-release-', async (root) => {
		withBinaries(root, { 'agent': 'CONNECTIONS_CHECK', 'trace-agent': 'x' });
		const reasons = verifyAll({
			root,
			packages: [PKG, /** @type {any} */ ({ ...PKG, name: '@x/agent-macos-arm64', dirName: 'macos-arm64' })],
			version: '1.0.0',
			run: packs(['index.js', 'package.json']),
		});
		assert.ok(reasons.some((r) => r.startsWith('@x/agent-linux-x86_64')));
		assert.ok(reasons.some((r) => r.startsWith('@x/agent-macos-arm64')));
	}));

// A symbol says what a binary was built WITH; nothing else says what it was built WITHOUT. A Go build tag an
// exclusion should have dropped packages, is correctly named, and is an interpreter nobody asked for.
const CHECKED = {
	scope: '@x/agent',
	variants: [{ suffix: '' }],
	binaries: [{ shipsAs: 'agent', symbol: 'CONNECTIONS_CHECK', check: refuseOnTag }],
};

/** A consumer's check: refuses the bytes when the record says a forbidden tag was linked in. */
function refuseOnTag(/** @type {Buffer} */ contents) {
	const record = /build\t-tags=([^\n]*)/.exec(contents.toString('latin1'));
	if (!record) return 'carries no build-tag record, so the exclusion cannot be read off the packed binary';
	if ((record[1] ?? '').split(',').includes('python')) return 'was compiled with the "python" build tag';
	return undefined;
}

const checkedPkg = () => one(packagesFor(CHECKED, LINUX), 'package');
const CHECKED_FILES = ['bin/agent', 'index.js', 'package.json', 'README.md'];

test('a consumer check that answers nothing leaves the package publishable', () =>
	withTempDir('kit-check-ok-', async (root) => {
		const pkg = checkedPkg();
		mkdirSync(join(packageDir(root, pkg.dirName), 'bin'), { recursive: true });
		writeFileSync(join(packageDir(root, pkg.dirName), 'bin', 'agent'), 'CONNECTIONS_CHECK\nbuild\t-tags=zlib,zstd\n');
		assert.deepEqual(verifyPackage({ root, pkg, version: '1.0.0', run: packs(CHECKED_FILES, { name: pkg.name }) }), []);
	}));

test('NEGATIVE: a consumer check refuses with the reason it gave', () =>
	withTempDir('kit-check-bad-', async (root) => {
		const pkg = checkedPkg();
		mkdirSync(join(packageDir(root, pkg.dirName), 'bin'), { recursive: true });
		writeFileSync(
			join(packageDir(root, pkg.dirName), 'bin', 'agent'),
			'CONNECTIONS_CHECK\nbuild\t-tags=zlib,python,zstd\n'
		);
		const reasons = verifyPackage({ root, pkg, version: '1.0.0', run: packs(CHECKED_FILES, { name: pkg.name }) });
		assert.deepEqual(reasons, ['@x/agent-linux-x86_64: agent was compiled with the "python" build tag']);
	}));

// The exclusion is read off the artifact rather than trusted from the flag, so an unreadable record is the
// one case where refusing and passing are both defensible. Passing publishes every unreadable artifact.
test('NEGATIVE: a binary with no record to read is refused, not passed', () =>
	withTempDir('kit-check-blank-', async (root) => {
		const pkg = checkedPkg();
		mkdirSync(join(packageDir(root, pkg.dirName), 'bin'), { recursive: true });
		writeFileSync(join(packageDir(root, pkg.dirName), 'bin', 'agent'), 'CONNECTIONS_CHECK and nothing else');
		const reasons = verifyPackage({ root, pkg, version: '1.0.0', run: packs(CHECKED_FILES, { name: pkg.name }) });
		assert.match(one(reasons, 'reason'), /carries no build-tag record/);
	}));

// A check that cannot run has not established the binary is fine. Passing on the exception is how a gate
// comes to approve every artifact it failed to parse.
test('NEGATIVE: a check that throws refuses rather than passing', () =>
	withTempDir('kit-check-throws-', async (root) => {
		const pkg = one(
			packagesFor(
				{
					scope: '@x/agent',
					variants: [{ suffix: '' }],
					binaries: [
						{
							shipsAs: 'agent',
							check: () => {
								throw new Error('the record is not where this expected');
							},
						},
					],
				},
				LINUX
			),
			'package'
		);
		mkdirSync(join(packageDir(root, pkg.dirName), 'bin'), { recursive: true });
		writeFileSync(join(packageDir(root, pkg.dirName), 'bin', 'agent'), 'anything');
		const reasons = verifyPackage({ root, pkg, version: '1.0.0', run: packs(CHECKED_FILES, { name: pkg.name }) });
		assert.match(one(reasons, 'reason'), /its check threw: the record is not where this expected/);
	}));
