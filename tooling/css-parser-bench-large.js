"use strict";

/*
 * CssParser bench on a *large* CSS input.
 *
 * Generates a half-megabyte CSS module by concatenating the existing
 * `test/configCases/css/css-modules/style.module.css` fixture 15× —
 * a representative real-world workload (35 kB × 15 ≈ 500 kB) that
 * exercises class / ID / attribute selectors, `:local()` /
 * `:global()`, `@media`, `@keyframes`, `@counter-style`, `:export`,
 * declarations with `url()` / `image-set()` / custom properties.
 *
 * Run with:
 *   node tooling/css-parser-bench-large.js
 *
 * BENCH_MS=10000 to extend the measurement window;
 * REPEAT=N to change the multiplier.
 */

const fs = require("fs");
const path = require("path");

const CssParser = require("../lib/css/CssParser");

const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURE_PATH = path.join(
	REPO_ROOT,
	"test/configCases/css/css-modules/style.module.css"
);
const REPEAT = Number(process.env.REPEAT || 15);
const TARGET_MS = Number(process.env.BENCH_MS || 5000);

const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

// Shared compiler-root sentinel: `parser.parse` does
// `unescapeIdentifier.bindCache(state.compilation.compiler.root)` per
// call, and the cache keys off the root *identity*. Re-using one
// sentinel across iterations lets the cache amortize — the bench
// would otherwise rebind to a fresh `{}` each iter and lose every
// hit, mis-representing the steady-state cost of a CssParser parse.
const SHARED_COMPILER_ROOT = {};

/**
 * Build a minimal mock state for `CssParser.parse`. Identical to the
 * matrix bench's mock — addDep callbacks are no-ops so they're not on
 * the hot path.
 * @param {string} resource module's resource path
 * @returns {EXPECTED_OBJECT} parser state
 */
const makeMockState = (resource) => {
	/** @type {EXPECTED_OBJECT} */
	const mod = {
		type: "css/module",
		context: path.dirname(resource),
		resource,
		dependencies: [],
		buildInfo: {},
		buildMeta: {},
		factoryMeta: {},
		generator: {
			type: "css/module",
			options: {
				exportsConvention: "as-is",
				localIdentName: "[hash:base64]"
			}
		},
		addDependency: () => {},
		addPresentationalDependency: () => {},
		addCodeGenerationDependency: () => {},
		addWarning: () => {},
		addError: () => {},
		getResource: () => resource,
		issuer: null,
		_source: {}
	};
	return {
		module: mod,
		current: mod,
		compilation: {
			fileDependencies: new Set(),
			contextDependencies: new Set(),
			compiler: { root: SHARED_COMPILER_ROOT }
		}
	};
};

const fixture = fs.readFileSync(FIXTURE_PATH, "utf8");
const source = fixture.repeat(REPEAT);

console.log(
	`CssParser large-input bench — node ${process.version}, ${TARGET_MS} ms / run`
);
console.log(
	`  fixture: style.module.css × ${REPEAT}  =  ${fmt(source.length)} bytes`
);

const parser = new CssParser({
	namedExports: true,
	esModule: true,
	url: true,
	import: true
});

// Sanity check: confirm the parser actually does work on this input.
{
	const deps = [];
	const state = makeMockState(FIXTURE_PATH);
	state.module.addDependency = (d) => deps.push(d);
	parser.parse(source, state);
	console.log(
		`  one parse: ${fmt(deps.length)} dependencies, ${fmt(
			parser.comments ? parser.comments.length : 0
		)} comments collected`
	);
}

// Warm-up.
for (let i = 0; i < 3; i++) parser.parse(source, makeMockState(FIXTURE_PATH));

const t0 = process.hrtime.bigint();
let iter = 0;
const targetNs = BigInt(TARGET_MS) * 1000000n;
while (process.hrtime.bigint() - t0 < targetNs) {
	parser.parse(source, makeMockState(FIXTURE_PATH));
	iter++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(
	`  ${iter} iters in ${fmt(ms)} ms  =  ${fmt(ms / iter)} ms/op   ` +
		`(${fmt((iter / ms) * 1000)} op/s)`
);
