#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Summarize the sanitizer reports in a log directory.
 *
 * The sanitized programs run with `log_path=<dir>/<prefix>`, so every process
 * that reports writes `<prefix>.<pid>` there. This script splits each file into
 * AddressSanitizer, LeakSanitizer and UndefinedBehaviorSanitizer reports,
 * groups equal reports, and writes a Markdown summary to $GITHUB_STEP_SUMMARY
 * (to stdout when it is not set).
 *
 * Reports of the same sanitizer and kind at the same location form one group.
 * The location is the one the report names itself when that is in our code
 * (OWN_CODE_DIRS), else the first frame in our code of the stack where the error
 * happened, else the first frame outside the sanitizer runtime. The binary's
 * name is never part of it.
 *
 * Only the entries of KNOWN_THIRD_PARTY do not fail the job; every other report
 * fails it, wherever its stack stops. An entry matches a complete
 * AddressSanitizer report by its header, plus the function and the library of
 * the first frame outside the sanitizer runtime in the freeing stack and in the
 * `allocated by` stack. All reports of an entry form one group, listed with the
 * entry's reason and link. An entry that matched no report is named in a note.
 * A report block ends at its `SUMMARY:` line; any other output after it is
 * reported on its own, so a known report never excuses what follows it.
 *
 * Usage: node scripts/ci/sanitizer-report.mjs <log dir>
 *
 * Exits 0 when there is no report or every report is known third-party, 1 when
 * there is any other report, and 2 on a usage error or when the directory does
 * not exist. A file that holds only sanitizer warnings gives reports of kind
 * `warning`. A file with any other output but no recognizable report counts as
 * one report of kind `other-output`, so a truncated report or a sanitizer's own
 * failure is never dropped. Both kinds count like errors.
 */

import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** GitHub does not show a step summary over 1 MiB (the limit is per step); this keeps a margin below it. */
const SUMMARY_LIMIT = 900 * 1024;
/** Bytes of the summary kept free for the closing note on what did not fit. */
const NOTE_ROOM = 512;
const EXAMPLE_LINES = 12;
const MAX_LINE_LENGTH = 300;
/** Where our own sources live, relative to the checkout root. */
const OWN_CODE_DIRS = ['packages/server/', 'nodes/src/'];
/**
 * Allocator and interceptor functions of the sanitizer runtime. Without line
 * tables their frames have no compiler-rt path, only the name.
 */
const RUNTIME_FUNCTIONS = (
	'malloc calloc realloc reallocarray free aligned_alloc posix_memalign memalign valloc pvalloc malloc_usable_size ' +
	'memmove memcpy memset memcmp memchr bcmp bzero ' +
	'strlen strnlen wcslen strcpy strncpy stpcpy strcat strncat strcmp strncmp strcasecmp strncasecmp ' +
	'strchr strrchr strstr strspn strcspn strpbrk strdup strndup'
).split(' ');

const KNOWN_ISSUE = 'https://github.com/rocketride-org/rocketride-server/issues/3338';
/**
 * Third-party errors that do not fail the job. A report matches an entry when
 * it is a complete AddressSanitizer report whose header contains `header`, the
 * first frame outside the sanitizer runtime in the freeing stack matches
 * `freedBy`, and the same frame of the `allocated by` stack matches `allocatedBy`.
 * A frame is matched as one normalized line, `in <function> (<module path>)`,
 * without offsets or build ids, so a pattern tests the function and the library.
 */
