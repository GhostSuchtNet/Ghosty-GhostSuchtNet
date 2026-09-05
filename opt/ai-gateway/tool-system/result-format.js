"use strict";

function toolResult({
    ok = true,
    tool = "",
    confidence = 1,
    complete = true,
    data = null,
    text = "",
    artifacts = [],
    llm = null,
    error = null,
    meta = {}
} = {}) {
    return {
        ok: Boolean(ok),
        tool: String(tool || ""),
        confidence: Number.isFinite(Number(confidence))
            ? Math.max(0, Math.min(1, Number(confidence)))
            : 0,
        complete: Boolean(complete),
        data,
        text: String(text || ""),
        artifacts: Array.isArray(artifacts) ? artifacts : [],
        llm: llm && typeof llm === "object"
            ? {
                required: Boolean(llm.required),
                tier: ["lite", "medium", "high"].includes(llm.tier)
                    ? llm.tier
                    : "lite",
                reason: String(llm.reason || ""),
                thinking: ["instant", "low", "medium", "high"].includes(llm.thinking)
                    ? llm.thinking
                    : "instant",
                creativity: String(llm.creativity || "auto")
            }
            : null,
        error: error ? String(error) : null,
        meta: meta && typeof meta === "object" ? meta : {}
    };
}

module.exports = { toolResult };
