"use strict";

/*
 * CSS parser pattern micro-benchmark.
 *
 * Compares three traversal patterns for a CSS source, on the assumption
 * that any "real" parser (lex → parse → walk) sits somewhere between
 * the lex-only floor and the parse+walk ceiling. The middle entry
 * (single-pass class) is the candidate replacement that combines the
 * lexer, an AST-builder state-machine, and a visitor into one loop —
 * no intermediate AST array, no second walk over the result.
 *
 * Patterns:
 *   1. lex-only      — drive `walkCssTokens(source)` to exhaustion,
 *                      count tokens. Establishes the tokenizer floor.
 *   2. parse + walk  — `parseAStylesheet` (which lexes + builds a
 *                      full AST), then a recursive visitor walk over
 *                      the AST. Mirrors what `CssParser.runAstWalker`
 *                      does today (two loops over the same source).
 *   3. single-pass   — `OnePassParser`: holds the lexer iterator,
 *                      a small AST-builder state machine, and a
 *                      visitor; emits visitor `enterRule` /
 *                      `enterAtRule` / `enterDeclaration` (plus
 *                      `leave…`) directly from the token loop without
 *                      materializing intermediate AST nodes.
 *
 * The visitor used for the comparison just counts events into a
 * mutable `Counts` object — heavy enough to keep the JIT from
 * eliding the visit work, light enough that the perf delta reflects
 * the *pattern* and not the visitor.
 *
 * Run with:
 *   node tooling/css-parser-pattern-bench.js
 */

const fs = require("fs");
const path = require("path");

const walkCssTokens = require("../lib/css/walkCssTokens");

const { parseAStylesheet } = walkCssTokens;

// Sample CSS files (postcss-modules-plugins fixtures are the largest
// non-generated CSS in the repo and exercise the full grammar — nested
// rules, `@keyframes`, `@media`, declarations, ICSS `:import`/`:export`).
const SAMPLES = [
	"test/configCases/css/postcss-modules-plugins/postcss-modules-local-by-default.local.modules.css",
	"test/configCases/css/postcss-modules-plugins/postcss-modules-local-by-default.pure.modules.css",
	"test/configCases/css/postcss-modules-plugins/postcss-modules-scope.modules.css",
	"test/configCases/css/postcss-modules-plugins/postcss-modules-values.modules.css",
	"test/configCases/css/css-modules/at-rule-value.module.css"
];

const REPO_ROOT = path.resolve(__dirname, "..");

// `LocConverter` is private inside `walkCssTokens.js` — `parseAStylesheet`
// requires one, so we ship a stub that satisfies the interface
// (`get(pos) → { line, column }`) without doing the linear scan.
// Loc-conversion isn't on the hot path for any of the three patterns,
// and we'd be measuring `LocConverter` work instead of the parser
// pattern if we used the real one.
const NULL_LOC_CONVERTER = {
	get() {
		return { line: 1, column: 0 };
	}
};

/**
 * Mutable counter the visitor writes into. Reset before each run.
 * @typedef {{ tokens: number, atRules: number, qualifiedRules: number, declarations: number, enter: number, leave: number }} Counts
 */

/**
 * Make a fresh counter.
 * @returns {Counts} fresh counts
 */
const makeCounts = () => ({
	tokens: 0,
	atRules: 0,
	qualifiedRules: 0,
	declarations: 0,
	enter: 0,
	leave: 0
});

// ---------------------------------------------------------------------
// Pattern 1: lex-only floor.
// ---------------------------------------------------------------------

/**
 * Drive the tokenizer to exhaustion.
 * @param {string} source CSS source
 * @param {Counts} counts mutable accumulator
 * @returns {void}
 */
const lexOnly = (source, counts) => {
	for (const t of walkCssTokens(source, 0)) {
		counts.tokens++;
		if (t.type === "atKeyword") counts.atRules++;
	}
};

// ---------------------------------------------------------------------
// Pattern 2: parse + walk (current CssParser shape).
// ---------------------------------------------------------------------

/**
 * Recursively walk the AST a `parseAStylesheet`-produced tree, firing
 * visitor events. Body blocks of qualified rules / at-rules are parsed
 * lazily via `parseAStylesheet`-style recursion through
 * `parseABlocksContents` (the same way `CssParser.runAstWalker`
 * re-parses bodies today) — kept here for fairness so this pattern
 * pays the same body-parse cost as the production walker.
 * @param {string} source CSS source
 * @param {Counts} counts mutable accumulator
 * @returns {void}
 */
