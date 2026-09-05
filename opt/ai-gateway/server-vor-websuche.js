require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const app = express();

const PORT = Number(process.env.PORT || 3100);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const LOCAL_AI_URL = process.env.LOCAL_AI_URL || "http://127.0.0.1:8089";
const LOCAL_AI_MODEL = process.env.LOCAL_AI_MODEL || "qwen3.5-9b-local";

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

const ALLOWED_MODELS = new Set([
    "auto",
    "gemini",
    "qwen-cloud",
    "gpt-oss",
    "local-qwen"
]);

const ALLOWED_THINKING = new Set([
    "instant",
    "low",
    "medium",
    "high"
]);

app.set("trust proxy", 1);
app.use(helmet({
    contentSecurityPolicy: false
}));
app.use(express.json({ limit: "512kb" }));

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin nicht erlaubt"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
        error: "Zu viele KI-Anfragen. Bitte kurz warten."
    }
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

function fetchWithTimeout(url, options = {}, timeoutMs = 90000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
        ...options,
        signal: controller.signal
    }).finally(() => clearTimeout(timer));
}

function createProviderError(provider, status, body) {
    const error = new Error(`${provider} API Fehler (${status})`);
    error.provider = provider;
    error.status = status;
    error.body = body;
    return error;
}

function parseJsonSafe(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return { raw };
    }
}

function validateMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 40) {
        return false;
    }

    return messages.every(message => (
        message &&
        ["user", "assistant"].includes(message.role) &&
        typeof message.content === "string" &&
        message.content.trim().length > 0 &&
        message.content.length <= 30000
    ));
}

function normalizeRequestOptions(model, thinking) {
    const selectedModel = model || "auto";
    const selectedThinking = thinking || "medium";

    if (!ALLOWED_MODELS.has(selectedModel)) {
        throw new Error("Ungültiges Modell.");
    }

    if (!ALLOWED_THINKING.has(selectedThinking)) {
        throw new Error("Ungültiger Thinking-Modus.");
    }

    return {
        model: selectedModel,
        thinking: selectedThinking
    };
}

function isAllowedImageMimeType(mimeType) {
    return [
        "image/jpeg",
        "image/png",
        "image/webp"
    ].includes(mimeType);
}

function imageDataUrl(buffer, mimeType) {
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function geminiThinkingLevel(thinking) {
    // Gemini 3.7 Flash kann Thinking nicht vollständig abschalten.
    // "instant" wird deshalb auf die schnellste unterstützte Stufe "low" abgebildet.
    if (thinking === "instant") return "low";
    return thinking;
}

function gptOssThinkingLevel(thinking) {
    // GPT-OSS unterstützt bei Groq low/medium/high, aber kein none.
    // "instant" wird deshalb auf low abgebildet.
    if (thinking === "instant") return "low";
    return thinking;
}

function localThinkingBudget(thinking) {
    switch (thinking) {
        case "instant": return 0;
        case "low": return 256;
        case "medium": return 768;
        case "high": return 1536;
        default: return 768;
    }
}

function toGeminiContents(messages, image = null) {
    const contents = messages.map(message => ({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }]
    }));

    if (image) {
        const last = contents[contents.length - 1];
        if (!last || last.role !== "user") {
            throw new Error("Bei einer Bildanfrage muss die letzte Nachricht vom Benutzer stammen.");
        }

        last.parts.push({
            inlineData: {
                mimeType: image.mimeType,
                data: image.buffer.toString("base64")
            }
        });
    }

    return contents;
}

function toOpenAiMessages(messages, systemInstruction, image = null) {
    const result = [];

    if (systemInstruction) {
        result.push({
            role: "system",
            content: systemInstruction
        });
    }

    messages.forEach((message, index) => {
        const isLast = index === messages.length - 1;

        if (image && isLast && message.role === "user") {
            result.push({
                role: "user",
                content: [
                    {
                        type: "text",
                        text: message.content
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: imageDataUrl(image.buffer, image.mimeType)
                        }
                    }
                ]
            });
        } else {
            result.push({
                role: message.role,
                content: message.content
            });
        }
    });

    return result;
}

