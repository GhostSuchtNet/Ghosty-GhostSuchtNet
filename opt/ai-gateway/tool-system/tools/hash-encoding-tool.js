"use strict";

const crypto = require("crypto");
const { toolResult } = require("../result-format");

function extractQuoted(text) {
    const quoted = text.match(/["“](.+?)["”]/s);
    if (quoted) return quoted[1];

    const afterVon = text.match(/\bvon\s+(.+)$/is);
    if (afterVon) return afterVon[1].trim();

    return "";
}

module.exports = {
    id: "hash-encoding",

    categories: ["utility"],

    permission: "tool.hash",

    deterministic: true,

    resource: "light",

    match(request) {
        const text = String(request.text || "");
        const lower = text.toLowerCase();

        if (/sha-?256/.test(lower)) {
            const value = extractQuoted(text);

            return {
                matched: true,
                confidence: value ? 0.99 : 0.75,
                intent: "sha256",
                args: { value },
                missing: value ? [] : ["value"]
            };
        }

        if (/base64/.test(lower)) {
            const value = extractQuoted(text);

            return {
                matched: true,
                confidence: value ? 0.98 : 0.72,
                intent: /decod|dekod/.test(lower)
                    ? "base64-decode"
                    : "base64-encode",
                args: { value },
                missing: value ? [] : ["value"]
            };
        }

        return {
            matched: false,
            confidence: 0
        };
    },

    validateInput(match) {
        return Boolean(
            match &&
            match.args &&
            typeof match.args.value === "string" &&
            match.args.value.length <= 100000
        );
    },

    async execute(request, context, match) {
        const { intent, args } = match;

        if (intent === "sha256") {
            const digest = crypto
                .createHash("sha256")
                .update(args.value, "utf8")
                .digest("hex");

            return toolResult({
                tool: "hash-encoding",
                confidence: match.confidence,
                text: digest,
                data: {
                    algorithm: "sha256",
                    digest
                }
            });
        }

        if (intent === "base64-encode") {
            const encoded = Buffer
                .from(args.value, "utf8")
                .toString("base64");

            return toolResult({
                tool: "hash-encoding",
                confidence: match.confidence,
                text: encoded,
                data: { encoded }
            });
        }

        if (intent === "base64-decode") {
            const decoded = Buffer
                .from(args.value, "base64")
                .toString("utf8");

            return toolResult({
                tool: "hash-encoding",
                confidence: match.confidence,
                text: decoded,
                data: { decoded }
            });
        }

        return toolResult({
            ok: false,
            tool: "hash-encoding",
            complete: true,
            error: "Nicht unterstützte Operation."
        });
    },

    validateOutput(result) {
        return Boolean(
            result &&
            typeof result.ok === "boolean"
        );
    }
};
