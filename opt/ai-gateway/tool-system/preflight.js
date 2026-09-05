"use strict";

function preflight(request = {}) {
    const text = String(request.text || "");

    if (text.length > 120000) {
        return {
            ok: false,
            status: 413,
            error: "Die Anfrage ist zu groß."
        };
    }

    const files = Array.isArray(request.files)
        ? request.files
        : [];

    if (files.length > 20) {
        return {
            ok: false,
            status: 413,
            error: "Zu viele Dateien."
        };
    }

    return {
        ok: true
    };
}

module.exports = { preflight };
