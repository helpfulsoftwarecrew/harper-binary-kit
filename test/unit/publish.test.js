// Getting the packages onto the registry, and saying which did not get there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { advanceLatest, distTag, isNewer, publishAll } from '../../src/publish.js';
import { confirmPublished, isPublished, readBackLine, versionUrl } from '../../src/published.js';

/**
 * Only the two fields the publish path reads. Cast because a full PlatformPackage carries a target, a variant
 * and its binaries, and none of that is what publishing does.
 *
 * @type {readonly import('../../src/packages.js').PlatformPackage[]}
 */
const PACKAGES = /** @type {any} */ ([
	{ name: '@x/a-linux-x86_64', dirName: 'linux-x86_64' },
	{ name: '@x/a-probe-linux-x86_64', dirName: 'probe-linux-x86_64' },
	{ name: '@x/a-macos-arm64', dirName: 'macos-arm64' },
]);

/** A fetch that answers whatever the case needs, without the rest of the Response surface. */
const answering = (/** @type {(url: string) => any} */ reply) =>
	/** @type {typeof globalThis.fetch} */ (/** @type {any} */ (async (/** @type {any} */ url) => reply(String(url))));

/** A registry that holds exactly `names` at any version, as publishAll asks it before each `npm publish`. */
const holding =
	(/** @type {readonly string[]} */ names) => async (/** @type {string} */ name, /** @type {string} */ version) =>
		names.includes(name)
			? { published: true, detail: `${name}@${version} is on the registry` }
			: { published: false, detail: `the registry has no ${name}@${version}` };

/** A first publish: nothing is on the registry yet, and no case reaches the network to find that out. */
const nothingThere = holding([]);

test('a prerelease publishes under next, a stable one under latest', () => {
	assert.equal(distTag('9.9.9-next.10'), 'next');
	assert.equal(distTag('1.0.0-rc.3'), 'next', 'a candidate is a prerelease like any other');
	assert.equal(distTag('8.0.0-rc.1'), 'next');
	assert.equal(distTag('2.0.0-beta.4'), 'next');
	assert.equal(distTag('1.0.0'), 'latest');
});

// `npm version prerelease` writes `1.2.3-0` when nobody passed --preid, a release nobody chose.
test('NEGATIVE: a numeric prerelease identifier is refused, and the message names the fix', () => {
	assert.throws(() => distTag('1.2.3-0'), /a number/);
	assert.throws(() => distTag('1.2.3-0'), /1\.2\.3-next\.0/);
});

// A loop that stops at the first failure says nothing about whether the rest would have worked.
test('NEGATIVE: one failure does not stop the packages behind it', async () => {
	/** @type {string[]} */
	const attempted = [];
	const run = (/** @type {string} */ _command, /** @type {string[]} */ args, /** @type {any} */ options) => {
		attempted.push(options.cwd);
		if (options.cwd.endsWith('probe-linux-x86_64')) throw new Error('404 Not Found - PUT');
		return '';
	};
	const { published, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '1.0.0-next.1',
		run,
		onRegistry: nothingThere,
	});
	assert.equal(attempted.length, 3, 'the loop stopped early');
	assert.deepEqual(published, ['@x/a-linux-x86_64', '@x/a-macos-arm64']);
	assert.deepEqual(
		failed.map((f) => f.name),
		['@x/a-probe-linux-x86_64']
	);
	// A 404 on PUT reads like a missing package, so the line has to name the trusted publisher.
	assert.ok(lines.some((line) => line.includes('trusted publisher')));
});

// Without its root, a release leaves the version resolving to nothing installable.
test('the root package is published too, from the repo, after the platform set', async () => {
	/** @type {string[]} */
	const cwds = [];
	const { published } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0-next.1',
		onRegistry: nothingThere,
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			return '';
		},
	});
	assert.ok(published.includes('@x/a'), 'the root package was never published');
	assert.equal(cwds.at(-1), '/repo', 'the root publishes from the repo root, and last');
	assert.equal(cwds.length, PACKAGES.length + 1);
});

// A root on the registry ahead of its binaries is the worse failure: npm installs it and resolves its
// optionalDependencies to versions that are not there.
test('NEGATIVE: the root is held back when any platform package did not publish', async () => {
	const { published, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0-next.1',
		onRegistry: nothingThere,
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			if (String(options.cwd).includes('probe')) throw new Error('404');
			return '';
		},
	});
	assert.ok(!published.includes('@x/a'), 'the root went out over a failed platform package');
	assert.equal(failed.length, 1, 'the root must not be counted as a failure of its own');
	assert.ok(lines.some((line) => line.includes('did not publish @x/a@1.0.0-next.1')));
});

