// @ts-check
// What the tarball carries, which is not what the tree carries: `files` and `.npmignore` apply at pack time.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { packageDir } from './layout.js';
import { expectedFiles } from './packages.js';

// Windows ships npm as npm.cmd and node refuses to spawn a .cmd without a shell (CVE-2024-27980), so without
// this the gate dies `spawnSync npm ENOENT` there rather than reading anything.
const NEEDS_SHELL = process.platform === 'win32';

/**
 * What `npm pack` would ship from `dir`.
 *
 * @param {string} dir @param {(command: string, args: string[], options: any) => string} [run]
 * @returns {{ name: string, version: string, files: string[], size: number }}
 */
export function packedContents(dir, run = execFileSync) {
	const out = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
		cwd: dir,
		encoding: 'utf-8',
		shell: NEEDS_SHELL,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const [packed] = JSON.parse(String(out));
	return {
		name: packed.name,
		version: packed.version,
		files: packed.files.map((/** @type {{ path: string }} */ file) => file.path),
		size: packed.size,
	};
}

/**
 * Every reason one staged package would be wrong to publish. Returns the reasons rather than throwing on the
 * first, so one run names everything rather than one thing per re-run.
 *
 * @param {object} options
 * @param {string} options.root @param {import('./packages.js').PlatformPackage} options.pkg
 * @param {string} options.version The version every package in this release must carry.
 * @param {(command: string, args: string[], options: any) => string} [options.run]
 * @returns {string[]}
 */
export function verifyPackage({ root, pkg, version, run }) {
	const dir = packageDir(root, pkg.dirName);
	const reasons = [];
	/** @type {ReturnType<typeof packedContents>} */
	let packed;
	try {
		packed = packedContents(dir, run);
	} catch (error) {
		return [`${pkg.name}: npm could not pack ${dir}: ${error instanceof Error ? error.message : String(error)}`];
	}

	if (packed.name !== pkg.name) reasons.push(`${pkg.name}: the staged manifest names ${packed.name}`);
	// One version across the release, because the base package pins its optionalDependencies at exactly this
	// one: a platform package a version behind is not installed, it is refused as unresolvable.
	if (packed.version !== version) {
		reasons.push(`${pkg.name}: staged at ${packed.version}, and this release is ${version}`);
	}
	for (const wanted of expectedFiles(pkg)) {
		if (!packed.files.includes(wanted)) reasons.push(`${pkg.name}: the tarball does not carry ${wanted}`);
	}
	for (const extra of pkg.extraDirs) {
		if (!packed.files.some((file) => file.startsWith(`${extra}/`))) {
			reasons.push(`${pkg.name}: the tarball carries nothing under ${extra}/`);
		}
	}

	// A symbol is a claim about what a binary was built WITH, and the only kind of defect a file listing
	// cannot see: a binary present, correctly named, the right size, and compiled without the thing it is for.
	for (const binary of pkg.binaries) {
		if (!binary.symbol && !binary.check) continue;
		const file = join(dir, 'bin', `${binary.shipsAs}${pkg.target.exe}`);
		let contents;
		try {
			contents = readFileSync(file);
		} catch {
			reasons.push(`${pkg.name}: ${binary.shipsAs} is not readable at ${file}`);
			continue;
		}
		if (binary.symbol && !contents.includes(binary.symbol)) {
			reasons.push(
				`${pkg.name}: ${binary.shipsAs} does not contain ${JSON.stringify(binary.symbol)}, so it was built ` +
					`without the capability that symbol stands for`
			);
		}
		// A throw is a refusal too, or the gate would approve every artifact whose record it failed to parse.
		if (binary.check) {
			let refusal;
			try {
				refusal = binary.check(contents, binary);
			} catch (error) {
				refusal = `its check threw: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (refusal) reasons.push(`${pkg.name}: ${binary.shipsAs} ${refusal}`);
		}
	}
	return reasons;
}

/**
 * Every package in the release, and every reason any of them should not ship.
 *
 * @param {object} options
 * @param {string} options.root @param {readonly import('./packages.js').PlatformPackage[]} options.packages
 * @param {string} options.version @param {(c: string, a: string[], o: any) => string} [options.run]
 * @returns {string[]}
 */
export const verifyAll = ({ root, packages, version, run }) =>
	packages.flatMap((pkg) => verifyPackage({ root, pkg, version, ...(run ? { run } : {}) }));
