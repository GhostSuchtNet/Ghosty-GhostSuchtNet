require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { createAuth } = require("./auth");

const app = express();
const auth = createAuth();

const PORT = Number(process.env.PORT || 3100);
const LEGACY_PORT = Number(process.env.GHOSTY_LEGACY_PORT || 3010);
const LEGACY_HOST = "127.0.0.1";
const LEGACY_BASE = `http://${LEGACY_HOST}:${LEGACY_PORT}`;
const LEGACY_SERVER = path.join(__dirname, "server-before-auth.js");

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

const MODEL_ORDER_TEXT = ["gemini", "qwen-cloud", "gpt-oss", "local-qwen"];
const MODEL_ORDER_VISION = ["gemini", "qwen-cloud", "local-qwen"];

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Origin nicht erlaubt"));
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
}));

const jsonBody = express.json({ limit: "2mb" });
const visionUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});

function allowedModelIdsFromAuth(req) {
    const ids = new Set();
    for (const id of MODEL_ORDER_TEXT) {
        if (req.auth?.permissions?.has(`model.${id}`)) ids.add(id);
    }
    return ids;
}

function copyResponseHeaders(sourceHeaders, res) {
    for (const [name, value] of Object.entries(sourceHeaders || {})) {
        if (value == null) continue;
        const lower = name.toLowerCase();
        if ([
            "connection",
            "keep-alive",
            "transfer-encoding",
            "content-length",
            "access-control-allow-origin",
            "access-control-allow-credentials"
        ].includes(lower)) continue;
        try { res.setHeader(name, value); } catch {}
    }
}

function proxyHeaders(req) {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.cookie;
    delete headers.authorization;
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];
    return headers;
}

function rawLegacyProxy(req, res) {
    const proxyReq = http.request({
        host: LEGACY_HOST,
        port: LEGACY_PORT,
        method: req.method,
        path: req.originalUrl,
        headers: proxyHeaders(req)
    }, proxyRes => {
        res.status(proxyRes.statusCode || 502);
        copyResponseHeaders(proxyRes.headers, res);
        proxyRes.pipe(res);
    });

    proxyReq.on("error", error => {
        console.error("[Legacy Proxy]", error.message);
        if (!res.headersSent) {
            res.status(502).json({ error: "Ghosty-Tool-Backend ist derzeit nicht erreichbar." });
        } else if (!res.writableEnded) {
            res.end();
        }
    });

    req.pipe(proxyReq);
}

