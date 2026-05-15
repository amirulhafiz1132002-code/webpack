"use strict";

/*
 * CssParser end-to-end micro-benchmark.
 *
 * Drives `CssParser.parse` directly with a minimal mocked module so we
 * can measure parse-and-walk time without the overhead of a full
 * webpack compile. The mock collects deps + warnings into arrays so
 * the visitor work isn't elided; the GC pressure is on the parser,
 * not the mock.
 *
 * Run with:
 *   node tooling/css-parser-bench.js
 */

const fs = require("fs");
const path = require("path");

const CssParser = require("../lib/css/CssParser");

const REPO_ROOT = path.resolve(__dirname, "..");

const SAMPLES = [
	{
		path: "test/configCases/css/postcss-modules-plugins/postcss-modules-local-by-default.local.modules.css",
		opts: { namedExports: true, esModule: true, url: true, import: true }
	},
	{
		path: "test/configCases/css/postcss-modules-plugins/postcss-modules-local-by-default.pure.modules.css",
		opts: {
			namedExports: true,
			esModule: true,
			url: true,
			import: true,
			pure: true
		}
	},
	{
		path: "test/configCases/css/postcss-modules-plugins/postcss-modules-scope.modules.css",
		opts: { namedExports: true, esModule: true, url: true, import: true }
	},
	{
		path: "test/configCases/css/postcss-modules-plugins/postcss-modules-values.modules.css",
		opts: { namedExports: true, esModule: true, url: true, import: true }
	},
	{
		path: "test/configCases/css/css-modules/at-rule-value.module.css",
		opts: { namedExports: true, esModule: true, url: true, import: true }
	}
];

const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

/**
 * Build a minimal mock state for `CssParser.parse`. All dep / warning
 * sinks are arrays so the visitor work is observable but the cost is
 * dominated by the parser.
 * @param {string} resource module's resource path
 * @returns {EXPECTED_OBJECT} parser state
 */
const makeMockState = (resource) => {
	const deps = [];
	const presentationalDeps = [];
	const codeGenDeps = [];
	const warnings = [];
	const errors = [];
	/** @type {EXPECTED_OBJECT} */
	const module = {
		type: "css/module",
		context: path.dirname(resource),
		resource,
		dependencies: deps,
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
		addDependency: (d) => deps.push(d),
		addPresentationalDependency: (d) => presentationalDeps.push(d),
		addCodeGenerationDependency: (d) => codeGenDeps.push(d),
		addWarning: (w) => warnings.push(w),
		addError: (e) => errors.push(e),
		getResource: () => resource,
		issuer: null,
		_source: {}
	};
	return {
		module,
		current: module,
		compilation: { fileDependencies: new Set(), contextDependencies: new Set() }
	};
};

/**
 * Time `fn` for `targetMs`. Returns iterations + elapsedMs.
 * @param {() => void} fn function to time
 * @param {number} targetMs target duration
 * @returns {{ iterations: number, elapsedMs: number }} result
 */
const time = (fn, targetMs) => {
	for (let i = 0; i < 10; i++) fn();
	const start = process.hrtime.bigint();
	let iterations = 0;
	const targetNs = BigInt(targetMs) * 1000000n;
	while (process.hrtime.bigint() - start < targetNs) {
		fn();
		iterations++;
	}
	const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
	return { iterations, elapsedMs };
};

/**
 * Run the benchmark for one CSS file.
 * @param {string} relPath path relative to repo root
 * @param {EXPECTED_OBJECT} opts CssParser options
 * @param {number} targetMs duration
 * @returns {void}
 */
const runOne = (relPath, opts, targetMs) => {
	const absPath = path.join(REPO_ROOT, relPath);
	const source = fs.readFileSync(absPath, "utf8");
	const parser = new CssParser(opts);
	const fn = () => {
		const state = makeMockState(absPath);
		parser.parse(source, state);
	};
	let result;
	try {
		result = time(fn, targetMs);
	} catch (err) {
		console.log(`${relPath}\n  ERROR: ${/** @type {Error} */ (err).message}`);
		return;
	}
	const opsPerSec = (result.iterations / result.elapsedMs) * 1000;
	const msPerOp = result.elapsedMs / result.iterations;
	console.log(
		`${relPath}\n  size: ${fmt(source.length)} bytes  ` +
			`${fmt(opsPerSec).padStart(8)} op/s   ` +
			`${fmt(msPerOp).padStart(7)} ms/op`
	);
};

const main = () => {
	const targetMs = Number(process.env.BENCH_MS || 1500);
	console.log(
		`CssParser end-to-end micro-benchmark — node ${process.version}, ` +
			`${targetMs} ms / file`
	);
	for (const { path: p, opts } of SAMPLES) {
		runOne(p, opts, targetMs);
	}
};

main();
