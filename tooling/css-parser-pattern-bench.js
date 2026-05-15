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
// ---------------------------------------------------------------------

const T_TOP = 0;
const T_PRELUDE = 1;
const T_BLOCK = 2;
const T_DECL_VALUE = 3;

/**
 * One-pass CSS parser: drives `walkCssTokens` directly and emits
 * visitor events at the rule / at-rule / declaration boundaries it
 * recognizes, *without* materializing intermediate AST nodes. The
 * `Frame` stack tracks the nesting context (top level vs in-block vs
 * inside a prelude vs inside a declaration value) so the same `{` /
 * `}` / `;` token dispatches to the right enter/leave event.
 *
 * Not a spec-complete parser — `:import("…")` qualified rules with
 * declarations inside are still recognized as qualified rules; the
 * visitor doesn't see anything below the declaration value boundary.
 * It's sufficient for the benchmark, which only cares about the
 * three top-level event kinds.
 */
class OnePassParser {
	/**
	 * @param {string} input CSS source
	 * @param {{
	 * enterRule?: (start: number) => void,
	 * leaveRule?: (end: number) => void,
	 * enterAtRule?: (nameStart: number, nameEnd: number) => void,
	 * leaveAtRule?: (end: number) => void,
	 * enterDeclaration?: (nameStart: number, nameEnd: number) => void,
	 * leaveDeclaration?: (end: number) => void,
	 * }} visitor visitor
	 */
	constructor(input, visitor) {
		this.input = input;
		this.visitor = visitor;
		/** @type {{ mode: number, nameStart: number, nameEnd: number, isAtRule: boolean }[]} */
		this.stack = [];
		this.mode = T_TOP;
		this.preludeStart = 0;
		this.atNameStart = -1;
		this.atNameEnd = -1;
		this.declNameStart = -1;
		this.declNameEnd = -1;
		this.balanced = 0;
	}

	/**
	 * Drive the loop. Each token mutates `mode` / dispatches the
	 * appropriate visitor event. No AST objects are allocated; we
	 * pass source positions to the visitor directly.
	 * @returns {void}
	 */
	parse() {
		const input = this.input;
		const visitor = this.visitor;
		let preludeNameStart = -1;
		let preludeNameEnd = -1;
		let isAtRulePrelude = false;
		for (const t of walkCssTokens(input, 0)) {
			const type = t.type;
			if (type === "whitespace" || type === "comment") continue;
			if (this.mode === T_TOP || this.mode === T_BLOCK) {
				if (type === "atKeyword") {
					this.mode = T_PRELUDE;
					preludeNameStart = t.start;
					preludeNameEnd = t.end;
					isAtRulePrelude = true;
					continue;
				}
				if (type === "rightCurlyBracket") {
					if (this.mode === T_BLOCK) {
						const frame = this.stack.pop();
						this.mode = this.stack.length === 0 ? T_TOP : T_BLOCK;
						if (frame) {
							if (frame.isAtRule) {
								if (visitor.leaveAtRule) visitor.leaveAtRule(t.end);
							} else if (visitor.leaveRule) {
								visitor.leaveRule(t.end);
							}
						}
					}
					continue;
				}
				if (type === "semicolon") continue;
				// Anything else opens a qualified-rule prelude.
				this.mode = T_PRELUDE;
				preludeNameStart = t.start;
				preludeNameEnd = t.end;
				isAtRulePrelude = false;
				// Identifier in block-content context might also be a
				// declaration property name. We can't distinguish until
				// we see `:` vs `{`. Track it.
				if (
					(this.mode === T_PRELUDE || this.mode === T_BLOCK) &&
					type === "identifier"
				) {
					this.declNameStart = t.start;
					this.declNameEnd = t.end;
				}
				continue;
			}
			if (this.mode === T_PRELUDE) {
				if (type === "leftParenthesis" || type === "function") {
					this.balanced++;
					continue;
				}
				if (type === "rightParenthesis") {
					if (this.balanced > 0) this.balanced--;
					continue;
				}
				if (this.balanced > 0) continue;
				if (type === "semicolon" && isAtRulePrelude) {
					// `;`-terminated at-rule (e.g. `@import`).
					if (visitor.enterAtRule) {
						visitor.enterAtRule(preludeNameStart, preludeNameEnd);
					}
					if (visitor.leaveAtRule) visitor.leaveAtRule(t.end);
					this.mode = this.stack.length === 0 ? T_TOP : T_BLOCK;
					continue;
				}
				if (type === "leftCurlyBracket") {
					if (isAtRulePrelude) {
						if (visitor.enterAtRule) {
							visitor.enterAtRule(preludeNameStart, preludeNameEnd);
						}
						this.stack.push({
							mode: this.mode,
							nameStart: preludeNameStart,
							nameEnd: preludeNameEnd,
							isAtRule: true
						});
					} else {
						if (visitor.enterRule) visitor.enterRule(preludeNameStart);
						this.stack.push({
							mode: this.mode,
							nameStart: preludeNameStart,
							nameEnd: preludeNameEnd,
							isAtRule: false
						});
					}
					this.mode = T_BLOCK;
					continue;
				}
				if (type === "colon" && !isAtRulePrelude && this.declNameStart >= 0) {
					// In a block-content prelude, a `:` after a leading
					// ident promotes the prelude to a declaration head
					// (the `{`-vs-`;` ambiguity resolves toward `;`).
					if (visitor.enterDeclaration) {
						visitor.enterDeclaration(this.declNameStart, this.declNameEnd);
					}
					this.mode = T_DECL_VALUE;
					continue;
				}
				continue;
			}
			if (this.mode === T_DECL_VALUE) {
				if (type === "leftParenthesis" || type === "function") {
					this.balanced++;
					continue;
				}
				if (type === "rightParenthesis") {
					if (this.balanced > 0) this.balanced--;
					continue;
				}
				if (this.balanced > 0) continue;
				if (type === "semicolon" || type === "rightCurlyBracket") {
					if (visitor.leaveDeclaration) visitor.leaveDeclaration(t.start);
					this.declNameStart = -1;
					this.declNameEnd = -1;
					if (type === "rightCurlyBracket") {
						const frame = this.stack.pop();
						this.mode = this.stack.length === 0 ? T_TOP : T_BLOCK;
						if (frame) {
							if (frame.isAtRule) {
								if (visitor.leaveAtRule) visitor.leaveAtRule(t.end);
							} else if (visitor.leaveRule) {
								visitor.leaveRule(t.end);
							}
						}
					} else {
						this.mode = this.stack.length === 0 ? T_TOP : T_BLOCK;
					}
					continue;
				}
			}
		}
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
		enterRule() {
			counts.qualifiedRules++;
			counts.enter++;
		},
		leaveRule() {
			counts.leave++;
		},
		enterAtRule() {
			counts.atRules++;
			counts.enter++;
		},
		leaveAtRule() {
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
	new OnePassParser(source, visitor).parse();
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
