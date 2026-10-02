// @ts-check
// Every package is attempted, because a 404 means "no trusted publisher" as often as "not there"; `latest`
// moves for a stable version only, forward only.

import { execFileSync } from 'node:child_process';

import { packageDir } from './layout.js';
import { isPublished } from './published.js';

const NEEDS_SHELL = process.platform === 'win32';

/**
 * `next` for any prerelease and `latest` for a stable version, so only a stable release moves what a bare
 * `npm install` gets. A numeric prerelease identifier is refused, the same rule publish.yml keeps.
 *
 * @param {string} version @returns {'next' | 'latest'}
 */
export function distTag(version) {
	const identifier = version.split('-')[1]?.split('.')[0];
	if (identifier === undefined) return 'latest';
	if (/^\d/.test(identifier)) {
		throw new Error(
			`version ${version} has the prerelease identifier "${identifier}", a number, which is what ` +
				`\`npm version prerelease\` writes when no --preid was given. Name the prerelease (1.2.3-next.0, ` +
				`1.2.3-beta.0) and re-tag.`
		);
	}
	return 'next';
}

/**
 * A version the registry already serves is skipped, since npm refuses a republish and a re-run would otherwise
 * fail on the part of a release that worked and withhold the root over it.
 *
 * @param {object} options
 * @param {string} options.root @param {readonly import('./packages.js').PlatformPackage[]} options.packages
 * @param {string} [options.rootName] The consumer's own package, published from `root` after the platform set.
 * @param {string} options.version @param {string} [options.tag]
 * @param {(command: string, args: string[], options: any) => unknown} [options.run]
 * @param {(name: string, version: string) => Promise<{ published: boolean, detail: string }>} [options.onRegistry]
 * @returns {Promise<{ published: string[], already: string[], failed: { name: string, reason: string }[], lines: string[] }>}
 */
export async function publishAll({
	root,
	packages,
	rootName,
	version,
	tag = distTag(version),
	run = execFileSync,
	onRegistry = (name, at) => isPublished(name, at),
}) {
	const published = [];
	/** @type {string[]} */
	const already = [];
	const failed = [];
	const lines = [];

	/** @param {string} name */
	const alreadyThere = async (name) => {
		const { published: there } = await onRegistry(name, version);
		if (!there) return false;
		already.push(name);
		lines.push(`already published ${name}@${version}; the registry serves it, so it was not published again`);
		return true;
	};

	const attempt = packages.map((pkg) => ({ name: pkg.name, cwd: packageDir(root, pkg.dirName) }));
	for (const pkg of attempt) {
		if (await alreadyThere(pkg.name)) continue;
		try {
			run('npm', ['publish', '--access', 'public', '--tag', tag], {
				cwd: pkg.cwd,
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			published.push(pkg.name);
			lines.push(`published ${pkg.name}@${version} under ${tag}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failed.push({ name: pkg.name, reason });
			lines.push(
				`FAILED ${pkg.name}@${version}: ${reason}. A 404 on PUT means this name has no trusted publisher for ` +
					`this repository and workflow; create one and re-run.`
			);
		}
	}

	// The root last, and only once every platform package is out: it declares them, so it must not arrive first.
	if (rootName && failed.length === 0) {
		if (!(await alreadyThere(rootName))) {
			try {
				run('npm', ['publish', '--access', 'public', '--tag', tag], {
					cwd: root,
					encoding: 'utf-8',
					shell: NEEDS_SHELL,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				published.push(rootName);
				lines.push(`published ${rootName}@${version} under ${tag}`);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				failed.push({ name: rootName, reason });
				lines.push(`FAILED ${rootName}@${version}: ${reason}`);
			}
		}
	} else if (rootName) {
		lines.push(
			`did not publish ${rootName}@${version}: ${failed.length} platform package(s) did not go out, and a root ` +
				`whose optionalDependencies are not on the registry installs without its binaries.`
		);
	}
	// A re-run that finds the whole release out publishes nothing, and says so rather than reading as a release.
	if (published.length === 0 && failed.length === 0 && already.length > 0) {
		lines.push(`nothing new to publish: all ${already.length} package(s) of ${version} were already on the registry`);
	}
	return { published, already, failed, lines };
}

/**
 * Forward only, so a re-run of an older tag cannot walk `latest` back. A `latest` already naming this version
 * is not written again, since that write would be the one step still needing a live token.
 *
 * @param {object} options
 * @param {readonly string[]} options.names @param {string} options.version
 * @param {(command: string, args: string[], options: any) => unknown} [options.run]
 * @param {(name: string) => string | null} [options.currentLatest] What `latest` says now, or null.
 * @returns {{ moved: string[], left: string[], already: string[], failed: string[], lines: string[], commands: string[] }}
 */
export function advanceLatest({ names, version, run = execFileSync, currentLatest = readLatest }) {
	if (distTag(version) !== 'latest') {
		return {
			moved: [],
			left: [...names],
			already: [],
			failed: [],
			lines: [`left latest alone: ${version} is a prerelease`],
			commands: [],
		};
	}
	const moved = [];
	const left = [];
	/** @type {string[]} */
	const already = [];
	const failed = [];
	const lines = [];
	const commands = [];
	for (const name of names) {
		const current = currentLatest(name);
		if (current === version) {
			already.push(name);
			lines.push(`latest already names ${version} for ${name}; nothing to write`);
			continue;
		}
		if (current && isNewer(current, version)) {
			left.push(name);
			lines.push(`left ${name} at latest=${current}, which is newer than ${version}`);
			continue;
		}
		try {
			run('npm', ['dist-tag', 'add', `${name}@${version}`, 'latest'], {
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			moved.push(name);
			lines.push(`latest -> ${version} for ${name}`);
		} catch (error) {
			failed.push(name);
			commands.push(`npm dist-tag add ${name}@${version} latest`);
			lines.push(`could not move latest for ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { moved, left, already, failed, lines, commands };
}

/** @param {string} name @returns {string | null} */
function readLatest(name) {
	try {
		return String(
			execFileSync('npm', ['view', name, 'dist-tags.latest'], {
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'ignore'],
			})
		).trim();
	} catch {
		// A package with no `latest` at all, or one that is not published yet. Either way nothing to compare.
		return null;
	}
}

/**
 * Whether `a` is a later release than `b`, on semver's own rules: numeric cores compare segment by segment,
 * and a prerelease sorts BELOW the release it precedes, so 1.2.3 is newer than 1.2.3-next.9.
 *
 * @param {string} a @param {string} b
 */
export function isNewer(a, b) {
	const [coreA, preA] = split(a);
	const [coreB, preB] = split(b);
	for (let i = 0; i < 3; i++) {
		const difference = (coreA[i] ?? 0) - (coreB[i] ?? 0);
		if (difference !== 0) return difference > 0;
	}
	if (preA === null && preB === null) return false;
	if (preA === null) return true;
	if (preB === null) return false;
	return comparePrerelease(preA, preB) > 0;
}

/** @param {string} version @returns {[number[], string | null]} */
function split(version) {
	const [core = '', ...rest] = version.split('-');
	return [core.split('.').map(Number), rest.length ? rest.join('-') : null];
}

/** Dot-separated identifiers: numeric ones compare numerically, and a numeric one sorts below a text one. @param {string} a @param {string} b */
function comparePrerelease(a, b) {
	const left = a.split('.');
	const right = b.split('.');
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const x = left[i];
		const y = right[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
		if (numeric) {
			if (Number(x) !== Number(y)) return Number(x) - Number(y);
			continue;
		}
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}