const parseThenWalk = (source, counts) => {
	const stylesheet = parseAStylesheet(source, NULL_LOC_CONVERTER);
	/**
	 * @param {ReadonlyArray<unknown>} items items
	 * @returns {void}
	 */
	const walk = (items) => {
		for (const item of items) {
			const it =
				/** @type {{ type: string, block?: { start: number } | null }} */ (
					item
				);
			if (it.type === "at-rule") {
				counts.atRules++;
				counts.enter++;
				if (it.block) {
					const inner = walkCssTokens.parseABlocksContents(
						source,
						it.block.start + 1,
						NULL_LOC_CONVERTER
					);
					walk(inner.values);
				}
				counts.leave++;
			} else if (it.type === "qualified-rule") {
				counts.qualifiedRules++;
				counts.enter++;
				if (it.block) {
					const inner = walkCssTokens.parseABlocksContents(
						source,
						it.block.start + 1,
						NULL_LOC_CONVERTER
					);
					walk(inner.values);
				}
				counts.leave++;
			} else if (it.type === "declaration") {
				counts.declarations++;
				counts.enter++;
				counts.leave++;
			}
		}
	};
	walk(stylesheet.rules);
};

// ---------------------------------------------------------------------
// Pattern 3: single-pass class (lexer + builder + visitor in one loop).
//
// Reuses the public `walkCssTokens` parse helpers (`parseAtRule`,
// `parseADeclaration`, `parseAListOfComponentValues`) for the
// individual rule / declaration heads, and drives body recursion
// itself — so the prelude/declaration parsing keeps the spec-correct
// helpers (we don't fork their grammar) but the *outer* loop only
// visits each byte once. The double parse the lazy walker pays
// (`parseAStylesheet` builds the full tree, then `parseABlocksContents`
// re-parses each body to walk it) is gone.
// ---------------------------------------------------------------------

const CC_AT_SIGN = "@".charCodeAt(0);
const CC_SEMICOLON_OPP = ";".charCodeAt(0);
const CC_RIGHT_CURLY_OPP = "}".charCodeAt(0);

/**
 * One-pass CSS walker. Holds the source, a `LocConverter`, and a
 * visitor; reuses `walkCssTokens`'s public parse helpers for the
 * individual rule/declaration heads and recurses into block bodies
 * itself (no `parseASimpleBlock` to consume the body as flat tokens
 * and then re-walk it). The visitor receives the same AST node
 * objects the lazy walker produces.
 */
class OnePassParser {
	/**
	 * @param {string} input CSS source
	 * @param {{ get(pos: number): { line: number, column: number } }} locConverter loc converter (real or stub)
	 * @param {{
	 * enterAtRule?: (at: unknown) => void,
	 * leaveAtRule?: (at: unknown) => void,
	 * enterQualifiedRule?: (rule: unknown) => void,
	 * leaveQualifiedRule?: (rule: unknown) => void,
	 * enterDeclaration?: (decl: unknown) => void,
	 * leaveDeclaration?: (decl: unknown) => void,
	 * comment?: (input: string, start: number, end: number) => number,
	 * }} visitor visitor
	 */
	constructor(input, locConverter, visitor) {
		this.input = input;
		this.locConverter = locConverter;
		this.visitor = visitor;
	}

	/**
	 * Walk the whole stylesheet, firing visitor events in source order.
	 * @returns {void}
	 */
	parse() {
		this._walkBlock(0);
	}

