// @ts-check
// Whether a binary will load on the image it ships to. The loader refuses one needing more than the image
// provides, at exec time on a customer's node, while every test on the runner that built it passes.

import { readFileSync } from 'node:fs';

/**
 * Every version of `prefix` a file's strings name, highest last. Reads the file rather than shelling out to
 * `strings`, which is absent on Windows runners and is one more thing to be installed on the others.
 *
 * @param {Buffer} contents @param {string} prefix e.g. `GLIBC` or `GLIBCXX`.
 * @returns {string[]}
 */
export function referencedVersions(contents, prefix) {
	// Anchored on the underscore so GLIBC_ never matches GLIBCXX_, a family with its own floor.
	const pattern = new RegExp(`${prefix}_([0-9]+(?:\\.[0-9]+)*)`, 'g');
	const found = new Set();
	for (const match of contents.toString('latin1').matchAll(pattern)) found.add(match[1]);
	return [...found].sort(compareVersions);
}

/** Numeric, segment by segment: `2.10` is above `2.9`, which a string sort reads the other way. @param {string} a @param {string} b */
export function compareVersions(a, b) {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * What one binary needs against what the image provides. Referencing nothing from a family is neither pass
 * nor failure: it is statically linked, or the platform has no such library.
 *
 * @param {object} options
 * @param {string} options.file
 * @param {Record<string, string>} options.floor Library prefix to the highest version the image provides.
 * @param {(path: string) => Buffer} [options.read]
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkFloor({ file, floor, read = readFileSync }) {
	/** @type {Buffer} */
	let contents;
	try {
		contents = read(file);
	} catch (error) {
		return {
			ok: false,
			lines: [`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	const lines = [];
	let ok = true;
	for (const [prefix, provided] of Object.entries(floor)) {
		const needed = referencedVersions(contents, prefix).at(-1);
		if (needed === undefined) {
			lines.push(`${file}: references no ${prefix}_ version; nothing to check against ${prefix}_${provided}`);
			continue;
		}
		if (compareVersions(needed, provided) > 0) {
			ok = false;
			lines.push(
				`${file}: needs ${prefix}_${needed} and the target image provides ${prefix}_${provided}. Build on an ` +
					`older toolchain, or the binary will not load at all on that image.`
			);
			continue;
		}
		lines.push(`${file}: needs up to ${prefix}_${needed}; the image provides ${prefix}_${provided}`);
	}
	return { ok, lines };
}

/**
 * Every binary of one target against the floor. Only where a floor is declared for that target: macOS and
 * Windows link nothing this applies to, and a floor invented for them would fail every build.
 *
 * @param {object} options
 * @param {readonly string[]} options.files @param {Record<string, string>} options.floor
 * @param {(path: string) => Buffer} [options.read]
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function checkFloors({ files, floor, read }) {
	// Spread rather than passed as undefined: exactOptionalPropertyTypes reads an explicit undefined as a
	// different thing from an absent key, and checkFloor's default only applies to the absent one.
	const results = files.map((file) => checkFloor({ file, floor, ...(read ? { read } : {}) }));
	return { ok: results.every((result) => result.ok), lines: results.flatMap((result) => result.lines) };
}
