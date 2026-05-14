"use strict";

// `experiments.html` test setup uses ESM `import` in test code, which
// requires Jest's ESM support (`--experimental-vm-modules`, Node 12+).
module.exports = function filter() {
	const major = Number(process.versions.node.split(".")[0]);
	return major >= 12;
};
