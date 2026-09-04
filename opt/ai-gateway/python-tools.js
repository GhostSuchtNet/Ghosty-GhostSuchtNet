"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SANDBOX_IMAGE = process.env.PYTHON_SANDBOX_IMAGE || "ghost-ai-python-sandbox:1";
const ARTIFACT_ROOT = process.env.ARTIFACT_ROOT || "/var/lib/ghost-ai/artifacts";
const ARTIFACT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ARTIFACTS = new Set([".png", ".svg", ".csv", ".txt", ".json", ".srt", ".vtt", ".mmd"]);
const MIME_BY_EXTENSION = Object.freeze({
    ".png": "image/png", ".svg": "image/svg+xml", ".csv": "text/csv; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".srt": "application/x-subrip; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
    ".mmd": "text/plain; charset=utf-8"
});
let runningSandboxes = 0;
const MAX_CONCURRENT_SANDBOXES = 2;

fs.mkdirSync(ARTIFACT_ROOT, { recursive: true, mode: 0o750 });

function safeFilename(value) {
    return path.basename(String(value || "ergebnis.txt")).replace(/[^\p{L}\p{N}._()\- ]/gu, "_").slice(0, 120) || "ergebnis.txt";
}

function removeArtifactDirectory(directory) {
    try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isFile() || entry.isSymbolicLink()) fs.unlinkSync(path.join(directory, entry.name));
        }
        fs.rmdirSync(directory);
    } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") console.error("[Artifacts] Bereinigung fehlgeschlagen:", error.message);
    }
}

function cleanupOldArtifacts() {
    let entries = [];
    try { entries = fs.readdirSync(ARTIFACT_ROOT, { withFileTypes: true }); } catch { return; }
    const cutoff = Date.now() - ARTIFACT_MAX_AGE_MS;
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
        const directory = path.join(ARTIFACT_ROOT, entry.name);
        try {
            if (fs.statSync(directory).mtimeMs < cutoff) removeArtifactDirectory(directory);
        } catch {}
    }
}
cleanupOldArtifacts();
const cleanupTimer = setInterval(cleanupOldArtifacts, 60 * 60 * 1000);
cleanupTimer.unref();

function dockerArguments(name) {
    return [
        "run", "--rm", "-i", "--name", name,
        "--network", "none", "--read-only", "--user", "65534:65534",
        "--cpus", "1", "--memory", "512m", "--memory-swap", "512m",
        "--pids-limit", "64", "--ulimit", "nofile=128:128",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--tmpfs", "/work:rw,nosuid,nodev,size=128m,mode=700,uid=65534,gid=65534",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=700,uid=65534,gid=65534",
        "-e", "HOME=/tmp", "-e", "MPLCONFIGDIR=/tmp/matplotlib",
        "-e", "OPENBLAS_NUM_THREADS=1", "-e", "OMP_NUM_THREADS=1",
        SANDBOX_IMAGE
    ];
}

function runDocker(payload, timeoutSeconds = 10, signal = null) {
    return new Promise((resolve, reject) => {
        const containerName = `ghost-ai-python-${crypto.randomUUID()}`;
        const child = spawn("docker", dockerArguments(containerName), { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
        const stdout = [];
        const stderr = [];
        let outputBytes = 0;
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            error ? reject(error) : resolve(value);
        };
        const killContainer = () => {
            child.kill("SIGKILL");
            const cleanup = spawn("docker", ["rm", "-f", containerName], { stdio: "ignore", env: { PATH: process.env.PATH || "/usr/bin:/bin" } });
            cleanup.unref();
        };
        const abort = () => {
            killContainer();
            const error = new Error("Python-Ausführung abgebrochen.");
            error.name = "AbortError";
            finish(error);
        };
        const timer = setTimeout(() => {
            killContainer();
            const error = new Error("Python-Zeitlimit überschritten.");
            error.code = "PYTHON_TIMEOUT";
            finish(error);
        }, Math.min(30, Math.max(1, Number(timeoutSeconds) || 10)) * 1000);
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", chunk => {
            outputBytes += chunk.length;
            if (outputBytes <= 12 * 1024 * 1024) stdout.push(chunk);
            else killContainer();
        });
        child.stderr.on("data", chunk => {
            if (Buffer.concat(stderr).length < 120000) stderr.push(chunk);
        });
        child.on("error", error => finish(error));
        child.on("close", code => {
            if (settled) return;
            if (outputBytes > 12 * 1024 * 1024) return finish(new Error("Python-Ausgabe überschreitet das erlaubte Limit."));
            if (code !== 0) return finish(new Error(`Python-Sandbox fehlgeschlagen: ${Buffer.concat(stderr).toString("utf8").slice(-1000) || `Exit ${code}`}`));
            try {
                finish(null, JSON.parse(Buffer.concat(stdout).toString("utf8")));
            } catch {
                finish(new Error("Python-Sandbox lieferte kein gültiges Ergebnis."));
            }
        });
        child.stdin.end(JSON.stringify(payload));
    });
}

function persistArtifacts(artifacts) {
    if (!Array.isArray(artifacts) || !artifacts.length) return [];
    const id = crypto.randomUUID();
    const directory = path.join(ARTIFACT_ROOT, id);
    fs.mkdirSync(directory, { mode: 0o750 });
    const stored = [];
    let total = 0;
    for (const artifact of artifacts.slice(0, 10)) {
        const name = safeFilename(artifact.name);
        const extension = path.extname(name).toLowerCase();
        if (!ALLOWED_ARTIFACTS.has(extension)) continue;
        const data = Buffer.from(String(artifact.data || ""), "base64");
        if (!data.length || data.length > 5 * 1024 * 1024 || total + data.length > 10 * 1024 * 1024) continue;
        fs.writeFileSync(path.join(directory, name), data, { mode: 0o640, flag: "wx" });
        total += data.length;
        stored.push({ name, size: data.length, mime: MIME_BY_EXTENSION[extension], url: `/api/ai/artifacts/${id}/${encodeURIComponent(name)}` });
    }
    if (!stored.length) removeArtifactDirectory(directory);
    return stored;
}

async function executePythonSandbox({ code, inputs = [], timeoutSeconds = 10, signal = null }) {
    if (runningSandboxes >= MAX_CONCURRENT_SANDBOXES) {
        const error = new Error("Alle Python-Sandboxen sind gerade belegt. Bitte kurz warten.");
        error.status = 429;
        throw error;
    }
    runningSandboxes += 1;
    try {
        const result = await runDocker({ code: String(code || ""), inputs }, timeoutSeconds, signal);
        return { ...result, artifacts: result.ok ? persistArtifacts(result.artifacts) : [] };
    } finally {
        runningSandboxes -= 1;
    }
}

function resolveArtifact(id, requestedName) {
    if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) return null;
    const requested = String(requestedName || "");
    const name = safeFilename(requested);
    if (name !== requested) return null;
    const extension = path.extname(name).toLowerCase();
    if (!ALLOWED_ARTIFACTS.has(extension)) return null;
    const fullPath = path.join(ARTIFACT_ROOT, id, name);
    if (!fullPath.startsWith(`${ARTIFACT_ROOT}${path.sep}`) || !fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
    return { fullPath, name, mime: MIME_BY_EXTENSION[extension] };
}

module.exports = { SANDBOX_IMAGE, executePythonSandbox, persistArtifacts, resolveArtifact };
