"use strict";

const path = require("path");

/**
 * Maps per-case snapshot file names to their corresponding test files.
 * @type {Record<string, string>}
 */
const suiteNameToTestFile = {
	ConfigTest: path.resolve(__dirname, "../../ConfigTestCases.basictest.js"),
	ConfigCacheTest: path.resolve(
		__dirname,
		"../../ConfigCacheTestCases.basictest.js"
	),
	StatsTest: path.resolve(__dirname, "../../StatsTestCases.basictest.js")
};

const SNAPSHOT_EXTENSION = ".snap";

/**
 * Per-kind snapshot names produced by checkArrayExpectation's
 * withKindSnapshotState (e.g. errors.snap, warnings.snap).
 * These live inside per-case __snapshots__ dirs and must be resolved
 * back to a test file so Jest doesn't flag them as obsolete.
 * @type {Set<string>}
 */
const PER_KIND_NAMES = new Set(["errors", "warnings"]);

/**
 * Resolves a per-kind snapshot path to the test file that owns it,
 * by inspecting the directory hierarchy (test/cases/ vs test/configCases/).
 * @param {string} snapshotPath absolute path to the .snap file
 * @returns {string | undefined} test file path, or undefined if not recognized
 */
const resolveKindSnapshotTestPath = (snapshotPath) => {
	const casesDir = path.resolve(__dirname, "../../cases");
	const configCasesDir = path.resolve(__dirname, "../../configCases");

	if (snapshotPath.startsWith(casesDir + path.sep)) {
		return path.resolve(__dirname, "../../TestCasesNormal.basictest.js");
	}
	if (snapshotPath.startsWith(configCasesDir + path.sep)) {
		return path.resolve(__dirname, "../../ConfigTestCases.basictest.js");
	}
	return undefined;
};

module.exports = {
	// Example test path, used for preflight consistency check of the implementation above
	testPathForConsistencyCheck: path.join(
		"some",
		"__tests__",
		"example.test.js"
	),

	/**
	 * Resolves from test to snapshot path
	 * @param {string} testPath The test file path
	 * @param {string} snapshotExtension The snapshot extension
	 * @returns {string} The snapshot file path
	 */
	resolveSnapshotPath(testPath, snapshotExtension = SNAPSHOT_EXTENSION) {
		return path.join(
			path.dirname(testPath),
			"__snapshots__",
			path.basename(testPath) + snapshotExtension
		);
	},

	/**
	 * Resolves from snapshot to test path
	 * @param {string} snapshotPath The snapshot file path
	 * @param {string} snapshotExtension The snapshot extension
	 * @returns {string} The test file path
	 */
	resolveTestPath(snapshotPath, snapshotExtension = SNAPSHOT_EXTENSION) {
		const basename = path.basename(snapshotPath, snapshotExtension);

		// Check if this is a per-case snapshot (e.g., StatsTest.snap, ConfigTest.snap)
		if (suiteNameToTestFile[basename]) {
			return suiteNameToTestFile[basename];
		}

		// Per-kind snapshots (errors.snap, warnings.snap) from checkArrayExpectation
		if (PER_KIND_NAMES.has(basename)) {
			const resolved = resolveKindSnapshotTestPath(snapshotPath);
			if (resolved) return resolved;
		}

		// Default behavior: remove __snapshots__ dir and .snap extension
		return path.join(path.dirname(path.dirname(snapshotPath)), basename);
	}
};
