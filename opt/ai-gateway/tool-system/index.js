"use strict";

const { register } = require("./registry");

register(
    require("./tools/hash-encoding-tool")
);

/*
 * Weitere Tools erst hier eintragen,
 * wenn sie einzeln getestet wurden.
 */

module.exports = {
    ...require("./registry"),
    ...require("./router"),
    ...require("./scheduler")
};