async function callGemini(messages, systemInstruction, thinking, image = null) {
    if (!GEMINI_API_KEY) {
        throw createProviderError("Gemini", 503, "Kein Gemini API Key vorhanden.");
    }

    const body = {
        contents: toGeminiContents(messages, image),
        generationConfig: {
            maxOutputTokens: 4096,
            thinkingConfig: {
                thinkingLevel: geminiThinkingLevel(thinking)
            }
        }
    };

    if (systemInstruction) {
        body.systemInstruction = {
            parts: [{ text: systemInstruction }]
        };
    }

    const response = await fetchWithTimeout(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": GEMINI_API_KEY
            },
            body: JSON.stringify(body)
        },
        120000
    );

    const raw = await response.text();
    const data = parseJsonSafe(raw);

    if (!response.ok) {
        throw createProviderError("Gemini", response.status, data);
    }

    const text = data.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("")
        .trim();

    if (!text) {
        throw createProviderError("Gemini", 502, data);
    }

    return text;
}

async function callGroqQwen(messages, systemInstruction, thinking, image = null) {
    if (!GROQ_API_KEY) {
        throw createProviderError("Groq/Qwen", 503, "Kein Groq API Key vorhanden.");
    }

    const body = {
        model: "qwen/qwen3.8-27b",
        messages: toOpenAiMessages(messages, systemInstruction, image),
        max_completion_tokens: 4096,
        reasoning_effort: thinking === "instant" ? "none" : thinking,
        reasoning_format: "hidden"
    };

    const response = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(body)
        },
        120000
    );

    const raw = await response.text();
    const data = parseJsonSafe(raw);

    if (!response.ok) {
        throw createProviderError("Groq/Qwen", response.status, data);
    }

    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
        throw createProviderError("Groq/Qwen", 502, data);
    }

    return text;
}

async function callGroqGptOss(messages, systemInstruction, thinking) {
    if (!GROQ_API_KEY) {
        throw createProviderError("Groq/GPT-OSS", 503, "Kein Groq API Key vorhanden.");
    }

    const body = {
        model: "openai/gpt-oss-120b",
        messages: toOpenAiMessages(messages, systemInstruction),
        max_completion_tokens: 4096,
        reasoning_effort: gptOssThinkingLevel(thinking),
        include_reasoning: false
    };

    const response = await fetchWithTimeout(
        "https://api.groq.com/openai/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${GROQ_API_KEY}`
            },
            body: JSON.stringify(body)
        },
        120000
    );

    const raw = await response.text();
    const data = parseJsonSafe(raw);

    if (!response.ok) {
        throw createProviderError("Groq/GPT-OSS", response.status, data);
    }

    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
        throw createProviderError("Groq/GPT-OSS", 502, data);
    }

    return text;
}

async function callLocalQwen(messages, systemInstruction, thinking, image = null) {
    const enabledThinking = thinking !== "instant";

    const body = {
        model: LOCAL_AI_MODEL,
        messages: toOpenAiMessages(messages, systemInstruction, image),
        max_tokens: 4096,
        stream: false,
        reasoning_format: "deepseek",
        chat_template_kwargs: {
            enable_thinking: enabledThinking
        },
        thinking_budget_tokens: localThinkingBudget(thinking)
    };

    const response = await fetchWithTimeout(
        `${LOCAL_AI_URL}/v1/chat/completions`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        },
        300000
    );

    const raw = await response.text();
    const data = parseJsonSafe(raw);

    if (!response.ok) {
        throw createProviderError("Local/Qwen", response.status, data);
    }

    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
        throw createProviderError("Local/Qwen", 502, data);
    }

    return text;
}

async function localAvailable() {
    try {
        const response = await fetchWithTimeout(
            `${LOCAL_AI_URL}/v1/models`,
            { method: "GET" },
            1500
        );
        return response.ok;
    } catch {
        return false;
    }
}