test('every package is published under the tag the version derives', async () => {
	/** @type {string[]} */
	const tags = [];
	await publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '2.0.0-beta.4',
		onRegistry: nothingThere,
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			tags.push(String(args[args.indexOf('--tag') + 1]));
			return '';
		},
	});
	assert.deepEqual(tags, ['next', 'next', 'next'], 'a beta goes out under next, not under its own identifier');
});

// npm refuses a republish, so without the check a re-run of a job that had already put part of a release out
// would fail on the part that worked and withhold the root over it, leaving a new version as the only way on.
test('NEGATIVE: a re-run skips what the registry already holds, publishes the rest, then the root', async () => {
	/** @type {string[]} */
	const cwds = [];
	const out = ['@x/a-linux-x86_64', '@x/a-probe-linux-x86_64'];
	const { published, already, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0-rc.1',
		onRegistry: holding(out),
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			// What the registry answers a republish; reaching it means the check above was skipped.
			if (!String(options.cwd).endsWith('macos-arm64') && options.cwd !== '/repo') {
				throw new Error('403 Forbidden - PUT - You cannot publish over the previously published versions');
			}
			return '';
		},
	});
	assert.deepEqual(failed, [], 'a version the registry already serves was counted as a failure');
	assert.deepEqual(already, out);
	assert.deepEqual(published, ['@x/a-macos-arm64', '@x/a']);
	assert.equal(cwds.length, 2, 'npm publish ran for a version the registry already held');
	assert.ok(lines.some((line) => line.includes('already published @x/a-linux-x86_64@1.0.0-rc.1')));
});

test('a re-run that finds the whole release out publishes nothing, and says so', async () => {
	let runs = 0;
	const { published, already, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0',
		onRegistry: holding(['@x/a', ...PACKAGES.map((pkg) => pkg.name)]),
		run: () => {
			runs++;
			return '';
		},
	});
	assert.equal(runs, 0);
	assert.deepEqual(published, []);
	assert.deepEqual(failed, []);
	assert.equal(already.length, PACKAGES.length + 1);
	assert.match(String(lines.at(-1)), /nothing new to publish: all 4 package\(s\) of 1\.0\.0/);
});

// Skipping is for a clean yes only. A registry that could not tell must not turn into a package nobody published.
test('NEGATIVE: a registry that cannot tell is not taken as published', async () => {
	/** @type {string[]} */
	const cwds = [];
	const { published, already } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '1.0.0',
		onRegistry: async () => ({ published: false, detail: 'the registry answered 503' }),
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			return '';
		},
	});
	assert.equal(cwds.length, PACKAGES.length);
	assert.deepEqual(already, []);
	assert.equal(published.length, PACKAGES.length);
});

test('latest moves to this release', () => {
	/** @type {string[]} */
	const moved = [];
	const { failed } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '1.2.0',
		currentLatest: () => '1.1.0',
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			moved.push(String(args[2]));
			return '';
		},
	});
	assert.deepEqual(moved, ['@x/a@1.2.0', '@x/a-linux-x86_64@1.2.0']);
	assert.deepEqual(failed, []);
});

// Forward only: a re-run of an older tag must not walk latest backwards over the release that followed it.
test('NEGATIVE: latest is never walked backwards', () => {
	/** @type {string[]} */
	const moved = [];
	const { left, lines } = advanceLatest({
		names: ['@x/a'],
		version: '1.1.0',
		currentLatest: () => '1.2.0',
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			moved.push(String(args[2]));
			return '';
		},
	});
	assert.deepEqual(moved, [], 'an older re-run moved latest back');
	assert.deepEqual(left, ['@x/a']);
	assert.match(String(lines[0]), /newer than 1\.1\.0/);
});

// The stable release's own publish already moved latest, so the tag write could only repeat it, and it was the
// one step that still needed a live token: an expired one would turn a finished release red.
test('NEGATIVE: latest that already names this version is left alone, with no registry write', () => {
	let runs = 0;
	const { moved, already, failed, lines } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '1.0.0',
		currentLatest: () => '1.0.0',
		run: () => {
			runs++;
			throw new Error('E401 Unable to authenticate');
		},
	});
	assert.equal(runs, 0, 'a dist-tag write ran for a tag that already named this version');
	assert.deepEqual(failed, []);
	assert.deepEqual(moved, []);
	assert.deepEqual(already, ['@x/a', '@x/a-linux-x86_64']);
	assert.match(String(lines[0]), /latest already names 1\.0\.0 for @x\/a/);
});

