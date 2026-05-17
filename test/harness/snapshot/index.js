"use strict";

const path = require("path");
const { SnapshotState } = require("jest-snapshot");

/**
 * Gets the per-case snapshot path
 * @param {string} caseDir Absolute path to the test case directory
 * @param {string} suiteName Name of the test suite
 * @returns {string} Snapshot path
 */
const getSnapshotPath = function (caseDir, suiteName) {
	suiteName = suiteName.replace(/Cases/, "");

	return path.join(caseDir, "__snapshots__", `${suiteName}.snap`);
};

const activeSnapshotContexts = [];

/**
 * Creates a per-case SnapshotState
 * @param {string} caseDir Absolute path to the test case directory
 * @param {string} suiteName Name of the test suite
 * @param {SnapshotState} [originalState] Original snapshot state
 * @returns {SnapshotState} Per-case snapshot state
 */
const createPerCaseSnapshotState = function (
	caseDir,
	suiteName,
	originalState = expect.getState().snapshotState
) {
	return new SnapshotState(getSnapshotPath(caseDir, suiteName), {
		updateSnapshot: originalState._updateSnapshot,
		snapshotFormat: originalState.snapshotFormat,
		expand: originalState.expand,
		prettierPath: originalState._prettierPath,
		rootDir: originalState._rootDir || process.cwd()
	});
};

const activateSnapshotState = function (caseDir, suiteName) {
	const originalState = expect.getState().snapshotState;
	const snapshotContext = {
		caseDir,
		suiteName,
		originalState,
		perCaseState: createPerCaseSnapshotState(caseDir, suiteName, originalState),
		snapshotPath: getSnapshotPath(caseDir, suiteName)
	};

	activeSnapshotContexts.push(snapshotContext);
	return snapshotContext;
};

const deactivateSnapshotState = function (snapshotContext) {
	const index = activeSnapshotContexts.lastIndexOf(snapshotContext);
	if (index >= 0) {
		activeSnapshotContexts.splice(index, 1);
	}
};

const finalizePerCaseSnapshotState = function (snapshotContext) {
	const { originalState, perCaseState } = snapshotContext;

	if (perCaseState.getUncheckedCount()) {
		perCaseState.removeUncheckedKeys();
	}
	perCaseState.save();

	originalState.unmatched += perCaseState.unmatched;
	originalState.matched += perCaseState.matched;
	originalState.updated += perCaseState.updated;
	originalState.added += perCaseState.added;
};

const getActiveSnapshotState = function () {
	const snapshotContext =
		activeSnapshotContexts[activeSnapshotContexts.length - 1];

	return snapshotContext && snapshotContext.perCaseState;
};

/**
 * Registers per-case snapshot hooks
 * @param {string} caseDir Absolute path to the test case directory
 * @param {string} suiteName Name of the test suite
 */
const registerPerCaseSnapshotHooks = function (caseDir, suiteName) {
	let snapshotContext;

	beforeAll(() => {
		snapshotContext = activateSnapshotState(caseDir, suiteName);
	});

	afterAll(() => {
		if (!snapshotContext) {
			return;
		}

		try {
			finalizePerCaseSnapshotState(snapshotContext);
		} finally {
			deactivateSnapshotState(snapshotContext);
			snapshotContext = undefined;
		}
	});
};

/**
 * Runs a callback with a temporary SnapshotState that writes to
 * `<caseDir>/__snapshots__/<kind>.snap`. This allows error and warning
 * snapshots to live in dedicated files (e.g. `errors.snap`,
 * `warnings.snap`) instead of sharing the suite-level snap file.
 * @param {string} caseDir Absolute path to the test case directory
 * @param {string} kind Snapshot kind, used as filename (e.g. "errors")
 * @param {function(): void} fn Callback that calls toMatchSnapshot()
 */
const withKindSnapshotState = function (caseDir, kind, fn) {
	const snapshotPath = path.join(caseDir, "__snapshots__", `${kind}.snap`);
	const parentState =
		getActiveSnapshotState() || expect.getState().snapshotState;

	const kindState = new SnapshotState(snapshotPath, {
		updateSnapshot: parentState._updateSnapshot,
		snapshotFormat: parentState.snapshotFormat,
		expand: parentState.expand,
		prettierPath: parentState._prettierPath,
		rootDir: parentState._rootDir || process.cwd()
	});

	const tempContext = { perCaseState: kindState };
	activeSnapshotContexts.push(tempContext);

	try {
		fn();
	} finally {
		activeSnapshotContexts.pop();

		// Persist the snapshot file (do NOT removeUncheckedKeys —
		// multiple test suites share the same file via different keys).
		kindState.save();

		// Bubble counts up to the parent state so Jest reports them.
		parentState.unmatched += kindState.unmatched;
		parentState.matched += kindState.matched;
		parentState.updated += kindState.updated;
		parentState.added += kindState.added;
	}
};

module.exports.getActiveSnapshotState = getActiveSnapshotState;
module.exports.registerPerCaseSnapshotHooks = registerPerCaseSnapshotHooks;
module.exports.withKindSnapshotState = withKindSnapshotState;