function buildProviders(selectedModel, thinking, messages, systemInstruction, image = null) {
    const visionRequest = Boolean(image);

    const all = {
        gemini: {
            id: "gemini",
            provider: "Google",
            model: "gemini-3.7-flash",
            vision: true,
            run: () => callGemini(messages, systemInstruction, thinking, image)
        },
        "qwen-cloud": {
            id: "qwen-cloud",
            provider: "Groq",
            model: "qwen/qwen3.8-27b",
            vision: true,
            run: () => callGroqQwen(messages, systemInstruction, thinking, image)
        },
        "gpt-oss": {
            id: "gpt-oss",
            provider: "Groq",
            model: "openai/gpt-oss-120b",
            vision: false,
            run: () => callGroqGptOss(messages, systemInstruction, thinking)
        },
        "local-qwen": {
            id: "local-qwen",
            provider: "Lokal",
            model: "Qwen3.5-9B Q4_K_M",
            vision: true,
            run: () => callLocalQwen(messages, systemInstruction, thinking, image)
        }
    };

    if (selectedModel !== "auto") {
        const provider = all[selectedModel];
        if (!provider) return [];
        if (visionRequest && !provider.vision) return [];
        return [provider];
    }

    const order = [
        all.gemini,
        all["qwen-cloud"]
    ];

    if (!visionRequest) {
        order.push(all["gpt-oss"]);
    }

    order.push(all["local-qwen"]);

    return order;
}

async function executeRequest({
    selectedModel,
    thinking,
    messages,
    systemInstruction,
    image = null
}) {
    const providers = buildProviders(
        selectedModel,
        thinking,
        messages,
        systemInstruction,
        image
    );

    if (providers.length === 0) {
        const error = new Error("Das gewählte Modell unterstützt diese Anfrage nicht.");
        error.status = 400;
        throw error;
    }

    const attempts = [];

    for (const provider of providers) {
        if (provider.id === "gemini" && !GEMINI_API_KEY) {
            attempts.push({ model: provider.model, status: "kein-key" });
            if (selectedModel !== "auto") break;
            continue;
        }

        if (["qwen-cloud", "gpt-oss"].includes(provider.id) && !GROQ_API_KEY) {
            attempts.push({ model: provider.model, status: "kein-key" });
            if (selectedModel !== "auto") break;
            continue;
        }

        try {
            const reply = await provider.run();

            return {
                reply,
                provider: provider.provider,
                model: provider.model,
                selectedModel,
                thinkingRequested: thinking,
                thinkingEffective:
                    provider.id === "gemini" && thinking === "instant"
                        ? "low"
                        : provider.id === "gpt-oss" && thinking === "instant"
                            ? "low"
                            : thinking
            };
        } catch (error) {
            attempts.push({
                model: provider.model,
                status: error.status || "network/timeout"
            });

            console.error(`[AI] ${provider.model} fehlgeschlagen:`, {
                status: error.status,
                message: error.message,
                body: error.body
            });

            if (selectedModel !== "auto") {
                break;
            }
        }
    }

    const error = new Error("Zurzeit ist kein passendes KI-Modell erreichbar.");
    error.status = 503;
    error.attempts = attempts;
    throw error;
}

app.get("/api/ai/health", (req, res) => {
    res.json({ ok: true });
});

app.get("/api/ai/models", async (req, res) => {
    const local = await localAvailable();
    const anyVision = Boolean(GEMINI_API_KEY || GROQ_API_KEY || local);
    const anyText = Boolean(GEMINI_API_KEY || GROQ_API_KEY || local);

    res.json({
        models: [
            {
                id: "auto",
                label: "Automatisch",
                available: anyText,
                vision: anyVision,
                thinkingModes: ["instant", "low", "medium", "high"],
                note: "Text: Gemini → Qwen Cloud → GPT-OSS → Lokal; Bild: Gemini → Qwen Cloud → Lokal"
            },
            {
                id: "gemini",
                label: "Gemini 3.7 Flash",
                available: Boolean(GEMINI_API_KEY),
                vision: true,
                thinkingModes: ["instant", "low", "medium", "high"],
                note: "Instant wird technisch als Low ausgeführt, weil Gemini 3.7 Thinking nicht vollständig abschalten kann."
            },
            {
                id: "qwen-cloud",
                label: "Qwen 3.8 27B (Groq)",
                available: Boolean(GROQ_API_KEY),
                vision: true,
                thinkingModes: ["instant", "low", "medium", "high"],
                note: "Instant = Thinking wirklich aus."
            },
            {
                id: "gpt-oss",
                label: "GPT-OSS 120B (Groq)",
                available: Boolean(GROQ_API_KEY),
                vision: false,
                thinkingModes: ["instant", "low", "medium", "high"],
                note: "Keine Bilder. Instant wird technisch als Low ausgeführt."
            },
            {
                id: "local-qwen",
                label: "Qwen 3.5 9B – Lokal",
                available: local,
                vision: true,
                thinkingModes: ["instant", "low", "medium", "high"],
                note: "Instant = Thinking aus; Low/Medium/High werden lokal über Thinking-Budgets angenähert."
            }
        ]
    });
});