// A candidate on next must never become what a bare `npm install` gets.
test('NEGATIVE: a prerelease never moves latest, and never asks the registry', () => {
	let runs = 0;
	let asked = 0;
	const { moved, left, failed, lines } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '8.0.0-rc.1',
		currentLatest: () => {
			asked++;
			return '7.0.0';
		},
		run: () => {
			runs++;
			return '';
		},
	});
	assert.equal(runs, 0, 'a prerelease wrote latest');
	assert.equal(asked, 0, 'a prerelease asked the registry what latest says');
	assert.deepEqual(moved, []);
	assert.deepEqual(failed, []);
	assert.deepEqual(left, ['@x/a', '@x/a-linux-x86_64']);
	assert.deepEqual(lines, ['left latest alone: 8.0.0-rc.1 is a prerelease']);
});

// A prerelease sorts below the release it precedes, so 1.2.3 replacing 1.2.3-next.9 is forward.
test('a stable release is newer than its own prereleases', () => {
	assert.equal(isNewer('1.2.3', '1.2.3-next.9'), true);
	assert.equal(isNewer('1.2.3-next.9', '1.2.3'), false);
	assert.equal(isNewer('9.9.9-next.10', '9.9.9-next.9'), true, 'next.10 sorts above next.9, not below it');
	assert.equal(isNewer('9.9.9-next.9', '9.9.9-next.10'), false);
	assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true, 'the stable release is newer than its candidate');
	assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

// OIDC covers `npm publish` and not `dist-tag add`, so a refused tag write has to hand over the command.
test('NEGATIVE: a refused dist-tag write is reported with the command to run by hand', () => {
	const { failed, commands, lines } = advanceLatest({
		names: ['@x/a', '@x/a-linux-x86_64'],
		version: '1.2.0',
		currentLatest: () => null,
		run: () => {
			throw new Error('E401 Unable to authenticate');
		},
	});
	assert.deepEqual(failed, ['@x/a', '@x/a-linux-x86_64']);
	assert.deepEqual(commands, ['npm dist-tag add @x/a@1.2.0 latest', 'npm dist-tag add @x/a-linux-x86_64@1.2.0 latest']);
	assert.ok(lines.every((line) => line.includes('could not move latest') || line.includes('latest ->')));
});

test('the read-back asks the registry for the exact version', () => {
	assert.equal(
		versionUrl('@x/a-linux-x86_64', '1.0.0-next.1'),
		'https://registry.npmjs.org/@x%2Fa-linux-x86_64/1.0.0-next.1'
	);
});

test('a version the registry serves reads as published', async () => {
	const { published } = await isPublished('@x/a', '1.0.0', {
		fetch: answering(() => ({ status: 200, ok: true, json: async () => ({ name: '@x/a', version: '1.0.0' }) })),
	});
	assert.equal(published, true);
});

test('NEGATIVE: a 404 is the only answer that reads as not published', async () => {
	const missing = await isPublished('@x/a', '1.0.0', { fetch: answering(() => ({ status: 404, ok: false })) });
	assert.equal(missing.published, false);
	assert.match(missing.detail, /has no @x\/a@1\.0\.0/);
});

// Telling somebody to republish something already published is worse than saying nothing, so everything that
// is not a clean 404 or a clean match reports why it could not tell rather than asserting absence.
test('NEGATIVE: a registry that will not answer is "could not tell", with the reason', async () => {
	/** @type {[(url: string) => any, RegExp][]} */
	const cases = [
		[() => ({ status: 503, ok: false }), /answered 503/],
		[
			() => {
				throw new Error('ETIMEDOUT');
			},
			/could not reach the registry: ETIMEDOUT/,
		],
		[
			() => ({
				status: 200,
				ok: true,
				json: async () => {
					throw new Error('Unexpected end of JSON input');
				},
			}),
			/did not parse/,
		],
		[
			() => ({ status: 200, ok: true, json: async () => ({ name: '@x/a', version: '0.9.0' }) }),
			/answered with @x\/a@0\.9\.0/,
		],
	];
	for (const [respond, expected] of cases) {
		const answer = await isPublished('@x/a', '1.0.0', { fetch: answering(respond) });
		assert.equal(answer.published, false);
		assert.match(answer.detail, expected);
	}
});

/** A registry answering 200 for every name, with `absent` 404 until it has been asked `appearAfter` times. */
function registry(/** @type {string[]} */ absent = [], appearAfter = Infinity) {
	const asked = new Map();
	const fetch = answering((url) => {
		const name = decodeURIComponent(String(url.split('/').at(-2)));
		const count = (asked.get(name) ?? 0) + 1;
		asked.set(name, count);
		if (absent.includes(name) && count <= appearAfter) return { status: 404, ok: false };
		return { status: 200, ok: true, json: async () => ({ name, version: '1.0.0' }) };
	});
	return { fetch, asked };
}

/** A clock that advances only when the code under test waits, so a long deadline costs no real time. */
function fakeClock() {
	let t = 0;
	return { now: () => t, wait: async (/** @type {number} */ ms) => void (t += ms) };
}

test('a release is confirmed package by package, and names the ones that are not there', async () => {
	const { ok, missing } = await confirmPublished({
		names: ['@x/a', '@x/a-linux-x86_64', '@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch: registry(['@x/a-probe-linux-x86_64']).fetch,
		...fakeClock(),
	});
	assert.equal(ok, false);
	assert.deepEqual(missing, ['@x/a-probe-linux-x86_64']);
});

test('a package the registry has not served yet is waited for, not called missing', async () => {
	const { fetch, asked } = registry(['@x/a-probe-linux-x86_64'], 3);
	const { ok, missing } = await confirmPublished({
		names: ['@x/a', '@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch,
		...fakeClock(),
	});
	assert.equal(ok, true, `it gave up on a package that did appear: ${missing.join(', ')}`);
	assert.equal(asked.get('@x/a-probe-linux-x86_64'), 4, 'it should have asked until the answer changed');
	assert.equal(asked.get('@x/a'), 1, 'a package already served should not be asked again');
});

// The retry must not turn a real failure into a pass, which is the whole risk of adding one.
test('NEGATIVE: a package that never appears still fails, and the wait is bounded', async () => {
	const clock = fakeClock();
	const { fetch, asked } = registry(['@x/a-probe-linux-x86_64']);
	const { ok, missing } = await confirmPublished({
		names: ['@x/a-probe-linux-x86_64'],
		version: '1.0.0',
		fetch,
		timeoutMs: 60_000,
		intervalMs: 15_000,
		...clock,
	});
	assert.equal(ok, false);
	assert.deepEqual(missing, ['@x/a-probe-linux-x86_64']);
	assert.equal(clock.now(), 60_000, 'it waited past its own deadline');
	assert.equal(asked.get('@x/a-probe-linux-x86_64'), 5, 'four waits of 15s, and a read before each');
});

// A failed read-back would skip the step that moves `latest`, though every package is on the registry.
test('an unconfirmed read-back reads as a wait, not a failed release', () => {
	const line = readBackLine(['@x/a-probe-macos-arm64'], '9.9.9');
	assert.match(line, /@x\/a-probe-macos-arm64/, 'the operator cannot act on a warning that names nothing');
	assert.match(line, /9\.9\.9/);
	assert.match(line, /npm accepted every publish/, 'it must say the release itself is not in doubt');
	assert.match(line, /Moving latest is the next step/, 'and point at the step that decides');
	assert.doesNotMatch(line, /fail(ed|ure)\b(?!s if)/i, 'nothing here is a failure yet');
});

// A prerelease leaves latest alone, so pointing at the tag step would point at a step that does not run.
test('NEGATIVE: an unconfirmed prerelease read-back names the check to repeat, not the tag step', () => {
	const line = readBackLine(['@x/a-probe-macos-arm64'], '9.9.9-next.15');
	assert.match(line, /@x\/a-probe-macos-arm64/);
	assert.match(line, /npm accepted every publish/);
	assert.match(line, /npm view <name>@9\.9\.9-next\.15 version/, 'the operator needs the question to ask again');
	assert.doesNotMatch(line, /Moving latest is the next step/);
	assert.doesNotMatch(line, /fail(ed|ure)\b(?!s if)/i, 'nothing here is a failure yet');
});

test('a confirmed read-back claims nothing is missing', () => {
	const line = readBackLine([], '9.9.9-next.15');
	assert.equal(line, 'every package of 9.9.9-next.15 is on the registry');
	assert.doesNotMatch(line, /not served|absent|yet/);
});

// Only the ceiling separates a slow read from an absent package, so a lower default is a regression.
test('the read-back waits half an hour before it gives up', async () => {
	const clock = fakeClock();
	const { fetch } = registry(['@x/a']);
	await confirmPublished({ names: ['@x/a'], version: '1.0.0', fetch, ...clock });
	assert.equal(clock.now(), 30 * 60_000, 'the default ceiling moved');
});
