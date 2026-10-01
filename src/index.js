/**
 * temp-script-guard — the `temp-script-manager` skill turned into enforcement.
 *
 * A skill can only *ask* the model to keep throwaway scripts out of the
 * project. This plugin makes it happen: a `tools/pre-execute` guard refuses a
 * `write`/`edit` whose target looks like a scratch script and lives outside the
 * managed directory, and points the caller at `temp_script_save` instead. The
 * four `temp_script_*` tools own the lifecycle the skill used to describe:
 * timestamped creation, listing with ages, purging, and promoting a script that
 * turned out to be worth keeping.
 *
 * Contract references (Host Inspect):
 *   - `ctx.tools.register(definition)` / `ctx.tools.guard(guard)`
 *   - `ToolDefinition.execute(args, exec)` + `output.render(args, value)`
 *   - `ToolGuard = (exec) => string | undefined` — a returned string denies.
 *
 * @module dsh-temp-script-guard
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';

export const name = 'temp-script-guard';

/**
 * Only the tool registry is required. Everything else this plugin touches is a
 * Node built-in, so there is nothing here that could leave the composition
 * pending on a service the profile does not mount.
 */
export const inject = ['tools'];

/** Extensions that make a file a *script* rather than a document. */
export const SCRIPT_EXTENSIONS = new Set([
	'.awk', '.bash', '.bat', '.cjs', '.cmd', '.fish', '.go', '.jl', '.js', '.lua', '.mjs',
	'.php', '.pl', '.ps1', '.psm1', '.py', '.r', '.rb', '.rs', '.sed', '.sh', '.sql',
	'.ts', '.vbs', '.zsh'
]);

/**
 * A segment of the stem that means "throwaway". Deliberately anchored on
 * separators so `attempt.py` and `template.py` are not matches — only
 * `tmp_x`, `x-temp`, `scratch.y`, `one-off` and friends are.
 */
export const TEMP_NAME_HINT = /(^|[-_. ])(tmp|temp|temps|scratch|throwaway|adhoc|ad-hoc|oneoff|one-off|wip|sandbox|junk|misc)([-_. ]|$)/i;

/** Directories whose contents are never the model's scratch space. */
export const EXCLUDED_DIR_NAMES = [
	'.cache', '.git', '.next', '.venv', '.vscode', 'build', 'dist', 'node_modules', 'out', 'target', 'venv'
];

/** Tools whose `file_path` argument this guard inspects. */
export const GUARDED_TOOLS = new Set(['write', 'edit']);

export const DEFAULTS = {
	/** Where temp scripts belong. `~` is expanded. */
	managedDir: '~/tools/temp-scripts',
	/** Where a promoted script goes, dropping its timestamp prefix. */
	toolsDir: '~/tools',
	/** Age at which a temp script counts as expired. */
	olderThanDays: 7,
	/** `deny` refuses the write; `off` only registers the tools. */
	mode: 'deny',
	/** Extra directory-name segments to leave alone, on top of EXCLUDED_DIR_NAMES. */
	excludedDirs: []
};

/** Expand a leading `~` and normalise to an absolute path. */
export function expandHome(value) {
	const text = String(value ?? '').trim();
	if (text === '') return '';
	if (text === '~') return homedir();
	if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2));
	return text;
}

