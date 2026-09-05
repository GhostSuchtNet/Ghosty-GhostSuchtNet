"use strict";

function chooseModel({
    requestedModel = "auto",
    classification,
    allowedModels
}) {
    const allowed = allowedModels instanceof Set
        ? allowedModels
        : new Set(allowedModels || []);

    if (requestedModel && requestedModel !== "auto") {
        if (!allowed.has(requestedModel)) {
            const error = new Error(
                "Das gewählte Modell ist nicht erlaubt."
            );

            error.status = 403;
            throw error;
        }

        return requestedModel;
    }

    const preferMedium =
        classification.complexity === "high" ||
        classification.complexity === "medium";

    if (
        preferMedium &&
        allowed.has("ghosty-medium")
    ) {
        return "ghosty-medium";
    }

    if (allowed.has("ghosty-lite")) {
        return "ghosty-lite";
    }

    if (allowed.has("ghosty-medium")) {
        return "ghosty-medium";
    }

    /*
     * ghosty-high ABSICHTLICH NICHT automatisch.
     * Bleibt Zukunftsplatzhalter.
     */

    const cloudFallback = [
        "qwen-cloud",
        "gemini",
        "gpt-oss"
    ];

    for (const model of cloudFallback) {
        if (allowed.has(model)) {
            return model;
        }
    }

    const error = new Error(
        "Kein erlaubtes Modell verfügbar."
    );

    error.status = 503;
    throw error;
}

module.exports = { chooseModel };
