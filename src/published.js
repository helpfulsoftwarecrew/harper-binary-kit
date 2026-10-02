// @ts-check
// Asked at `/<name>/<version>`, never the packument, an aggregate that can lag its own writes.

const REGISTRY = 'https://registry.npmjs.org';

/** The registry path for one version, scope encoded the way the registry wants it. @param {string} name @param {string} version */
export const versionUrl = (name, version, registry = REGISTRY) =>
	`${registry}/${name.replace('/', '%2F')}/${encodeURIComponent(version)}`;

/**
 * Whether the registry serves this exact version. A 404 is the honest negative; anything else is "could not
 * tell", because telling somebody to republish what is already there is worse than saying nothing.
 *
 * @param {string} name @param {string} version
 * @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [options]
 * @returns {Promise<{ published: boolean, detail: string }>}
 */
export async function isPublished(name, version, { fetch: get = globalThis.fetch, registry = REGISTRY } = {}) {
	let response;
	try {
		response = await get(versionUrl(name, version, registry), { headers: { accept: 'application/json' } });
	} catch (error) {
		return {
			published: false,
			detail: `could not reach the registry: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (response.status === 404) return { published: false, detail: `the registry has no ${name}@${version}` };
	if (!response.ok)
		return { published: false, detail: `the registry answered ${response.status} for ${name}@${version}` };
	try {
		const body = /** @type {{ name?: string, version?: string }} */ (await response.json());
		if (body.name === name && body.version === version)
			return { published: true, detail: `${name}@${version} is on the registry` };
		return {
			published: false,
			detail: `the registry answered with ${body.name}@${body.version} for ${name}@${version}`,
		};
	} catch (error) {
		return {
			published: false,
			detail: `the registry's answer for ${name}@${version} did not parse: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** The abbreviated packument, which carries the dist-tags. @param {string} name */
export const packumentUrl = (name, registry = REGISTRY) => `${registry}/${name.replace('/', '%2F')}`;

/**
 * What `latest` names now, or null for a name the registry has never published. Anything but a 404 or a parsed
 * answer throws, since a guessed `latest` could hand a patch to an older line to every bare `npm install`.
 *
 * @param {string} name @param {{ fetch?: typeof globalThis.fetch, registry?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function latestOf(name, { fetch: get = globalThis.fetch, registry = REGISTRY } = {}) {
	const response = await get(packumentUrl(name, registry), {
		headers: { accept: 'application/vnd.npm.install-v1+json' },
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`the registry answered ${response.status} for ${name}`);
	const body = /** @type {{ 'dist-tags'?: { latest?: unknown } }} */ (await response.json());
	const latest = body['dist-tags']?.latest;
	return typeof latest === 'string' ? latest : null;
}

/**
 * Asks again until every package appears or the deadline passes, since only waiting separates a slow read
 * from an absent package, and a package that never published never appears.
 *
 * @param {object} options
 * @param {readonly string[]} options.names @param {string} options.version
 * @param {typeof globalThis.fetch} [options.fetch] @param {string} [options.registry]
 * @param {number} [options.timeoutMs] How long to keep asking. @param {number} [options.intervalMs]
 * @param {(ms: number) => Promise<void>} [options.wait] @param {() => number} [options.now]
 * @returns {Promise<{ ok: boolean, missing: string[], lines: string[] }>}
 */
export async function confirmPublished({
	names,
	version,
	fetch: get,
	registry,
	timeoutMs = 30 * 60_000,
	intervalMs = 15_000,
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = Date.now,
}) {
	const options = { ...(get ? { fetch: get } : {}), ...(registry ? { registry } : {}) };
	const deadline = now() + timeoutMs;
	const lines = [];
	let pending = [...names];
	let last = new Map();

	for (;;) {
		const stillMissing = [];
		for (const name of pending) {
			const { published, detail } = await isPublished(name, version, options);
			last.set(name, detail);
			if (!published) stillMissing.push(name);
		}
		pending = stillMissing;
		if (pending.length === 0 || now() >= deadline) break;
		lines.push(`waiting for the registry to serve ${pending.length} package(s): ${pending.join(', ')}`);
		await wait(intervalMs);
	}

	for (const name of names) lines.push(String(last.get(name)));
	return { ok: pending.length === 0, missing: pending, lines };
}

/**
 * Unconfirmed is not a failure: npm accepted every publish by now, and a GET from a CDN edge can lag that.
 *
 * @param {readonly string[]} missing @param {string} version
 * @returns {string}
 */
export function readBackLine(missing, version) {
	if (missing.length === 0) return `every package of ${version} is on the registry`;
	return (
		`the registry has not served ${missing.join(', ')} at ${version} yet, though npm accepted every publish. ` +
		`Repeat \`npm view <name>@${version} version\` for each of these once the registry catches up.`
	);
}
