"use strict";

const {
    getTool,
    toolsForCategories
} = require("./registry");

const { classifyRequest } = require("./classifiers");
const { preflight } = require("./preflight");
const { runResource } = require("./scheduler");
const { chooseModel } = require("./model-router");
const { samplingFor } = require("./sampling");
const { thinkingFor } = require("./thinking");

async function executeMatchedTool(
    tool,
    request,
    context,
    match
) {
    if (
        typeof tool.validateInput === "function" &&
        !tool.validateInput(match, request)
    ) {
        return {
            ok: false,
            status: 400,
            error: "Tool-Parameter sind ungültig."
        };
    }

    const result = await runResource(
        tool.resource,
        () => tool.execute(request, context, match),
        context.abortSignal
    );

    if (
        typeof tool.validateOutput === "function" &&
        !tool.validateOutput(result)
    ) {
        return {
            ok: false,
            status: 502,
            error: "Ungültiges Tool-Ergebnis."
        };
    }

    return result;
}

async function routeRequest(request, context) {
    const safety = preflight(request);

    if (!safety.ok) {
        return {
            route: "rejected",
            status: safety.status || 400,
            result: safety
        };
    }

    const classification = classifyRequest(request);

    /*
     * Explizit erzwungenes Tool.
     */
    if (request.forceTool) {
        const tool = getTool(request.forceTool);

        if (!tool) {
            return {
                route: "rejected",
                status: 400,
                result: {
                    error: "Unbekanntes Tool."
                }
            };
        }

        if (
            tool.permission &&
            !context.isToolAllowed(tool.permission)
        ) {
            return {
                route: "rejected",
                status: 403,
                result: {
                    error: "Tool nicht erlaubt."
                }
            };
        }

        const match = await tool.match(
            request,
            context,
            classification
        );

        const result = await executeMatchedTool(
            tool,
            request,
            context,
            match
        );

        return {
            route: "tool-only",
            classification,
            tool: tool.id,
            result
        };
    }

    const candidates = toolsForCategories(
        classification.categories
    );

    const matches = [];

    for (const tool of candidates) {
        if (
            tool.permission &&
            !context.isToolAllowed(tool.permission)
        ) {
            continue;
        }

        try {
            const match = await tool.match(
                request,
                context,
                classification
            );

            if (
                match?.matched &&
                Number(match.confidence) > 0
            ) {
                matches.push({
                    tool,
                    match
                });
            }
        } catch (error) {
            context.logger?.warn?.(
                `Tool-Matcher ${tool.id}: ${error.message}`
            );
        }
    }

    matches.sort(
        (a, b) =>
            Number(b.match.confidence) -
            Number(a.match.confidence)
    );

    const best = matches[0];

    if (
        best &&
        best.match.confidence >= 0.95 &&
        (!best.match.missing ||
            best.match.missing.length === 0)
    ) {
        const result = await executeMatchedTool(
            best.tool,
            request,
            context,
            best.match
        );

        if (
            result.ok &&
            result.complete &&
            !result.llm?.required
        ) {
            return {
                route: "tool-only",
                classification,
                tool: best.tool.id,
                result
            };
        }

        if (result.ok) {
            const model = chooseModel({
                requestedModel:
                    request.model || "auto",
                classification,
                allowedModels:
                    context.allowedModels
            });

            return {
                route: "tool-llm",
                classification,
                tool: best.tool.id,
                model,
                result,
                thinking:
                    result.llm?.thinking ||
                    thinkingFor(
                        classification,
                        result
                    ),
                sampling: samplingFor(
                    result.llm?.creativity ||
                    classification.creativity
                )
            };
        }
    }

    const model = chooseModel({
        requestedModel:
            request.model || "auto",
        classification,
        allowedModels:
            context.allowedModels
    });

    return {
        route: "llm",
        classification,
        model,
        result: null,
        thinking: thinkingFor(classification),
        sampling: samplingFor(
            classification.creativity
        )
    };
}

module.exports = { routeRequest };