export const KNOWN_THIRD_PARTY = [
	{
		id: 'libcxxabi-exception-free',
		sanitizer: 'AddressSanitizer',
		header: 'alloc-dealloc-mismatch (operator new vs free)',
		// A std exception destructor; they share one address, so the symbolizer may name any of them
		freedBy: /^in std::(?:__1::)?\w+::~\w+\(\) \((?:[^()]*\/)?libc\+\+abi\.so[\d.]*\)$/,
		// The constructor that allocates the message of a std::runtime_error or std::logic_error
		allocatedBy:
			/^in std::(?:__1::)?(?:(?:runtime|logic)_error::(?:runtime|logic)_error\(|__libcpp_refstring::).* \((?:[^()]*\/)?libc\+\+\.so[\d.]*\)$/,
		reason:
			'libc++abi frees the message of a caught exception with its own free, ' +
			'but the message came from the ASan operator new; ASan of clang 18 cannot suppress it by stack.',
		link: KNOWN_ISSUE,
	},
];

const ERROR_RE = /^==\d+==ERROR: (\w*Sanitizer)(?::| )\s*(.*)$/;
const WARNING_RE = /^==\d+==WARNING: (.*)$/;
const PID_LINE_RE = /^==\d+==/;
const UBSAN_RE = /^(?:(.*?): )?runtime error: (.*)$/;
const SUMMARY_RE = /^SUMMARY: (\w*Sanitizer): (\S+)(.*)$/;
const FRAME_RE = /^\s*#\d+ 0x[0-9a-f]+ (.*)$/;
// The module a frame is in, with the offset into it: ` (/x/dist/server/engtest+0x2701032)`
const MODULE_RE = /\s*\(([^()]*)\+0x[0-9a-f]+\)/g;
const ALLOCATED_RE = /^allocated by thread T\d+ here:/;
// What a sanitizer prints around a report, outside its block: the rest of a fatal report and the next one's lead-in
const EPILOGUE_RE =
	/^\s*$|^=+$|^==\d+==(?:HINT|ABORTING)|^Shadow byte|^(?:=>| {2})0x[0-9a-f]+:|^ {2}[A-Z][A-Za-z ]*:\s+[0-9a-f]{2}/;
// `Thread T5 created by T0 here:`, which ASan prints after the report of a crash, then the frames of the creator
const THREAD_RE = /^Thread T\d+\b.*(?:here:|unknown thread)$/;
const DEADLY_SIGNAL_RE = /^\w*Sanitizer:DEADLYSIGNAL/;
// `in <function> <file:line>`, the order of a frame; the file is optional
const FRAME_PLACE_RE = /^in (.+?)(?: (\S+:\d+(?::\d+)?))?$/;
// Frames in the sanitizer runtime, by its path or its internal function names
const RUNTIME_PATH_RE = /compiler-rt\/|libclang_rt\.|\bin _{2,3}(?:interceptor|asan|lsan|ubsan|sanitizer)(?:_|::)/;
const RUNTIME_NAME_RE = new RegExp(
	`(?:^|\\s)in (?:operator (?:new|delete)(?:\\[\\])?\\(|(?:${RUNTIME_FUNCTIONS.join('|')})(?:\\s|$))`
);

/**
 * Remove what differs between two runs of the same error: pids, addresses,
 * offsets into a binary, build ids, `./` and `dir/../` in paths, and the
 * checkout root.
 */
export function normalize(text, root = '') {
	let result = text
		.replace(/ ?\(BuildId: [0-9a-f]+\)/g, '')
		.replace(/\+0x[0-9a-f]+\)/g, ')')
		.replace(/==\d+==/g, '')
		.replace(/0x[0-9a-f]+/g, '<addr>')
		.replace(/\s+/g, ' ')
		.replace(/\/(?:\.\/)+/g, '/')
		.trim();
	// Drop `dir/../` until none is left, so `a/b/../../c` becomes `c`
	let previous;
	do {
		previous = result;
		result = result.replace(/(^|[\s(/])(?!\.\.\/)[^\s()/]+\/\.\.\//g, '$1');
	} while (result !== previous);
	if (root) result = result.replaceAll(`${root.replace(/\/+$/, '')}/`, '');
	return result;
}

/**
 * A frame or summary location as `<file:line> in <function>`, normalized and
 * without the binary's name; '' when it names neither a file nor a function.
 */
function place(text, root) {
	const clean = normalize(text.replace(MODULE_RE, ''), root);
	const frame = clean.match(FRAME_PLACE_RE);
	return frame?.[2] ? `${frame[2]} in ${frame[1]}` : clean;
}

/** True when the file of a location is in our own code. */
function isOwnCode(location) {
	const file = location.startsWith('in ') ? '' : location.split(' ')[0];
	return OWN_CODE_DIRS.some((dir) => file.startsWith(dir) || file.includes(`/${dir}`));
}

function isRuntime(text) {
	return RUNTIME_PATH_RE.test(text) || RUNTIME_NAME_RE.test(text);
}

/** The first frame outside the sanitizer runtime as a line `in <function> (<module path>)`; '' when none. */
function leadFrame(stack) {
	const frame = stack.find((line) => !isRuntime(line));
	return frame ? normalize(frame) : '';
}

/** The KNOWN_THIRD_PARTY entry a complete report matches, or null. */
function matchKnown(sanitizer, header, freed, allocated) {
	return (
		KNOWN_THIRD_PARTY.find(
			(entry) =>
				entry.sanitizer === sanitizer &&
				header.includes(entry.header) &&
				entry.freedBy.test(freed) &&
				entry.allocatedBy.test(allocated)
		)?.id ?? null
	);
}

/** The frames of the stack that starts at the first line from `start` on that is a frame. */
function framesFrom(lines, start) {
	if (start < 0) return [];
	const first = lines.findIndex((line, index) => index >= start && FRAME_RE.test(line));
	if (first < 0) return [];
	const frames = [];
	for (const line of lines.slice(first)) {
		const frame = line.match(FRAME_RE);
		if (!frame) break;
		frames.push(frame[1]);
	}
	return frames;
}

/**
 * The location of a report. `named` is the location the report names itself
 * (its summary line, or a UBSan error's first line); `stack` holds the frames
 * where the error happened.
 */
function locate(named, stack, root) {
	const namedPlace = place(named, root);
	if (isOwnCode(namedPlace)) return namedPlace;
	const frames = stack.map((frame) => ({ frame, location: place(frame, root) }));
	const own = frames.find(({ location }) => isOwnCode(location));
	if (own) return own.location;
	if (namedPlace && !isRuntime(named)) return namedPlace;
	return frames.find(({ frame, location }) => location && !isRuntime(frame))?.location ?? namedPlace;
}

/** The first lines of a report, for the example in the summary. */
function excerpt(lines) {
	const head = lines.slice(0, EXAMPLE_LINES).map((line) => {
		const trimmed = line.trimEnd();
		return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH)}...` : trimmed;
	});
	while (head.length && !head.at(-1)) head.pop();
	return head;
}

/** Turn the lines of one report into its sanitizer, kind, known entry and location. */
function toReport({ error, lines }, file, root) {
	const summary = lines.map((line) => line.match(SUMMARY_RE)).find(Boolean);
	const stack = framesFrom(lines, 0);
	const finish = (sanitizer, kind, named, header) => {
		const freed = leadFrame(stack);
		const allocated = leadFrame(framesFrom(lines, lines.findIndex((line) => ALLOCATED_RE.test(line))));
		// Only a block that reached its SUMMARY line is complete enough to match
		const known = summary ? matchKnown(sanitizer, header, freed, allocated) : null;
		return {
			file,
			lines: excerpt(lines),
			sanitizer,
			kind,
			known,
			location: known ?? locate(named, stack, root),
		};
	};
	if (!error) {
		const named = summary ? summary[3] : (lines[0].match(UBSAN_RE)[1] ?? '');
		return finish('UndefinedBehaviorSanitizer', summary ? summary[2] : 'runtime-error', named, lines[0]);
	}
	const sanitizer = error[1];
	// A leak summary only counts bytes, so the allocating frame tells leaks apart
	if (sanitizer === 'LeakSanitizer') return finish(sanitizer, 'memory-leak', '', error[2]);
	const kind = summary ? summary[2] : error[2].split(' ')[0];
	return finish(sanitizer, kind, summary ? summary[3] : '', error[2]);
}

/** A report for output that is not a sanitizer error: a warning or other output. */
function unknownReport(kind, lines, location, file) {
	return { file, lines: excerpt(lines), sanitizer: 'unknown', kind, known: null, location };
}

/**
 * The reports in output that holds sanitizer warnings and nothing else, one
 * per `==PID==WARNING:` line with the lines after it; null for any other output.
 */
function warningReports(lines, file, root) {
	if (!WARNING_RE.test(lines[0] ?? '')) return null;
	if (lines.some((line) => PID_LINE_RE.test(line) && !WARNING_RE.test(line))) return null;
	const blocks = [];
	for (const line of lines) {
		if (WARNING_RE.test(line)) blocks.push([line]);
		else blocks.at(-1).push(line);
	}
	// Sizes and descriptors in a warning differ between processes
	return blocks.map((block) =>
		unknownReport('warning', block, normalize(block[0].match(WARNING_RE)[1], root).replace(/\b\d+\b/g, '<n>'), file)
	);
}

/**
 * Split the text of one log file into reports.
 *
 * A report starts at an `==PID==ERROR: <Name>Sanitizer` line or at a
 * `<location>: runtime error:` line and ends at its `SUMMARY:` line, or at the
 * next report when it has none. Other output outside a report, apart from what
 * a sanitizer prints around one, is one more report.
 */
export function parseLog(text, file, root = '') {
	const blocks = [];
	const loose = [];
	let open = null;
	let trailer = false;
	for (const line of text.split(/\r?\n/)) {
		const error = line.match(ERROR_RE);
		const inTrailer = trailer;
		trailer = false;
		if (error || UBSAN_RE.test(line)) {
			open = { error, lines: [line] };
			blocks.push(open);
		} else if (open) {
			open.lines.push(line);
			if (SUMMARY_RE.test(line)) open = null;
		} else if (blocks.length && (THREAD_RE.test(line) || (inTrailer && FRAME_RE.test(line)))) {
			// Epilogue: the thread trailer of the report before it; with no report before it, it fails as other output
			trailer = true;
		} else if (!EPILOGUE_RE.test(line)) {
			loose.push(line);
		}
	}
	const reports = blocks.map((block) => toReport(block, file, root));
	// The lead-in of a fatal signal belongs to the failing report that follows it; next to only known
	// reports, or alone, it is a crash whose report never came, so it stays and fails
	const failing = reports.some((report) => !report.known);
	const other = failing ? loose.filter((line) => !DEADLY_SIGNAL_RE.test(line)) : loose;
	if (other.length) {
		const single = unknownReport('other-output', other, normalize(other[0], root), file);
		reports.push(...(warningReports(other, file, root) ?? [single]));
	}
	return reports;
}

/**
 * Group reports by sanitizer, kind and location; the largest groups
 * come first. The location of a known report is its entry's id, so all reports
 * of an entry form one group.
 */
export function groupReports(reports) {
	const groups = new Map();
	for (const report of reports) {
		const key = [report.sanitizer, report.kind, report.location].join('\n');
		let group = groups.get(key);
		if (!group) {
			const { sanitizer, kind, location, known } = report;
			group = { sanitizer, kind, location, known, count: 0, files: new Set(), example: report };
			groups.set(key, group);
		}
		group.count += 1;
		group.files.add(report.file);
	}
	return [...groups.values()].sort(
		(a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.location.localeCompare(b.location)
	);
}

/** The KNOWN_THIRD_PARTY entries that no group matched. */
export function unmatchedKnown(groups) {
	return KNOWN_THIRD_PARTY.filter((entry) => !groups.some((group) => group.known === entry.id));
}

function byteLength(text) {
	return Buffer.byteLength(text, 'utf8');
}

/** A Markdown table cell in code style. */
function cell(text) {
	return `\`${text.replaceAll('`', "'").replaceAll('|', '\\|')}\``;
}

function escapeHtml(text) {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** A code fence longer than any run of backticks in the text. */
function fence(text) {
	const runs = text.match(/`+/g) ?? [];
	return '`'.repeat(Math.max(2, ...runs.map((run) => run.length)) + 1);
}

function exampleBlock(number, group) {
	const body = group.example.lines.join('\n');
	const marks = fence(body);
	const title = escapeHtml(`#${number} ${group.kind}: ${group.count} report(s), example ${group.example.file}`);
	return `<details><summary>${title}</summary>\n\n${marks}text\n${body}\n${marks}\n\n</details>\n\n`;
}

/** The text after the table: each known entry that matched, with its reason and link. */
function knownSection(groups) {
	const lines = groups
		.filter((group) => group.known)
		.map((group) => {
			const entry = KNOWN_THIRD_PARTY.find(({ id }) => id === group.known);
			return `- ${cell(entry.id)}: ${group.count} report(s). ${entry.reason} ${entry.link}\n`;
		});
	return lines.length ? `\n### Known third-party\n\n${lines.join('')}` : '';
}

/**
 * Render the groups as Markdown of at most `limit` bytes: a table of every
 * group that fits, the known third-party entries, then an example
 * report per group while there is room.
 */
export function renderSummary(groups, { limit = SUMMARY_LIMIT } = {}) {
	const tail = knownSection(groups);
	if (!groups.length) return `## Sanitizer reports\n\nNo sanitizer reports.\n${tail}`;
	const total = groups.reduce((sum, group) => sum + group.count, 0);
	const warnings = groups.filter((group) => group.kind === 'warning').reduce((sum, group) => sum + group.count, 0);
	const known = groups.filter((group) => group.known).reduce((sum, group) => sum + group.count, 0);
	const fileCount = new Set(groups.flatMap((group) => [...group.files])).size;
	const parts = [
		'## Sanitizer reports\n\n',
		`${total} report(s) in ${groups.length} group(s), from ${fileCount} file(s). ` +
			'Reports of the same kind at the same location form one group.\n\n',
		known ? `${known} report(s) are known third-party errors (see below); they do not fail this step.\n\n` : '',
		warnings
			? `${warnings} report(s) are sanitizer warnings (kind \`warning\`), not errors; ` +
				'they still fail this step.\n\n'
			: '',
		'| # | Reports | Sanitizer | Kind | Location | Files | Example file |\n',
		'| ---: | ---: | --- | --- | --- | ---: | --- |\n',
	];
	const budget = limit - NOTE_ROOM - byteLength(tail);
	let size = byteLength(parts.join(''));
	const add = (text) => {
		if (size + byteLength(text) > budget) return false;
		parts.push(text);
		size += byteLength(text);
		return true;
	};

	let rows = 0;
	for (const group of groups) {
		const row =
			`| ${rows + 1} | ${group.count} | ${group.sanitizer} | ${cell(group.kind)} | ` +
			`${cell(group.location || '(unknown)')} | ${group.files.size} | ` +
			`${cell(group.example.file)} |\n`;
		if (!add(row)) break;
		rows += 1;
	}
	parts.push(tail);
	let examples = 0;
	if (add('\n### Examples\n\n')) {
		for (const group of groups.slice(0, rows)) {
			if (!add(exampleBlock(examples + 1, group))) break;
			examples += 1;
		}
	}
	const omitted = [];
	if (rows < groups.length) omitted.push(`${groups.length - rows} group(s) left out of the table`);
	if (examples < rows) omitted.push(`${rows - examples} example(s) left out`);
	if (omitted.length) {
		parts.push(`\n_${omitted.join(', ')} to stay under the summary size limit; the report files have them all._\n`);
	}
	return parts.join('');
}

/** Read every file in `dir` (sorted by name) and return their reports. */
async function collectReports(dir, root = '') {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const names = entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
	const reports = [];
	for (const name of names) {
		reports.push(...parseLog(await fs.readFile(path.join(dir, name), 'utf8'), name, root));
	}
	return reports;
}

/**
 * Report on the log directory in `args[0]`; resolves to the exit code (0 when every report is known third-party).
 *
 * Paths under $GITHUB_WORKSPACE are shown relative to it.
 */
export async function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
	const [dir] = args;
	if (!dir) {
		stderr.write('Usage: node scripts/ci/sanitizer-report.mjs <log dir>\n');
		return 2;
	}
	const stat = await fs.stat(dir).catch(() => null);
	if (!stat?.isDirectory()) {
		stderr.write(`Sanitizer log directory not found: ${dir}\n`);
		return 2;
	}

	const reports = await collectReports(dir, env.GITHUB_WORKSPACE ?? '');
	const groups = groupReports(reports);
	const markdown = renderSummary(groups);
	if (env.GITHUB_STEP_SUMMARY) {
		await fs.appendFile(env.GITHUB_STEP_SUMMARY, markdown);
		if (!reports.length) stdout.write(`No sanitizer reports in ${dir}.\n`);
		for (const group of groups) {
			const { count, sanitizer, kind, location } = group;
			stdout.write(`${count}\t${sanitizer}\t${kind}\t${location}\n`);
		}
	} else {
		stdout.write(markdown);
	}
	for (const entry of unmatchedKnown(groups)) {
		const note =
			`known third-party entry ${entry.id} matched no report (the tests may not have run); ` +
			'remove it from KNOWN_THIRD_PARTY if the toolchain was fixed.';
		stdout.write(env.GITHUB_STEP_SUMMARY ? `::notice::${note}\n` : `note: ${note}\n`);
	}
	const failing = reports.filter((report) => !report.known);
	if (!failing.length) return 0;
	const failingGroups = groups.filter((group) => !group.known).length;
	const warnings = failing.filter((report) => report.kind === 'warning').length;
	const known = reports.length - failing.length;
	const counted =
		`${failing.length} sanitizer report(s)${warnings ? ` (${warnings} warning(s))` : ''} ` +
		`in ${failingGroups} group(s)${known ? `, not counting ${known} known third-party report(s)` : ''}`;
	if (env.GITHUB_STEP_SUMMARY) {
		// _sanitize.yaml uploads the log directory as the `sanitizer-reports` artifact
		stderr.write(`::error::${counted}: see the job summary; the sanitizer-reports artifact has the files.\n`);
	} else {
		stderr.write(`${counted} in ${dir}.\n`);
	}
	return 1;
}

/** True when Node started this file as the script, also through a symlink or junction. */
function startedAsScript() {
	if (!process.argv[1]) return false;
	// import.meta.url holds the real path; argv[1] keeps the path as typed
	try {
		return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (startedAsScript()) {
	process.exitCode = await main(process.argv.slice(2));
}
