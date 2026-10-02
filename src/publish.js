// @ts-check
// Every package is attempted, because a 404 means "no trusted publisher" as often as "not there". Each one's
// dist-tag is chosen before its publish, since OIDC authorises `npm publish` and no dist-tag write after it.

import { execFileSync } from 'node:child_process';

import { packageDir } from './layout.js';
import { isPublished, latestOf } from './published.js';

const NEEDS_SHELL = process.platform === 'win32';

/**
 * Why a version may not be published, or null. No prerelease goes out, so every published version is one a
 * bare `npm install` may be handed. @param {string} version @returns {string | null}
 */
export function prereleaseRefusal(version) {
	if (!version.includes('-')) return null;
	return (
		`version ${version} is a prerelease, and prereleases are not published. Release it as a plain ` +
		`major.minor.patch version and re-tag.`
	);
}

/**
 * `latest` for a version newer than the one `latest` names now, or for a name the registry has never
 * published; `release-<major>.<minor>` for a patch to an older line, so it cannot take `latest` from the
 * newer line. npm creates that tag in the same publish call.
 *
 * @param {string} version @param {string | null} current What `latest` names now, or null.
 */
export function distTag(version, current) {
	const refusal = prereleaseRefusal(version);
	if (refusal) throw new Error(refusal);
	if (current === null || current === version || isNewer(version, current)) return 'latest';
	const [major, minor] = version.split('.');
	return `release-${major}.${minor}`;
}

/**
 * A version the registry already serves is skipped, since npm refuses a republish and a re-run would otherwise
 * fail on the part of a release that worked and withhold the root over it. Each package's tag comes from its own
 * `latest`, since a name added after the first release has a `latest` of its own.
 *
 * @param {object} options
 * @param {string} options.root @param {readonly import('./packages.js').PlatformPackage[]} options.packages
 * @param {string} [options.rootName] The consumer's own package, published from `root` after the platform set.
 * @param {string} options.version
 * @param {(command: string, args: string[], options: any) => unknown} [options.run]
 * @param {(name: string, version: string) => Promise<{ published: boolean, detail: string }>} [options.onRegistry]
 * @param {(name: string) => Promise<string | null>} [options.onLatest] What `latest` names now; throws when
 *   the registry cannot tell.
 * @returns {Promise<{ published: string[], already: string[], failed: { name: string, reason: string }[], tags: Record<string, string>, lines: string[] }>}
 */
export async function publishAll({
	root,
	packages,
	rootName,
	version,
	run = execFileSync,
	onRegistry = (name, at) => isPublished(name, at),
	onLatest = (name) => latestOf(name),
}) {
	// Before any registry call, so a prerelease leaves no trace on it.
	const refusal = prereleaseRefusal(version);
	if (refusal) throw new Error(refusal);

	/** @type {string[]} */
	const published = [];
	/** @type {string[]} */
	const already = [];
	/** @type {{ name: string, reason: string }[]} */
	const failed = [];
	/** @type {Record<string, string>} */
	const tags = {};
	const lines = [];

	/** @param {string} name @param {string} cwd @param {string} hint What to add to a failure line. */
	const publishOne = async (name, cwd, hint) => {
		const { published: there } = await onRegistry(name, version);
		if (there) {
			already.push(name);
			lines.push(`already published ${name}@${version}; the registry serves it, so it was not published again`);
			return;
		}
		let current;
		try {
			current = await onLatest(name);
		} catch (error) {
			// Guessing latest could hand a patch to an older line to every bare `npm install`.
			const reason = `could not read its latest dist-tag: ${error instanceof Error ? error.message : String(error)}`;
			failed.push({ name, reason });
			lines.push(`FAILED ${name}@${version}: ${reason}. Nothing was published for it; re-run.`);
			return;
		}
		const tag = distTag(version, current);
		try {
			run('npm', ['publish', '--access', 'public', '--tag', tag], {
				cwd,
				encoding: 'utf-8',
				shell: NEEDS_SHELL,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			published.push(name);
			tags[name] = tag;
			lines.push(`published ${name}@${version} under ${tag}${current ? ` (latest named ${current})` : ''}`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			failed.push({ name, reason });
			lines.push(`FAILED ${name}@${version}: ${reason}${hint}`);
		}
	};

	const noPublisher =
		'. A 404 on PUT means this name has no trusted publisher for this repository and workflow, or does not ' +
		'exist yet, which trusted publishing cannot create: publish its first version by hand, add the trusted ' +
		'publisher, and re-run.';
	for (const pkg of packages) await publishOne(pkg.name, packageDir(root, pkg.dirName), noPublisher);

	// The root last, and only once every platform package is out: it declares them, so it must not arrive first.
	if (rootName && failed.length === 0) {
		await publishOne(rootName, root, '');
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
	return { published, already, failed, tags, lines };
}

/**
 * Whether `a` is a later release than `b`, on semver's own rules: numeric cores compare segment by segment,
 * and a prerelease sorts BELOW the release it precedes, so 1.2.3 is newer than 1.2.3-beta.9. Prereleases are
 * still compared because a `latest` already on the registry can name one.
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