async function legacyJson(pathname, body, signal) {
    const response = await fetch(`${LEGACY_BASE}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { error: text || `HTTP ${response.status}` }; }
    return { response, data };
}

function chooseAllowedAvailableModels(req, models, visionOnly = false) {
    const allowed = allowedModelIdsFromAuth(req);
    const byId = new Map((models || []).map(model => [model.id, model]));
    const order = visionOnly ? MODEL_ORDER_VISION : MODEL_ORDER_TEXT;
    return order.filter(id => allowed.has(id) && byId.get(id)?.available && (!visionOnly || byId.get(id)?.vision));
}

async function getLegacyModels(signal) {
    const response = await fetch(`${LEGACY_BASE}/api/ai/models`, { signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Legacy models HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data.models || [];
}

function createRequestSignal(req, res) {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) controller.abort();
    };
    req.once("aborted", abort);
    res.once("close", () => {
        if (!res.writableEnded) abort();
    });
    return controller.signal;
}

/* ========================= AUTH ========================= */

app.get("/api/auth/status", async (req, res, next) => {
    try { return await auth.status(req, res); }
    catch (error) { next(error); }
});

app.post("/api/auth/login", jsonBody, async (req, res, next) => {
    try { return await auth.login(req, res); }
    catch (error) { next(error); }
});

app.post("/api/auth/logout", async (req, res, next) => {
    try { return await auth.logout(req, res); }
    catch (error) { next(error); }
});

app.get("/api/auth/me", async (req, res, next) => {
    try { return await auth.state(req, res); }
    catch (error) { next(error); }
});

/* ========================= PUBLIC HEALTH ========================= */

app.get("/api/ai/health", rawLegacyProxy);

/* ========================= MODELS ========================= */

app.get(
    "/api/ai/models",
    auth.authMiddleware,
    auth.requirePermission("feature.chat"),
    async (req, res) => {
        try {
            const models = await getLegacyModels();
            const allowed = allowedModelIdsFromAuth(req);
            const filtered = models.filter(model => model.id !== "auto" && allowed.has(model.id));
            const availableAllowed = filtered.filter(model => model.available);
            const auto = {
                id: "auto",
                label: "Automatisch",
                available: availableAllowed.length > 0,
                vision: availableAllowed.some(model => model.vision),
                thinkingModes: ["instant", "low", "medium", "high"],
                note: `Auto verwendet nur erlaubte Modelle: ${availableAllowed.map(model => model.label).join(" → ") || "keins verfügbar"}`
            };
            return res.json({
                models: [auto, ...filtered],
                permissions: [...req.auth.permissions]
            });
        } catch (error) {
            console.error("[Models Proxy]", error.message);
            return res.status(error.status || 502).json({ error: "Modellliste konnte nicht geladen werden." });
        }
    }
);

/* ========================= CHAT ========================= */

app.post(
    "/api/ai/chat",
    auth.authMiddleware,
    auth.requirePermission("feature.chat"),
    jsonBody,
    async (req, res) => {
        const signal = createRequestSignal(req, res);
        try {
            const requested = String(req.body?.model || "auto");
            const allowed = allowedModelIdsFromAuth(req);

            if (requested !== "auto" && !allowed.has(requested)) {
                return res.status(403).json({ error: "Dein Zugangscode darf dieses Modell nicht verwenden." });
            }

            let candidates = [requested];
            if (requested === "auto") {
                const models = await getLegacyModels(signal);
                candidates = chooseAllowedAvailableModels(req, models, false);
                if (!candidates.length) {
                    return res.status(503).json({ error: "Für deinen Zugangscode ist aktuell kein KI-Modell verfügbar." });
                }
            }

            const attempts = [];
            for (const model of candidates) {
                const { response, data } = await legacyJson("/api/ai/chat", { ...req.body, model }, signal);
                if (response.ok) {
                    return res.status(response.status).json({
                        ...data,
                        selectedModel: requested
                    });
                }
                attempts.push({ model, status: response.status });
                if (requested !== "auto") {
                    return res.status(response.status).json(data);
                }
            }

            return res.status(503).json({
                error: "Zurzeit ist kein erlaubtes KI-Modell erreichbar.",
                attempts
            });
        } catch (error) {
            if (signal.aborted || res.writableEnded) return;
            console.error("[Chat Proxy]", error.message);
            return res.status(502).json({ error: "Ghosty-Chat-Backend ist derzeit nicht erreichbar." });
        }
    }
);

/* ========================= VISION ========================= */

app.post(
    "/api/ai/vision",
    auth.authMiddleware,
    auth.requirePermission("feature.vision"),
    visionUpload.single("image"),
    async (req, res) => {
        const signal = createRequestSignal(req, res);
        try {
            if (!req.file) return res.status(400).json({ error: "Kein Bild hochgeladen." });

            const requested = String(req.body?.model || "auto");
            const allowed = allowedModelIdsFromAuth(req);
            if (requested !== "auto" && !allowed.has(requested)) {
                return res.status(403).json({ error: "Dein Zugangscode darf dieses Modell nicht verwenden." });
            }
            if (requested === "gpt-oss") {
                return res.status(400).json({ error: "GPT-OSS 120B unterstützt keine Bilder." });
            }

            let candidates = [requested];
            if (requested === "auto") {
                const models = await getLegacyModels(signal);
                candidates = chooseAllowedAvailableModels(req, models, true);
                if (!candidates.length) {
                    return res.status(503).json({ error: "Für deinen Zugangscode ist aktuell kein Bildmodell verfügbar." });
                }
            }

            const attempts = [];
            for (const model of candidates) {
                const form = new FormData();
                for (const [key, value] of Object.entries(req.body || {})) {
                    if (key !== "model" && value != null) form.append(key, String(value));
                }
                form.append("model", model);
                form.append(
                    "image",
                    new Blob([req.file.buffer], { type: req.file.mimetype }),
                    req.file.originalname || "image"
                );

                const response = await fetch(`${LEGACY_BASE}/api/ai/vision`, {
                    method: "POST",
                    body: form,
                    signal
                });
                const data = await response.json().catch(() => ({}));
                if (response.ok) {
                    return res.status(response.status).json({
                        ...data,
                        selectedModel: requested
                    });
                }
                attempts.push({ model, status: response.status });
                if (requested !== "auto") return res.status(response.status).json(data);
            }

            return res.status(503).json({
                error: "Zurzeit ist kein erlaubtes Bildmodell erreichbar.",
                attempts
            });
        } catch (error) {
            if (signal.aborted || res.writableEnded) return;
            console.error("[Vision Proxy]", error.message);
            return res.status(502).json({ error: "Ghosty-Bild-Backend ist derzeit nicht erreichbar." });
        }
    }
);

/* ========================= LEGACY TOOLS =========================
   Alle alten Tool-Endpunkte bleiben exakt in server-before-auth.js.
   Sie sind nur lokal auf 127.0.0.1:3010 erreichbar. Öffentlich läuft
   jede Anfrage zuerst durch dieses Auth-Gateway.
   ================================================================= */

app.use(
    "/api/ai",
    auth.authMiddleware,
    auth.requirePermission("feature.chat"),
    rawLegacyProxy
);

/* ========================= ERROR HANDLER ========================= */

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ error: "Die Datei überschreitet das erlaubte Größenlimit." });
        }
        return res.status(400).json({ error: `Upload fehlgeschlagen: ${err.code}` });
    }
    if (err.message === "Origin nicht erlaubt") {
        return res.status(403).json({ error: "Origin nicht erlaubt." });
    }
    console.error(err);
    return res.status(500).json({ error: "Interner Serverfehler." });
});

/* ========================= PRIVATE LEGACY PROCESS ========================= */

const legacy = spawn(process.execPath, [LEGACY_SERVER], {
    cwd: __dirname,
    env: {
        ...process.env,
        PORT: String(LEGACY_PORT)
    },
    stdio: ["ignore", "pipe", "pipe"]
});

legacy.stdout.on("data", chunk => {
    process.stdout.write(`[legacy-tools] ${chunk}`);
});
legacy.stderr.on("data", chunk => {
    process.stderr.write(`[legacy-tools] ${chunk}`);
});
legacy.on("exit", (code, signal) => {
    if (code !== 0 && signal == null) {
        console.error(`[legacy-tools] Prozess beendet (Code ${code}).`);
    }
});
legacy.on("error", error => {
    console.error("[legacy-tools] Start fehlgeschlagen:", error.message);
});

let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!legacy.killed) legacy.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    setTimeout(() => process.exit(0), 250).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", () => {
    if (!legacy.killed) legacy.kill("SIGTERM");
});

app.listen(PORT, "127.0.0.1", () => {
    console.log(`Ghosty Auth Gateway läuft auf http://127.0.0.1:${PORT}`);
    console.log(`Legacy Tool Backend: ${LEGACY_BASE}`);
    console.log("Ghosty Zugangsschutz: aktiv");
});
