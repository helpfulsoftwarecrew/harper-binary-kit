// Getting the packages onto the registry, and saying which did not get there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { distTag, isNewer, prereleaseRefusal, publishAll } from '../../src/publish.js';
import { confirmPublished, isPublished, latestOf, readBackLine, versionUrl } from '../../src/published.js';

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

/** No name has a `latest` yet, answered without the network. */
const noLatest = async () => null;

// Nothing marks a prerelease as one but the hyphen, so every one of them is refused, named or numbered.
test('NEGATIVE: every prerelease is refused, and the message says what to release instead', () => {
	for (const version of ['1.0.0-alpha.3', '8.0.0-beta.1', '1.2.3-0', '2.0.0-rc.1']) {
		assert.match(String(prereleaseRefusal(version)), /prerelease.*plain major\.minor\.patch/);
		assert.throws(() => distTag(version, null), /is a prerelease/);
	}
	assert.equal(prereleaseRefusal('1.0.0'), null);
});

test('a version newer than latest, or a name with no latest, publishes under latest', () => {
	assert.equal(distTag('1.2.0', '1.1.9'), 'latest');
	assert.equal(distTag('2.0.0', '1.10.0'), 'latest');
	assert.equal(distTag('1.0.0', null), 'latest', 'a new name takes latest on its first publish');
	assert.equal(distTag('1.0.0', '1.0.0-beta.1'), 'latest', 'a release replaces a prerelease left as latest');
});

// A patch to an older line under latest would hand every bare `npm install` the older line.
test('NEGATIVE: a patch to an older line publishes under its own line tag, never latest', () => {
	assert.equal(distTag('8.0.1', '8.1.0'), 'release-8.0');
	assert.equal(distTag('7.4.12', '8.0.0'), 'release-7.4');
	assert.equal(distTag('1.0.2', '1.0.3'), 'release-1.0', 'an older patch of the same line still leaves latest alone');
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
		version: '1.0.0',
		run,
		onRegistry: nothingThere,
		onLatest: noLatest,
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
		version: '1.0.0',
		onRegistry: nothingThere,
		onLatest: noLatest,
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
		version: '1.0.0',
		onRegistry: nothingThere,
		onLatest: noLatest,
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			if (String(options.cwd).includes('probe')) throw new Error('404');
			return '';
		},
	});
	assert.ok(!published.includes('@x/a'), 'the root went out over a failed platform package');
	assert.equal(failed.length, 1, 'the root must not be counted as a failure of its own');
	assert.ok(lines.some((line) => line.includes('did not publish @x/a@1.0.0')));
});

// A name added after the first release has its own latest, so one answer for the whole release would be wrong.
test('each package is published under the tag its own latest calls for', async () => {
	/** @type {Record<string, string>} */
	const latest = { '@x/a-linux-x86_64': '8.1.0', '@x/a-probe-linux-x86_64': '8.0.0' };
	/** @type {string[]} */
	const tags = [];
	const result = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		version: '8.0.1',
		onRegistry: nothingThere,
		onLatest: async (name) => latest[name] ?? null,
		run: (/** @type {string} */ _c, /** @type {string[]} */ args) => {
			tags.push(String(args[args.indexOf('--tag') + 1]));
			return '';
		},
	});
	assert.deepEqual(tags, ['release-8.0', 'latest', 'latest']);
	assert.deepEqual(result.tags, {
		'@x/a-linux-x86_64': 'release-8.0',
		'@x/a-probe-linux-x86_64': 'latest',
		'@x/a-macos-arm64': 'latest',
	});
	assert.ok(result.lines.includes('published @x/a-linux-x86_64@8.0.1 under release-8.0 (latest named 8.1.0)'));
});

test('NEGATIVE: a prerelease is refused before the registry is asked anything', async () => {
	let calls = 0;
	const count = async () => {
		calls++;
		return null;
	};
	await assert.rejects(
		publishAll({
			root: '/repo',
			packages: PACKAGES,
			version: '2.0.0-beta.4',
			onRegistry: async () => {
				calls++;
				return { published: false, detail: '' };
			},
			onLatest: count,
			run: () => {
				calls++;
				return '';
			},
		}),
		/2\.0\.0-beta\.4 is a prerelease/
	);
	assert.equal(calls, 0);
});