app.post("/api/ai/chat", aiLimiter, async (req, res) => {
    try {
        const {
            messages,
            systemInstruction = "Du bist ein hilfreicher deutschsprachiger KI-Assistent. Antworte in sauberem Markdown. Verwende für Code immer Markdown-Codeblöcke mit einer passenden Sprachangabe.",
            model = "auto",
            thinking = "medium"
        } = req.body || {};

        if (!validateMessages(messages)) {
            return res.status(400).json({
                error: "messages muss 1 bis 40 gültige user/assistant-Nachrichten enthalten."
            });
        }

        if (typeof systemInstruction !== "string" || systemInstruction.length > 6000) {
            return res.status(400).json({ error: "Ungültige systemInstruction." });
        }

        const options = normalizeRequestOptions(model, thinking);

        const result = await executeRequest({
            selectedModel: options.model,
            thinking: options.thinking,
            messages,
            systemInstruction
        });

        return res.json(result);
    } catch (error) {
        return res.status(error.status || 500).json({
            error: error.message || "Interner Serverfehler.",
            attempts: error.attempts || undefined
        });
    }
});

app.post(
    "/api/ai/vision",
    aiLimiter,
    upload.single("image"),
    async (req, res) => {
        try {
            const prompt = String(req.body?.prompt || "").trim();
            const systemInstruction = String(
                req.body?.systemInstruction ||
                "Du bist ein hilfreicher deutschsprachiger KI-Assistent. Analysiere Bilder präzise. Antworte in sauberem Markdown. Verwende für Code immer Markdown-Codeblöcke."
            );
            const model = String(req.body?.model || "auto");
            const thinking = String(req.body?.thinking || "medium");

            if (!prompt) {
                return res.status(400).json({ error: "prompt fehlt." });
            }

            if (!req.file) {
                return res.status(400).json({ error: "Kein Bild hochgeladen." });
            }

            if (!isAllowedImageMimeType(req.file.mimetype)) {
                return res.status(400).json({
                    error: "Nur JPG, PNG und WEBP sind erlaubt."
                });
            }

            if (systemInstruction.length > 6000) {
                return res.status(400).json({ error: "systemInstruction ist zu lang." });
            }

            let history = [];
            if (req.body?.history) {
                try {
                    history = JSON.parse(req.body.history);
                } catch {
                    return res.status(400).json({ error: "history ist kein gültiges JSON." });
                }
            }

            if (history.length > 0 && !validateMessages(history)) {
                return res.status(400).json({ error: "Ungültiger Chatverlauf." });
            }

            const messages = [
                ...history,
                {
                    role: "user",
                    content: prompt
                }
            ];

            const options = normalizeRequestOptions(model, thinking);

            if (options.model === "gpt-oss") {
                return res.status(400).json({
                    error: "GPT-OSS 120B unterstützt keine Bilder."
                });
            }

            const result = await executeRequest({
                selectedModel: options.model,
                thinking: options.thinking,
                messages,
                systemInstruction,
                image: {
                    buffer: req.file.buffer,
                    mimeType: req.file.mimetype
                }
            });

            return res.json(result);
        } catch (error) {
            if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
                return res.status(413).json({ error: "Das Bild darf maximal 10 MB groß sein." });
            }

            return res.status(error.status || 500).json({
                error: error.message || "Interner Serverfehler.",
                attempts: error.attempts || undefined
            });
        }
    }
);

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "Das Bild darf maximal 10 MB groß sein." });
    }

    if (err.message === "Origin nicht erlaubt") {
        return res.status(403).json({ error: "Origin nicht erlaubt." });
    }

    console.error(err);
    return res.status(500).json({ error: "Interner Serverfehler." });
});

app.listen(PORT, "127.0.0.1", () => {
    console.log(`AI Gateway läuft auf http://127.0.0.1:${PORT}`);
    console.log(`Gemini: ${GEMINI_API_KEY ? "aktiv" : "kein Key"}`);
    console.log(`Groq: ${GROQ_API_KEY ? "aktiv" : "kein Key"}`);
    console.log(`Lokale KI: ${LOCAL_AI_URL} (${LOCAL_AI_MODEL})`);
});
