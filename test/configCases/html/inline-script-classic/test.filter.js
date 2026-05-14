"use strict";

// `experiments.html` was added in webpack alongside other features that rely
// on Jest's ESM support (`--experimental-vm-modules`), which needs Node 12+.
// Skip on Node 10 to match the gating on other html `experiments.html`
// tests (script-src, modulepreload-esm, …).
module.exports = function filter() {
	const major = Number(process.versions.node.split(".")[0]);
	return major >= 12;
};