// Guessing latest when the registry cannot say could put a patch to an older line in front of every install.
test('NEGATIVE: a latest the registry cannot read fails that package unpublished, and holds the root', async () => {
	/** @type {string[]} */
	const cwds = [];
	const { published, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.1',
		onRegistry: nothingThere,
		onLatest: async (name) => {
			if (name.includes('probe')) throw new Error('the registry answered 503 for ' + name);
			return '1.0.0';
		},
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			return '';
		},
	});
	assert.deepEqual(
		failed.map((f) => f.name),
		['@x/a-probe-linux-x86_64']
	);
	assert.equal(cwds.length, 2, 'npm publish ran for a package whose latest was unknown');
	assert.ok(!published.includes('@x/a'));
	assert.ok(lines.some((line) => line.includes('could not read its latest dist-tag: the registry answered 503')));
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
		version: '1.0.0',
		onRegistry: holding(out),
		onLatest: noLatest,
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
	assert.ok(lines.some((line) => line.includes('already published @x/a-linux-x86_64@1.0.0')));
});

test('a re-run that finds the whole release out publishes nothing, and says so', async () => {
	let runs = 0;
	const { published, already, failed, lines } = await publishAll({
		root: '/repo',
		packages: PACKAGES,
		rootName: '@x/a',
		version: '1.0.0',
		onRegistry: holding(['@x/a', ...PACKAGES.map((pkg) => pkg.name)]),
		onLatest: noLatest,
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
		onLatest: noLatest,
		run: (/** @type {string} */ _c, /** @type {string[]} */ _a, /** @type {any} */ options) => {
			cwds.push(String(options.cwd));
			return '';
		},
	});
	assert.equal(cwds.length, PACKAGES.length);
	assert.deepEqual(already, []);
	assert.equal(published.length, PACKAGES.length);
});

// A latest already on the registry can name a prerelease, which sorts below the release it precedes.
test('a stable release is newer than its own prereleases', () => {
	assert.equal(isNewer('1.2.3', '1.2.3-beta.9'), true);
	assert.equal(isNewer('1.2.3-beta.9', '1.2.3'), false);
	assert.equal(isNewer('9.9.9-beta.10', '9.9.9-beta.9'), true, 'beta.10 sorts above beta.9, not below it');
	assert.equal(isNewer('9.9.9-beta.9', '9.9.9-beta.10'), false);
	assert.equal(isNewer('1.0.0', '1.0.0-beta.1'), true, 'the stable release is newer than its prerelease');
	assert.equal(isNewer('1.10.0', '1.9.0'), true);
});

test('the read-back asks the registry for the exact version', () => {
	assert.equal(versionUrl('@x/a-linux-x86_64', '1.0.1'), 'https://registry.npmjs.org/@x%2Fa-linux-x86_64/1.0.1');
});

test('latest is read from the dist-tags, and a name the registry never published has none', async () => {
	/** @type {string[]} */
	const urls = [];
	const latest = await latestOf('@x/a', {
		fetch: answering((url) => {
			urls.push(url);
			return { status: 200, ok: true, json: async () => ({ 'dist-tags': { latest: '8.1.0' } }) };
		}),
	});
	assert.equal(latest, '8.1.0');
	assert.deepEqual(urls, ['https://registry.npmjs.org/@x%2Fa']);
	assert.equal(await latestOf('@x/a', { fetch: answering(() => ({ status: 404, ok: false })) }), null);
});

// A 404 is the only answer that means "new name"; reading anything else as one would publish under latest.
test('NEGATIVE: a registry that will not say what latest is throws rather than answering null', async () => {
	await assert.rejects(latestOf('@x/a', { fetch: answering(() => ({ status: 503, ok: false })) }), /answered 503/);
	await assert.rejects(
		latestOf('@x/a', {
			fetch: answering(() => {
				throw new Error('ETIMEDOUT');
			}),
		}),
		/ETIMEDOUT/
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

// Unconfirmed is a wait, not a failure: npm accepted every publish, and nothing after this asks again.
test('an unconfirmed read-back names what to repeat, and claims no failure', () => {
	const line = readBackLine(['@x/a-probe-macos-arm64'], '9.9.9');
	assert.match(line, /@x\/a-probe-macos-arm64/, 'the operator cannot act on a warning that names nothing');
	assert.match(line, /npm accepted every publish/, 'it must say the release itself is not in doubt');
	assert.match(line, /npm view <name>@9\.9\.9 version/, 'the operator needs the question to ask again');
	assert.doesNotMatch(line, /latest/);
	assert.doesNotMatch(line, /fail(ed|ure)\b(?!s if)/i, 'nothing here is a failure yet');
});

test('a confirmed read-back claims nothing is missing', () => {
	const line = readBackLine([], '9.9.15');
	assert.equal(line, 'every package of 9.9.15 is on the registry');
	assert.doesNotMatch(line, /not served|absent|yet/);
});

// Only the ceiling separates a slow read from an absent package, so a lower default is a regression.
test('the read-back waits half an hour before it gives up', async () => {
	const clock = fakeClock();
	const { fetch } = registry(['@x/a']);
	await confirmPublished({ names: ['@x/a'], version: '1.0.0', fetch, ...clock });
	assert.equal(clock.now(), 30 * 60_000, 'the default ceiling moved');
});