	/**
	 * Walk the contents of a block (`pos` should be just past the
	 * opening `{`, or `0` for the top-level stylesheet). Returns the
	 * position of the closing `}` (not consumed) or `input.length`
	 * for the top-level call.
	 * @param {number} startPos start position (just past `{` or 0 for top level)
	 * @returns {number} position at the closing `}` (or input.length at top level)
	 */
	_walkBlock(startPos) {
		const input = this.input;
		const locConverter = this.locConverter;
		const visitor = this.visitor;
		const comment = visitor.comment;
		let pos = startPos;
		while (pos < input.length) {
			// Same item-boundary handling `parseABlocksContents` uses:
			// skip whitespace + comments, then any stray `;`s.
			pos = walkCssTokens.eatWhitespaceAndComments(input, pos)[0];
			while (pos < input.length && input.charCodeAt(pos) === CC_SEMICOLON_OPP) {
				pos++;
				pos = walkCssTokens.eatWhitespaceAndComments(input, pos)[0];
			}
			if (pos >= input.length) break;
			// `}` closes the enclosing block — let the caller consume it.
			if (input.charCodeAt(pos) === CC_RIGHT_CURLY_OPP) return pos;

			// At-rule. `parseAtRule` consumes the prelude only (it
			// returns at the `{` or `;`), so we can fire `enterAtRule`,
			// recurse into the body, then `leaveAtRule` — no body
			// re-parse needed.
			if (input.charCodeAt(pos) === CC_AT_SIGN) {
				const at = walkCssTokens.parseAtRule(input, pos, locConverter, comment);
				if (!at) {
					pos++;
					continue;
				}
				if (visitor.enterAtRule) visitor.enterAtRule(at);
				if (at.terminator === "{") {
					// at.end points at the `{` — recurse just past it.
					const bodyEnd = this._walkBlock(at.end + 1);
					// Consume the `}` and patch the AtRule's end so
					// downstream consumers see the full span.
					pos =
						bodyEnd < input.length &&
						input.charCodeAt(bodyEnd) === CC_RIGHT_CURLY_OPP
							? bodyEnd + 1
							: bodyEnd;
					at.end = pos;
				} else if (at.terminator === ";") {
					pos = at.end + 1;
				} else {
					pos = at.end;
				}
				if (visitor.leaveAtRule) visitor.leaveAtRule(at);
				continue;
			}

			// Try a declaration first (`parseADeclaration` returns
			// `undefined` when the head doesn't look like one — fall
			// through to a qualified rule).
			const decl = walkCssTokens.parseADeclaration(
				input,
				pos,
				locConverter,
				comment
			);
			if (decl) {
				if (visitor.enterDeclaration) visitor.enterDeclaration(decl);
				if (visitor.leaveDeclaration) visitor.leaveDeclaration(decl);
				pos = decl.end;
				if (pos < input.length && input.charCodeAt(pos) === CC_SEMICOLON_OPP) {
					pos++;
				}
				continue;
			}

			// Qualified rule. `parseAQualifiedRule` itself consumes
			// the body via `parseASimpleBlock` and we want the body
			// walked by *us* (no flat-tokens-then-re-parse). Replicate
			// its prelude parse with `parseAListOfComponentValues`,
			// mirroring the `stopAtLeftCurly` / `stopAtRightCurly`
			// flags.
			const head = walkCssTokens.parseAListOfComponentValues(
				input,
				pos,
				locConverter,
				{
					stopAtLeftCurly: true,
					stopAtRightCurly: true,
					comment
				}
			);
			if (head.end <= pos) {
				pos++;
				continue;
			}
			const rule = {
				type: "qualified-rule",
				prelude: head.values,
				block: null,
				start: pos,
				end: head.end
			};
			if (head.terminator !== "{") {
				if (visitor.enterQualifiedRule) visitor.enterQualifiedRule(rule);
				if (visitor.leaveQualifiedRule) visitor.leaveQualifiedRule(rule);
				pos = head.end;
				continue;
			}
			// Body recursion. Stash a SimpleBlock-shaped object on
			// `rule.block` so visitors see the same shape
			// `parseAStylesheet` produces (just `start`/`end` — the
			// values array stays empty since body items go straight
			// to the visitor, not into an AST array).
			rule.block = {
				type: "simple-block",
				token: "{",
				start: head.end,
				end: head.end + 1,
				value: []
			};
			if (visitor.enterQualifiedRule) visitor.enterQualifiedRule(rule);
			const bodyEnd = this._walkBlock(head.end + 1);
			pos =
				bodyEnd < input.length &&
				input.charCodeAt(bodyEnd) === CC_RIGHT_CURLY_OPP
					? bodyEnd + 1
					: bodyEnd;
			rule.block.end = pos;
			rule.end = pos;
			if (visitor.leaveQualifiedRule) visitor.leaveQualifiedRule(rule);
		}
		return pos;
	}
}

/**
 * Drive the single-pass parser.
 * @param {string} source CSS source
 * @param {Counts} counts mutable accumulator
 * @returns {void}
 */
const onePass = (source, counts) => {
	const visitor = {
		enterAtRule() {
			counts.atRules++;
			counts.enter++;
		},
		leaveAtRule() {
			counts.leave++;
		},
		enterQualifiedRule() {
			counts.qualifiedRules++;
			counts.enter++;
		},
		leaveQualifiedRule() {
			counts.leave++;
		},
		enterDeclaration() {
			counts.declarations++;
			counts.enter++;
		},
		leaveDeclaration() {
			counts.leave++;
		}
	};
	new OnePassParser(source, NULL_LOC_CONVERTER, visitor).parse();
};

