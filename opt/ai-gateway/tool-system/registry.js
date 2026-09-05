"use strict";

const tools = new Map();

function register(tool) {
    if (!tool || typeof tool !== "object") {
        throw new Error("Ungültiges Tool.");
    }

    if (!tool.id || typeof tool.id !== "string") {
        throw new Error("Tool besitzt keine ID.");
    }

    if (tools.has(tool.id)) {
        throw new Error(`Tool doppelt registriert: ${tool.id}`);
    }

    if (typeof tool.match !== "function") {
        throw new Error(`Tool ${tool.id}: match() fehlt.`);
    }

    if (typeof tool.execute !== "function") {
        throw new Error(`Tool ${tool.id}: execute() fehlt.`);
    }

    tool.categories = Array.isArray(tool.categories)
        ? tool.categories
        : ["utility"];

    tool.resource = tool.resource || "light";

    tools.set(tool.id, tool);
    return tool;
}

function getTool(id) {
    return tools.get(id) || null;
}

function allTools() {
    return [...tools.values()];
}

function toolsForCategories(categories = []) {
    const requested = new Set(categories);

    return allTools().filter(tool =>
        tool.categories.some(category => requested.has(category))
    );
}

module.exports = {
    register,
    getTool,
    allTools,
    toolsForCategories
};
