"use strict";

const path = require("path");
const JSZip = require("jszip");

const PROJECT_LIMITS = Object.freeze({ maxZipBytes: 50 * 1024 * 1024, maxUncompressedBytes: 200 * 1024 * 1024, maxFiles: 3000, maxTextFileBytes: 2 * 1024 * 1024, maxContextChars: 42000, maxSelectedChunks: 18 });
const IGNORED = /(^|\/)(?:node_modules|\.git|\.gradle|build|dist|bin|obj|target|coverage|cache|\.cache|\.idea|\.vscode)(?:\/|$)/i;
const SECRET_FILE = /(^|\/)(?:\.env(?:\..*)?|credentials\.json|id_rsa(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const NESTED_ARCHIVE = /\.(?:zip|7z|rar|tar|tgz|gz|bz2|xz|jar|war)$/i;
const TEXT_EXT = new Set([".html", ".htm", ".css", ".scss", ".sass", ".less", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".java", ".kt", ".kts", ".py", ".php", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs", ".go", ".rs", ".sql", ".json", ".yaml", ".yml", ".xml", ".md", ".txt", ".sh", ".bash", ".zsh", ".toml", ".ini", ".conf", ".properties", ".gradle", ".vue", ".svelte"]);
const LANGUAGE = { ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".py": "Python", ".php": "PHP", ".c": "C", ".h": "C/C++", ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".go": "Go", ".rs": "Rust", ".sql": "SQL", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".xml": "XML", ".md": "Markdown", ".sh": "Shell", ".bash": "Shell" };
let projectActive = 0;
const projectQueue = [];

function acquireProject(signal) {
    if (projectActive < 1) { projectActive += 1; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
        const job = { resolve, reject };
        job.abort = () => {
            const index = projectQueue.indexOf(job);
            if (index >= 0) projectQueue.splice(index, 1);
            reject(new DOMException("Projektanalyse abgebrochen.", "AbortError"));
        };
        signal?.addEventListener("abort", job.abort, { once: true });
        projectQueue.push(job);
    });
}

function releaseProject() {
    projectActive = Math.max(0, projectActive - 1);
    const next = projectQueue.shift();
    if (next) { projectActive += 1; next.resolve(); }
}

function safeName(value) { return path.basename(String(value || "projekt.zip")).replace(/[^\p{L}\p{N}._()\- ]/gu, "_").slice(0, 140) || "projekt.zip"; }
function validEntryName(name) {
    const normalized = String(name || "").replace(/\\/g, "/").replace(/\/$/, "");
    if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
    const segments = normalized.split("/");
    return !segments.some(segment => segment === ".." || segment === "");
}
function isSymlink(entry) {
    const mode = Number(entry.unixPermissions || 0);
    return Boolean(mode && (mode & 0o170000) === 0o120000);
}
function probablyText(buffer) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    if (sample.includes(0)) return false;
    let controls = 0;
    for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
    return !sample.length || controls / sample.length < 0.02;
}
function redact(text) {
    return String(text)
        .replace(/-----BEGIN[\s\S]{0,200}?PRIVATE KEY-----[\s\S]*?-----END[\s\S]{0,80}?PRIVATE KEY-----/gi, "[PRIVATE KEY REDACTED]")
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[=:]\s*["']?)[^\s"'`,;]{6,}/gi, "$1[REDACTED]")
        .replace(/\b(?:ghp_|github_pat_|sk-|AIza)[A-Za-z0-9_\-]{12,}\b/g, "[TOKEN REDACTED]");
}
function tokens(value) { return String(value || "").toLowerCase().match(/[\p{L}\p{N}_.$:/-]{2,}/gu) || []; }
function dependencies(name, text) {
    const found = [];
    const patterns = [/(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\s*\()\s*["']([^"']+)/g, /(?:from|import)\s+([\w.]+)/g, /<script[^>]+src=["']([^"']+)|<link[^>]+href=["']([^"']+)/gi, /(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*["']([^"']+)/g];
    for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1] || match[2]);
    return [...new Set(found.filter(Boolean))].slice(0, 100).map(target => ({ from: name, to: target }));
}
function makeTree(names) {
    const root = {};
    for (const name of names) {
        let node = root;
        for (const segment of name.split("/")) node = node[segment] ||= {};
    }
    const lines = [];
    function walk(node, prefix = "") {
        const entries = Object.entries(node).sort(([a, av], [b, bv]) => (Object.keys(bv).length > 0) - (Object.keys(av).length > 0) || a.localeCompare(b));
        entries.forEach(([name, child], index) => {
            const last = index === entries.length - 1;
            lines.push(`${prefix}${last ? "└── " : "├── "}${name}`);
            if (Object.keys(child).length) walk(child, `${prefix}${last ? "    " : "│   "}`);
        });
    }
    walk(root);
    return lines.slice(0, 1000).join("\n");
}

async function analyzeProjectZipImpl(file, question, signal = null) {
    if (!file?.buffer?.length) throw new Error("Keine Projekt-ZIP hochgeladen.");
    if (file.size > PROJECT_LIMITS.maxZipBytes) throw new Error("ZIP überschreitet das Sicherheitslimit von 50 MB.");
    if (!(file.buffer[0] === 0x50 && file.buffer[1] === 0x4b)) throw new Error("Datei ist keine gültige ZIP-Datei.");
    let zip;
    try { zip = await JSZip.loadAsync(file.buffer, { checkCRC32: true, createFolders: false }); }
    catch { throw new Error("ZIP ist beschädigt oder die Prüfsumme ist ungültig."); }
    const entries = Object.values(zip.files);
    if (entries.length > PROJECT_LIMITS.maxFiles) throw new Error(`ZIP enthält mehr als ${PROJECT_LIMITS.maxFiles} Einträge.`);
    let uncompressed = 0;
    for (const entry of entries) {
        if (!validEntryName(entry.name) || (entry.unsafeOriginalName && !validEntryName(entry.unsafeOriginalName))) throw new Error("ZIP enthält einen unsicheren absoluten oder traversierenden Pfad.");
        if (isSymlink(entry)) throw new Error("Symlinks sind in Projekt-ZIPs nicht erlaubt.");
        uncompressed += Number(entry?._data?.uncompressedSize || 0);
        if (uncompressed > PROJECT_LIMITS.maxUncompressedBytes) throw new Error("ZIP überschreitet entpackt das Sicherheitslimit von 200 MB.");
    }
    const files = [];
    const skipped = { ignored: 0, secret: 0, archive: 0, binary: 0, tooLarge: 0 };
    for (const entry of entries) {
        signal?.throwIfAborted?.();
        const name = entry.name.replace(/\\/g, "/");
        if (entry.dir) continue;
        if (IGNORED.test(name)) { skipped.ignored += 1; continue; }
        if (SECRET_FILE.test(name)) { skipped.secret += 1; continue; }
        if (NESTED_ARCHIVE.test(name)) { skipped.archive += 1; continue; }
        const size = Number(entry?._data?.uncompressedSize || 0);
        if (size > PROJECT_LIMITS.maxTextFileBytes) { skipped.tooLarge += 1; continue; }
        const ext = path.extname(name).toLowerCase();
        if (!TEXT_EXT.has(ext) && !["Dockerfile", "Makefile", "Gemfile", "Procfile"].includes(path.basename(name))) { skipped.binary += 1; continue; }
        const buffer = await entry.async("nodebuffer");
        if (!probablyText(buffer)) { skipped.binary += 1; continue; }
        const text = redact(buffer.toString("utf8").replace(/\r\n?/g, "\n"));
        files.push({ name, ext, language: LANGUAGE[ext] || "Text", text, size, relations: dependencies(name, text) });
    }
    const query = [...new Set(tokens(question))];
    const chunks = [];
    for (const fileItem of files) {
        const lines = fileItem.text.split("\n");
        for (let start = 0; start < lines.length; start += 60) {
            const end = Math.min(lines.length, start + 80);
            const text = lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n");
            const bag = tokens(`${fileItem.name} ${text}`);
            let score = query.reduce((sum, token) => sum + bag.filter(word => word.includes(token) || token.includes(word)).length, 0);
            if (/package\.json|readme|dockerfile/i.test(fileItem.name)) score += 2;
            chunks.push({ file: fileItem.name, language: fileItem.language, start: start + 1, end, text, score });
        }
    }
    chunks.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    const selected = [];
    let chars = 0;
    for (const chunk of chunks) {
        if (selected.length >= PROJECT_LIMITS.maxSelectedChunks || chars + chunk.text.length > PROJECT_LIMITS.maxContextChars) continue;
        selected.push(chunk); chars += chunk.text.length;
    }
    const tree = makeTree(files.map(item => item.name));
    const sources = selected.map((chunk, index) => ({ number: index + 1, title: chunk.file, file: chunk.file, locator: `Zeilen ${chunk.start}–${chunk.end}`, type: "project" }));
    const relations = files.flatMap(item => item.relations).slice(0, 500);
    const relationText = relations.slice(0, 120).map(item => `${item.from} -> ${item.to}`).join("\n");
    const context = [`PROJEKTBAUM (${safeName(file.originalname)})\n${tree}`, relationText ? `ERKANNTE IMPORT-/ROUTENBEZIEHUNGEN\n${relationText}` : "", ...selected.map((chunk, index) => `[P${index + 1}] ${chunk.file} · Zeilen ${chunk.start}–${chunk.end} · ${chunk.language}\n${chunk.text}`)].filter(Boolean).join("\n\n");
    return { context, sources, tree, stats: { archive: safeName(file.originalname), entries: entries.length, indexedFiles: files.length, selectedChunks: selected.length, uncompressedBytes: uncompressed, skipped }, languages: [...new Set(files.map(item => item.language))].sort(), relations };
}

async function analyzeProjectZip(file, question, signal = null) {
    await acquireProject(signal);
    try { return await analyzeProjectZipImpl(file, question, signal); }
    finally { releaseProject(); }
}

module.exports = { PROJECT_LIMITS, analyzeProjectZip, validEntryName, redact };
