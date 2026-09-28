// Scratch space for tests that stage real packages and read them back. Small on purpose: a helper that grows
// is a second thing to understand before reading a test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A temp directory for `run`'s duration, removed however it ends. @param {string} prefix @param {(dir: string) => any} run */
export async function withTempDir(prefix, run) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		return await run(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The one element a fixture should have produced. Destructuring gives `T | undefined`, and a test that ran
 * against `undefined` because its fixture produced nothing proves nothing.
 *
 * @template T @param {readonly T[]} list @param {string} what @param {number} [index]
 * @returns {T}
 */
export function one(list, what, index = 0) {
	const found = list[index];
	if (found === undefined) throw new Error(`the fixture produced no ${what} at index ${index}`);
	return found;
}

/** Whether `dir`'s filesystem keeps an executable bit. NTFS does not, and no chmod there makes it. @param {string} dir */
export function carriesExecutableBit(dir) {
	const probe = path.join(dir, '.exec-probe');
	fs.writeFileSync(probe, '');
	fs.chmodSync(probe, 0o755);
	const carried = (fs.statSync(probe).mode & 0o111) === 0o111;
	fs.rmSync(probe);
	return carried;
}