/** Case-folded absolute path, so Windows comparisons cannot miss a match. */
export function normalizePath(value) {
	const absolute = resolve(expandHome(value));
	return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Whether `candidate` is `parent` or lives underneath it. */
export function isInside(candidate, parent) {
	const child = normalizePath(candidate);
	const root = normalizePath(parent);
	if (root === '') return false;
	if (child === root) return true;
	return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Turn configured values into the resolved shape the rest of the module uses. */
export function resolveConfig(config) {
	const raw = config !== null && typeof config === 'object' ? config : {};
	const mode = raw.mode === 'off' ? 'off' : 'deny';
	const days = Number(raw.olderThanDays);
	const managedDir = expandHome(
		typeof raw.managedDir === 'string' && raw.managedDir.trim() !== '' ? raw.managedDir : DEFAULTS.managedDir
	);
	const toolsDir = expandHome(
		typeof raw.toolsDir === 'string' && raw.toolsDir.trim() !== '' ? raw.toolsDir : DEFAULTS.toolsDir
	);
	const extra = Array.isArray(raw.excludedDirs)
		? raw.excludedDirs.filter((entry) => typeof entry === 'string' && entry !== '')
		: [];
	return {
		mode,
		managedDir: resolve(managedDir),
		toolsDir: resolve(toolsDir),
		olderThanDays: Number.isFinite(days) && days >= 0 ? days : DEFAULTS.olderThanDays,
		excludedDirs: [...EXCLUDED_DIR_NAMES, ...extra].map((entry) => entry.toLowerCase())
	};
}

/**
 * Decide whether one write target is a scratch script that belongs in the
 * managed directory.
 *
 * Returns `{ allowed: true }` or `{ allowed: false, reason }`; `reason` is the
 * denial message the model reads, so it names the tool call that fixes it.
 */
export function classifyWriteTarget(rawPath, config) {
	const cfg = resolveConfig(config);
	const text = typeof rawPath === 'string' ? rawPath.trim() : '';
	if (text === '') return { allowed: true, skipped: 'no-path' };

	const target = resolve(expandHome(text));

	// Inside the managed directory: this is exactly where it should go.
	if (isInside(target, cfg.managedDir)) return { allowed: true, skipped: 'managed' };

	// The OS temp directory is a legitimate scratch space of its own.
	if (isInside(target, tmpdir())) return { allowed: true, skipped: 'os-temp' };

	// Dependency, VCS and build output trees are not the model's scratch space.
	const segments = normalizePath(target).split(sep).filter(Boolean);
	if (segments.some((segment) => cfg.excludedDirs.includes(segment))) {
		return { allowed: true, skipped: 'excluded-dir' };
	}

	const stem = basename(target, extname(target));
	if (!SCRIPT_EXTENSIONS.has(extname(target).toLowerCase())) return { allowed: true, skipped: 'not-a-script' };
	if (!TEMP_NAME_HINT.test(stem)) return { allowed: true, skipped: 'not-temp-named' };

	const relativeHint = isAbsolute(text) ? target : text;
	return {
		allowed: false,
		target,
		relativeHint,
		reason:
			`Refused: "${relativeHint}" reads as a throwaway script, and temp scripts must live in ${cfg.managedDir} ` +
			`(temp-script-manager rule). Call temp_script_save({ name, content }) instead — it creates the directory, ` +
			`prefixes the timestamp, and returns the real path. If this file is genuinely permanent, name it for what it ` +
			`does (no tmp/temp/scratch token) or pass mode: "off" in the temp-script-guard config.`
	};
}

/** `YYYYMMDD-HHMMSS` in local time. */
export function timestampPrefix(now = new Date()) {
	const pad = (value) => String(value).padStart(2, '0');
	return (
		`${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
		`-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
	);
}

/**
 * Build the file name for a new temp script: `YYYYMMDD-HHMMSS_slug.ext`.
 *
 * `name` may carry the extension itself; `extension` only fills the gap when it
 * does not, so there is never a doubled `.py.py`.
 */
export function scriptFileName(input, now = new Date()) {
	const rawName = typeof input?.name === 'string' ? input.name.trim() : '';
	if (rawName === '') throw new Error('temp_script_save requires a non-empty name');
	const extension = normalizeExtension(input?.extension);
	const base = basename(rawName).replace(/[\\/:*?"<>|]/g, '_');
	const hasExtension = extname(base) !== '';
	const stem = hasExtension ? base.slice(0, -extname(base).length) : base;
	const slug = stem.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'script';
	const suffix = hasExtension ? extname(base).toLowerCase() : extension;
	return `${timestampPrefix(now)}_${slug}${suffix}`;
}

function normalizeExtension(value) {
	if (typeof value !== 'string' || value.trim() === '') return '';
	const text = value.trim().toLowerCase();
	return text.startsWith('.') ? text : `.${text}`;
}

/** Age in whole days, floored, never negative. */
export function ageInDays(mtimeMs, now = Date.now()) {
	return Math.max(0, Math.floor((now - mtimeMs) / 86_400_000));
}

/** List the managed directory, newest first. Missing directory reads as empty. */
export async function listManagedScripts(config, now = Date.now()) {
	const cfg = resolveConfig(config);
	let entries = [];
	try {
		entries = await readdir(cfg.managedDir, { withFileTypes: true });
	} catch {
		return { config: cfg, scripts: [], totalBytes: 0, expiredCount: 0 };
	}
	const scripts = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = join(cfg.managedDir, entry.name);
		let info;
		try {
			info = await stat(path);
		} catch {
			continue;
		}
		const ageDays = ageInDays(info.mtimeMs, now);
		scripts.push({
			name: entry.name,
			path,
			bytes: info.size,
			modifiedAt: new Date(info.mtimeMs).toISOString(),
			ageDays,
			expired: ageDays >= cfg.olderThanDays
		});
	}
	scripts.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
	return {
		config: cfg,
		scripts,
		totalBytes: scripts.reduce((sum, script) => sum + script.bytes, 0),
		expiredCount: scripts.filter((script) => script.expired).length
	};
}

/** Unique destination inside `dir`, so a same-second save never overwrites. */
async function uniquePath(dir, fileName) {
	const extension = extname(fileName);
	const stem = fileName.slice(0, fileName.length - extension.length);
	let candidate = join(dir, fileName);
	let counter = 1;
	while (existsSync(candidate)) {
		counter += 1;
		candidate = join(dir, `${stem}-${counter}${extension}`);
	}
	return candidate;
}

/** Plain-object JSON schema helper, kept small on purpose. */
const objectSchema = (properties, required = []) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false
});

const stringSchema = (description) => ({ type: 'string', description });
const numberSchema = (description) => ({ type: 'number', description });
const booleanSchema = (description) => ({ type: 'boolean', description });

/** One text block — the model-facing half of a tool result. */
const textBlock = (text) => [{ type: 'text', text }];

const saveOutputSchema = objectSchema(
	{
		path: stringSchema('Absolute path of the script that was written.'),
		name: stringSchema('File name inside the managed directory.'),
		bytes: numberSchema('Bytes written.'),
		managedDir: stringSchema('The managed temp-script directory.')
	},
	['path', 'name', 'bytes', 'managedDir']
);

const listOutputSchema = objectSchema(
	{
		managedDir: stringSchema('The managed temp-script directory.'),
		count: numberSchema('How many scripts are present.'),
		totalBytes: numberSchema('Total size of those scripts.'),
		expiredCount: numberSchema('How many are at or past the expiry age.'),
		olderThanDays: numberSchema('The configured expiry age.'),
		scripts: {
			type: 'array',
			description: 'Newest first.',
			items: objectSchema(
				{
					name: stringSchema('File name.'),
					path: stringSchema('Absolute path.'),
					bytes: numberSchema('Size in bytes.'),
					modifiedAt: stringSchema('ISO timestamp of the last write.'),
					ageDays: numberSchema('Whole days since the last write.'),
					expired: booleanSchema('At or past the expiry age.')
				},
				['name', 'path', 'bytes', 'modifiedAt', 'ageDays', 'expired']
			)
		}
	},
	['managedDir', 'count', 'totalBytes', 'expiredCount', 'olderThanDays', 'scripts']
);

const purgeOutputSchema = objectSchema(
	{
		managedDir: stringSchema('The managed temp-script directory.'),
		dryRun: booleanSchema('True when nothing was deleted.'),
		olderThanDays: numberSchema('The expiry age applied.'),
		removed: { type: 'array', description: 'Absolute paths deleted (or that would be).', items: { type: 'string' } },
		freedBytes: numberSchema('Bytes reclaimed, or that would be.')
	},
	['managedDir', 'dryRun', 'olderThanDays', 'removed', 'freedBytes']
);

const promoteOutputSchema = objectSchema(
	{
		from: stringSchema('The temp-script path it moved from.'),
		to: stringSchema('The permanent path it now occupies.'),
		bytes: numberSchema('Bytes moved.')
	},
	['from', 'to', 'bytes']
);

const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Register every tool and the guard. Returns one disposer for all of them. */
function install(ctx, config) {
	const disposers = [];
	const cfg = resolveConfig(config);
	const log = (...args) => {
		try {
			ctx.logger?.info?.(...args);
		} catch {
			// Logging is never worth a failed tool call.
		}
	};

	disposers.push(
		ctx.tools.register({
			name: 'temp_script_save',
			description:
				'Write a throwaway script into the managed temp-script directory with a timestamped file name. ' +
				'Use this instead of `write` for any one-off, scratch or debugging script, so the project tree stays clean.',
			parameters: objectSchema(
				{
					name: stringSchema('What the script does, e.g. "fix_metadata" or "parse_log.py". Include the extension to choose it.'),
					content: stringSchema('Full script contents.'),
					extension: stringSchema('Extension when `name` has none, e.g. "py" or ".ps1".')
				},
				['name', 'content']
			),
			output: {
				schema: saveOutputSchema,
				render: (_args, value) => textBlock(`Saved ${value.name} (${formatBytes(value.bytes)}) -> ${value.path}`)
			},
			async execute(args) {
				const input = args && typeof args === 'object' ? args : {};
				if (typeof input.content !== 'string') throw new Error('temp_script_save requires content as a string');
				const fileName = scriptFileName(input);
				await mkdir(cfg.managedDir, { recursive: true });
				const path = await uniquePath(cfg.managedDir, fileName);
				await writeFile(path, input.content, 'utf8');
				log(`saved ${path}`);
				return { path, name: basename(path), bytes: Buffer.byteLength(input.content, 'utf8'), managedDir: cfg.managedDir };
			}
		})
	);

	disposers.push(
		ctx.tools.register({
			name: 'temp_script_list',
			description:
				'List the scripts in the managed temp-script directory, newest first, with each one\'s age and whether it is ' +
				'past the expiry age. Use it before starting throwaway work to reuse a script, or to report what needs cleanup.',
			parameters: objectSchema({}),
			output: {
				schema: listOutputSchema,
				render: (_args, value) => {
					if (value.count === 0) return textBlock(`${value.managedDir} is empty.`);
					const lines = value.scripts.map(
						(script) =>
							`${script.expired ? '[expired]' : '         '} ${script.name}  ${formatBytes(script.bytes)}  ${script.ageDays}d`
					);
					return textBlock(
						`${value.count} script(s) in ${value.managedDir} (${formatBytes(value.totalBytes)}), ` +
							`${value.expiredCount} past ${value.olderThanDays}d:\n${lines.join('\n')}`
					);
				}
			},
			async execute() {
				const listing = await listManagedScripts(cfg);
				return {
					managedDir: listing.config.managedDir,
					count: listing.scripts.length,
					totalBytes: listing.totalBytes,
					expiredCount: listing.expiredCount,
					olderThanDays: listing.config.olderThanDays,
					scripts: listing.scripts
				};
			}
		})
	);

	disposers.push(
		ctx.tools.register({
			name: 'temp_script_purge',
			description:
				'Delete temp scripts that are at or past the expiry age. Defaults to a dry run: pass dryRun: false to actually ' +
				'delete. Never touches anything outside the managed directory.',
			parameters: objectSchema({
				olderThanDays: numberSchema('Expiry age to apply instead of the configured one.'),
				dryRun: booleanSchema('Defaults to true; set false to delete.')
			}),
			output: {
				schema: purgeOutputSchema,
				render: (_args, value) => {
					const verb = value.dryRun ? 'Would remove' : 'Removed';
					if (value.removed.length === 0) {
						return textBlock(`Nothing past ${value.olderThanDays}d in ${value.managedDir}.`);
					}
					return textBlock(
						`${verb} ${value.removed.length} script(s), ${formatBytes(value.freedBytes)}:\n${value.removed.join('\n')}`
					);
				}
			},
			async execute(args) {
				const input = args && typeof args === 'object' ? args : {};
				const days = Number(input.olderThanDays);
				const purgeConfig = {
					...cfg,
					olderThanDays: Number.isFinite(days) && days >= 0 ? days : cfg.olderThanDays
				};
				const listing = await listManagedScripts(purgeConfig);
				const doomed = listing.scripts.filter((script) => script.expired);
				const dryRun = input.dryRun !== false;
				const removed = [];
				let freedBytes = 0;
				for (const script of doomed) {
					if (!isInside(script.path, purgeConfig.managedDir)) continue;
					if (!dryRun) await rm(script.path, { force: true });
					removed.push(script.path);
					freedBytes += script.bytes;
				}
				if (!dryRun) log(`purged ${removed.length} temp script(s)`);
				return {
					managedDir: purgeConfig.managedDir,
					dryRun,
					olderThanDays: purgeConfig.olderThanDays,
					removed,
					freedBytes
				};
			}
		})
	);

	disposers.push(
		ctx.tools.register({
			name: 'temp_script_promote',
			description:
				'Move a temp script that turned out to be worth keeping out of the managed directory into the tools directory, ' +
				'dropping the timestamp prefix. Use it when the user wants to keep a script long-term.',
			parameters: objectSchema(
				{
					path: stringSchema('Path of the script, as returned by temp_script_save or temp_script_list.'),
					name: stringSchema('New file name in the tools directory; defaults to the temp name without its timestamp prefix.')
				},
				['path']
			),
			output: {
				schema: promoteOutputSchema,
				render: (_args, value) => textBlock(`Promoted to ${value.to} (${formatBytes(value.bytes)})`)
			},
			async execute(args) {
				const input = args && typeof args === 'object' ? args : {};
				if (typeof input.path !== 'string' || input.path.trim() === '') {
					throw new Error('temp_script_promote requires path');
				}
				const from = resolve(expandHome(input.path));
				if (!isInside(from, cfg.managedDir)) {
					throw new Error(`temp_script_promote only moves files inside ${cfg.managedDir}`);
				}
				const defaultName = basename(from).replace(/^\d{8}-\d{6}_/, '');
				const target = join(cfg.toolsDir, basename(input.name?.trim() || defaultName));
				await mkdir(cfg.toolsDir, { recursive: true });
				const info = await stat(from);
				await rename(from, target);
				log(`promoted ${from} -> ${target}`);
				return { from, to: target, bytes: info.size };
			}
		})
	);

	// The enforcement half. `guard` is a synchronous check whose returned string
	// denies the dispatch, so a throw here would be a policy failure, not a
	// result — every branch is defensive.
	if (cfg.mode === 'deny') {
		disposers.push(
			ctx.tools.guard((exec) => {
				try {
					if (!GUARDED_TOOLS.has(exec?.name)) return undefined;
					const args = exec?.arguments;
					if (args === null || typeof args !== 'object') return undefined;
					const verdict = classifyWriteTarget(args.file_path, cfg);
					return verdict.allowed ? undefined : verdict.reason;
				} catch {
					return undefined;
				}
			})
		);
	}

	log(`temp-script-guard active (mode=${cfg.mode}, dir=${cfg.managedDir})`);

	return () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose();
			} catch {
				// A disposer that throws must not stop the rest of teardown.
			}
		}
	};
}

/** Cordis entry point. */
export function apply(ctx, config) {
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => install(ctx, config));
		return;
	}
	install(ctx, config);
}

// Re-exported so a test (or a reader) can exercise the policy without Cordis.
export { readFile };
