const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.GHOSTY_LOCAL_CONCURRENCY || 2)));

const CONFIG = {
    "ghosty-lite": {
        id: "ghosty-lite",
        label: "Ghosty Lite · Qwen 3.5 4B",
        url: process.env.GHOSTY_LITE_URL || "http://127.0.0.1:8091",
        model: process.env.GHOSTY_LITE_MODEL || "ghosty-lite",
        vision: false,
        maxMessages: 6,
        maxChars: 8000,
        maxSystemChars: 4000,
        maxOutputTokens: 512,
        thinking: { instant: 0, low: 32, medium: 64, high: 128 },
        concurrency: DEFAULT_CONCURRENCY
    },
    "ghosty-medium": {
        id: "ghosty-medium",
        label: "Ghosty Medium · Qwen 3.5 9B",
        url: process.env.GHOSTY_MEDIUM_URL || process.env.LOCAL_AI_URL || "http://127.0.0.1:8089",
        model: process.env.GHOSTY_MEDIUM_MODEL || "ghosty-medium",
        vision: true,
        maxMessages: 24,
        maxChars: 50000,
        maxSystemChars: 30000,
        maxOutputTokens: 1536,
        thinking: { instant: 0, low: 64, medium: 128, high: 256 },
        concurrency: DEFAULT_CONCURRENCY
    },
    "ghosty-high": {
        id: "ghosty-high",
        label: "Ghosty High",
        url: process.env.GHOSTY_HIGH_URL || "",
        model: process.env.GHOSTY_HIGH_MODEL || "ghosty-high",
        vision: String(process.env.GHOSTY_HIGH_VISION || "").toLowerCase() === "true",
        maxMessages: 32,
        maxChars: 90000,
        maxSystemChars: 60000,
        maxOutputTokens: 2048,
        thinking: { instant: 0, low: 128, medium: 256, high: 512 },
        concurrency: Math.max(1, Math.min(4, Number(process.env.GHOSTY_HIGH_CONCURRENCY || DEFAULT_CONCURRENCY)))
    }
};

class ModelQueue {
    constructor(limit) {
        this.limit = limit;
        this.active = 0;
        this.waiting = [];
        this.maxWaiting = 20;
    }

    async run(task, signal) {
        await this.acquire(signal);
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    acquire(signal) {
        if (signal?.aborted) {
            return Promise.reject(Object.assign(new Error("Anfrage abgebrochen."), { name: "AbortError", status: 499 }));
        }

        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }

        if (this.waiting.length >= this.maxWaiting) {
            const error = new Error("Das lokale Modell ist gerade ausgelastet. Bitte kurz warten.");
            error.status = 503;
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, signal, onAbort: null };
            if (signal) {
                entry.onAbort = () => {
                    const index = this.waiting.indexOf(entry);
                    if (index >= 0) this.waiting.splice(index, 1);
                    reject(Object.assign(new Error("Anfrage abgebrochen."), { name: "AbortError", status: 499 }));
                };
                signal.addEventListener("abort", entry.onAbort, { once: true });
            }
            this.waiting.push(entry);
        });
    }

    release() {
        while (this.waiting.length) {
            const next = this.waiting.shift();
            if (next.signal?.aborted) continue;
            if (next.signal && next.onAbort) {
                next.signal.removeEventListener("abort", next.onAbort);
            }
            next.resolve();
            return;
        }
        this.active = Math.max(0, this.active - 1);
    }

    snapshot() {
        return {
            active: this.active,
            waiting: this.waiting.length,
            limit: this.limit
        };
    }
}

const queues = Object.fromEntries(
    Object.entries(CONFIG).map(([id, config]) => [id, new ModelQueue(config.concurrency)])
);

function configFor(id) {
    const config = CONFIG[id];
    if (!config) {
        const error = new Error("Unbekanntes lokales Modell.");
        error.status = 400;
        throw error;
    }
    return config;
}

function trimMessages(messages, config) {
    const source = Array.isArray(messages) ? messages : [];
    const selected = [];
    let used = 0;

    for (let i = source.length - 1; i >= 0 && selected.length < config.maxMessages; i -= 1) {
        const message = source[i];
        if (!message || !["user", "assistant"].includes(message.role)) continue;
        const content = String(message.content || "").trim();
        if (!content) continue;

        const remaining = config.maxChars - used;
        if (remaining <= 0) break;

        const clipped = content.length > remaining
            ? content.slice(content.length - remaining)
            : content;

        selected.push({ role: message.role, content: clipped });
        used += clipped.length;
    }

    selected.reverse();
    return selected;
}

