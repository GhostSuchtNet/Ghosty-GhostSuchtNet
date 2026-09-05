"use strict";

function thinkingFor(classification, toolResult = null) {
    if (toolResult?.ok && toolResult?.data) {
        if (classification.complexity === "low") return "instant";
        if (classification.complexity === "medium") return "low";
    }

    switch (classification.complexity) {
        case "high":
            return "high";

        case "medium":
            return "medium";

        default:
            return "instant";
    }
}

module.exports = { thinkingFor };