// ---------------------------------------------------------------------
// Benchmark driver.
// ---------------------------------------------------------------------

/**
 * Run `fn` over `source` until elapsed exceeds `targetMs`, return
 * { iterations, elapsedMs }.
 * @param {(source: string, counts: Counts) => void} fn pattern to time
 * @param {string} source CSS source
 * @param {number} targetMs target benchmark duration
 * @returns {{ iterations: number, elapsedMs: number, counts: Counts }} result
 */
const time = (fn, source, targetMs) => {
	const counts = makeCounts();
	// Warm-up — let V8 specialize.
	for (let i = 0; i < 5; i++) fn(source, counts);
	const start = process.hrtime.bigint();
	let iterations = 0;
	const targetNs = BigInt(targetMs) * 1000000n;
	while (process.hrtime.bigint() - start < targetNs) {
		fn(source, counts);
		iterations++;
	}
	const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
	return { iterations, elapsedMs, counts };
};

/**
 * @param {string} source CSS source
 * @returns {{ tokens: number, atRules: number, qualifiedRules: number, declarations: number }} reference counts produced by the parse+walk pattern
 */
const referenceCounts = (source) => {
	const counts = makeCounts();
	parseThenWalk(source, counts);
	const lex = makeCounts();
	lexOnly(source, lex);
	return {
		tokens: lex.tokens,
		atRules: counts.atRules,
		qualifiedRules: counts.qualifiedRules,
		declarations: counts.declarations
	};
};

/**
 * Format a number with `,` thousand separators.
 * @param {number} n number
 * @returns {string} formatted string
 */
const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

/**
 * Run the benchmark for one CSS file.
 * @param {string} relPath path relative to repo root
 * @param {number} targetMs benchmark target duration
 * @returns {void}
 */
const runOne = (relPath, targetMs) => {
	const source = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
	const ref = referenceCounts(source);
	console.log(`\n${relPath}`);
	console.log(
		`  size: ${fmt(source.length)} bytes,  tokens: ${fmt(ref.tokens)},  ` +
			`at-rules: ${fmt(ref.atRules)},  qualified-rules: ${fmt(
				ref.qualifiedRules
			)},  declarations: ${fmt(ref.declarations)}`
	);

	const patterns = [
		["lex only           ", lexOnly],
		["parse + walk       ", parseThenWalk],
		["single-pass class  ", onePass]
	];

	/** @type {{ name: string, iterations: number, opsPerSec: number, msPerOp: number, counts: Counts }[]} */
	const results = [];
	for (const [name, fn] of patterns) {
		const { iterations, elapsedMs, counts } = time(
			/** @type {(source: string, counts: Counts) => void} */ (fn),
			source,
			targetMs
		);
		results.push({
			name: /** @type {string} */ (name),
			iterations,
			opsPerSec: (iterations / elapsedMs) * 1000,
			msPerOp: elapsedMs / iterations,
			counts
		});
	}

	// Use parse+walk as the baseline for the speed ratio.
	const baseline = results[1];
	for (const r of results) {
		const ratio = baseline.msPerOp / r.msPerOp;
		// Per-iteration visitor-call count — sanity-checks that the
		// rows actually recognize the same number of nodes
		// (lex-only fires no visitor calls and so reports 0).
		const perParse =
			r.counts.enter > 0 ? Math.round(r.counts.enter / r.iterations) : 0;
		console.log(
			`  ${r.name}  ${fmt(r.opsPerSec).padStart(10)} op/s   ` +
				`${fmt(r.msPerOp).padStart(7)} ms/op   ` +
				`x${fmt(ratio).padStart(5)}   ` +
				`${perParse} nodes/parse`
		);
	}
};

/**
 * @returns {void}
 */
const main = () => {
	const targetMs = Number(process.env.BENCH_MS || 1000);
	console.log(
		`CSS parser pattern micro-benchmark — node ${process.version}, ` +
			`${targetMs} ms / pattern / file`
	);
	console.log(
		"ratio column is (parse+walk ms/op) / (this row ms/op): >1 means faster than parse+walk."
	);
	for (const sample of SAMPLES) {
		runOne(sample, targetMs);
	}
};

main();