function buildMessages(body, config, image = null) {
    const messages = trimMessages(body?.messages, config);
    const clientInstruction = String(body?.systemInstruction || "").slice(0, config.maxSystemChars);
    const now = new Date();
    const serverInstruction = [
        "Du bist Ghosty, ein hilfreicher KI-Assistent. Antworte in der Sprache des Benutzers und in sauberem Markdown.",
        `Aktuelles Serverdatum: ${now.toISOString().slice(0, 10)}.`,
        body?.webStatus === "used"
            ? "Für diese Anfrage wurden aktuelle Webdaten bereitgestellt."
            : body?.webStatus === "failed"
                ? "Die Websuche ist für diese Anfrage technisch fehlgeschlagen."
                : "",
        clientInstruction
    ].filter(Boolean).join("\n\n").slice(0, config.maxSystemChars);

    const result = [];
    if (serverInstruction) {
        result.push({ role: "system", content: serverInstruction });
    }
    result.push(...messages);

    if (image) {
        const last = result[result.length - 1];
        if (!last || last.role !== "user") {
            const error = new Error("Bei einer Bildanfrage muss die letzte Nachricht vom Benutzer stammen.");
            error.status = 400;
            throw error;
        }

        last.content = [
            { type: "text", text: String(last.content) },
            {
                type: "image_url",
                image_url: {
                    url: `data:${image.mimeType};base64,${image.buffer.toString("base64")}`
                }
            }
        ];
    }

    return result;
}

function thinkingBudget(config, thinking) {
    return config.thinking[thinking] ?? config.thinking.medium;
}

async function fetchJson(url, options, timeoutMs = 600000) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);

    const externalSignal = options.signal;
    const onAbort = () => timeoutController.abort();
    if (externalSignal) {
        if (externalSignal.aborted) timeoutController.abort();
        else externalSignal.addEventListener("abort", onAbort, { once: true });
    }

    try {
        const response = await fetch(url, {
            ...options,
            signal: timeoutController.signal
        });
        const raw = await response.text();
        let data;
        try { data = JSON.parse(raw); }
        catch { data = { error: raw || `HTTP ${response.status}` }; }
        return { response, data };
    } finally {
        clearTimeout(timeout);
        if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
    }
}

async function available(id, signal) {
    const config = configFor(id);
    if (!config.url) return false;

    try {
        const { response } = await fetchJson(
            `${config.url}/v1/models`,
            { method: "GET", signal },
            2500
        );
        return response.ok;
    } catch {
        return false;
    }
}

async function listModels(signal) {
    const result = [];
    for (const id of ["ghosty-lite", "ghosty-medium", "ghosty-high"]) {
        const config = CONFIG[id];
        const isAvailable = await available(id, signal);
        result.push({
            id,
            label: config.label,
            available: isAvailable,
            vision: config.vision,
            thinkingModes: ["instant", "low", "medium", "high"],
            note: id === "ghosty-lite"
                ? "Schnelles lokales Modell mit stark reduziertem Kontext."
                : id === "ghosty-medium"
                    ? "Stärkeres lokales Modell; Vision aktiv; Kontext nur moderat reduziert."
                    : "Reserviert für ein späteres größeres lokales Modell."
        });
    }
    return result;
}

async function chat(id, body, signal, image = null) {
    const config = configFor(id);
    if (!config.url) {
        const error = new Error(`${config.label} ist noch nicht konfiguriert.`);
        error.status = 503;
        throw error;
    }
    if (image && !config.vision) {
        const error = new Error(`${config.label} unterstützt aktuell keine Bilder.`);
        error.status = 400;
        throw error;
    }

    const thinking = ["instant", "low", "medium", "high"].includes(body?.thinking)
        ? body.thinking
        : "medium";

    const requestBody = {
        model: config.model,
        messages: buildMessages(body, config, image),
        max_tokens: config.maxOutputTokens,
        stream: false,
        reasoning_format: "deepseek",
        chat_template_kwargs: {
            enable_thinking: thinking !== "instant"
        },
        thinking_budget_tokens: thinkingBudget(config, thinking)
    };

    return queues[id].run(async () => {
        const { response, data } = await fetchJson(
            `${config.url}/v1/chat/completions`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(requestBody),
                signal
            },
            600000
        );

        if (!response.ok) {
            const error = new Error(
                data?.error?.message ||
                data?.error ||
                `${config.label} HTTP ${response.status}`
            );
            error.status = response.status;
            error.body = data;
            throw error;
        }

        const reply = data?.choices?.[0]?.message?.content?.trim();
        if (!reply) {
            const error = new Error(`${config.label} hat keine Antwort geliefert.`);
            error.status = 502;
            throw error;
        }

        return {
            reply,
            provider: "Lokal",
            model: config.label,
            selectedModel: id,
            thinkingRequested: thinking,
            thinkingEffective: thinking,
            queue: queues[id].snapshot()
        };
    }, signal);
}

async function vision(id, body, image, signal) {
    return chat(id, body, signal, image);
}

function isLocalModel(id) {
    return Object.prototype.hasOwnProperty.call(CONFIG, id);
}

function queueState() {
    return Object.fromEntries(
        Object.entries(queues).map(([id, queue]) => [id, queue.snapshot()])
    );
}

module.exports = {
    isLocalModel,
    listModels,
    chat,
    vision,
    queueState
};
