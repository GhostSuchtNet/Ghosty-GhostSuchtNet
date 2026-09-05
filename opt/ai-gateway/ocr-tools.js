"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const OCR_LIMITS = Object.freeze({
    maxFiles: 4,
    maxFileBytes: 20 * 1024 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    maxPdfPages: 25,
    maxContextChars: 36000,
    concurrency: 2
});

let activeJobs = 0;
const waitingJobs = [];

function acquire(signal) {
    if (activeJobs < OCR_LIMITS.concurrency) {
        activeJobs += 1;
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const item = { resolve, reject };
        const abort = () => {
            const index = waitingJobs.indexOf(item);
            if (index >= 0) waitingJobs.splice(index, 1);
            reject(new DOMException("OCR abgebrochen.", "AbortError"));
        };
        item.abort = abort;
        signal?.addEventListener("abort", abort, { once: true });
        waitingJobs.push(item);
    });
}

function release() {
    activeJobs = Math.max(0, activeJobs - 1);
    const next = waitingJobs.shift();
    if (next) {
        activeJobs += 1;
        next.resolve();
    }
}

function safeName(value) {
    return path.basename(String(value || "scan"))
        .replace(/[\u0000-\u001f\u007f]/g, "_")
        .replace(/[^\p{L}\p{N}._()\- ]/gu, "_").slice(0, 140) || "scan";
}

function detect(buffer) {
    if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return { kind: "pdf", ext: ".pdf" };
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", ext: ".png" };
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { kind: "image", ext: ".jpg" };
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return { kind: "image", ext: ".webp" };
    throw new Error("OCR unterstützt nur echte PDF-, PNG-, JPEG- oder WEBP-Dateien.");
}

function run(command, args, { signal, timeoutMs = 120000, maxOutput = 12 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
        const out = [];
        const err = [];
        let bytes = 0;
        let settled = false;
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error) reject(error);
        };
        const abort = () => {
            child.kill("SIGKILL");
            finish(new DOMException("OCR abgebrochen.", "AbortError"));
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            const error = new Error("OCR hat zu lange gedauert.");
            error.status = 408;
            finish(error);
        }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", chunk => {
            bytes += chunk.length;
            if (bytes <= maxOutput) out.push(chunk);
            else child.kill("SIGKILL");
        });
        child.stderr.on("data", chunk => err.push(chunk));
        child.on("error", finish);
        child.on("close", code => {
            if (settled) return;
            if (bytes > maxOutput) return finish(new Error("OCR-Ausgabe überschreitet das Sicherheitslimit."));
            if (code !== 0) return finish(new Error(`OCR-Programm fehlgeschlagen (${code}): ${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            resolve(Buffer.concat(out).toString("utf8"));
        });
    });
}

function parseTsv(tsv) {
    const words = [];
    const lines = new Map();
    for (const row of String(tsv).split(/\r?\n/).slice(1)) {
        const columns = row.split("\t");
        if (columns.length < 12) continue;
        const text = columns.slice(11).join("\t").trim();
        const confidence = Number(columns[10]);
        if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
        const key = columns.slice(1, 5).join(".");
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(text);
        words.push({ text, confidence });
    }
    return {
        text: [...lines.values()].map(line => line.join(" ")).join("\n").trim(),
        confidence: words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 0,
        words: words.length
    };
}

async function ocrImage(filename, signal) {
    const tsv = await run("tesseract", [filename, "stdout", "-l", "deu+eng", "--psm", "3", "tsv"], { signal });
    return parseTsv(tsv);
}

async function pdfPages(filename, directory, signal) {
    const info = await run("pdfinfo", [filename], { signal, timeoutMs: 30000, maxOutput: 200000 });
    const pages = Number(info.match(/^Pages:\s+(\d+)/mi)?.[1] || 0);
    if (!pages) throw new Error("Seitenzahl der PDF konnte nicht bestimmt werden.");
    if (pages > OCR_LIMITS.maxPdfPages) throw new Error(`OCR verarbeitet maximal ${OCR_LIMITS.maxPdfPages} PDF-Seiten pro Datei.`);
    const prefix = path.join(directory, "page");
    await run("pdftoppm", ["-png", "-r", "180", "-f", "1", "-l", String(pages), filename, prefix], { signal, timeoutMs: 240000, maxOutput: 1000000 });
    return (await fs.readdir(directory)).filter(name => /^page-\d+\.png$/.test(name))
        .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
        .map(name => path.join(directory, name));
}

async function extractOcr(files, signal = null, progress = null) {
    if (!Array.isArray(files) || !files.length) throw new Error("Keine Datei für OCR hochgeladen.");
    if (files.length > OCR_LIMITS.maxFiles) throw new Error(`Maximal ${OCR_LIMITS.maxFiles} OCR-Dateien pro Anfrage.`);
    if (files.some(file => file.size > OCR_LIMITS.maxFileBytes)) throw new Error("Eine OCR-Datei überschreitet 20 MB.");
    if (files.reduce((sum, file) => sum + file.size, 0) > OCR_LIMITS.maxTotalBytes) throw new Error("OCR-Dateien überschreiten zusammen 50 MB.");
    await acquire(signal);
    let directory;
    try {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "ghost-ai-ocr-"));
        const pages = [];
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
            signal?.throwIfAborted?.();
            const file = files[fileIndex];
            const name = safeName(file.originalname);
            const type = detect(file.buffer);
            const source = path.join(directory, `input-${fileIndex}${type.ext}`);
            await fs.writeFile(source, file.buffer, { mode: 0o600, flag: "wx" });
            const images = type.kind === "pdf" ? await pdfPages(source, directory, signal) : [source];
            for (let index = 0; index < images.length; index += 1) {
                progress?.({ stage: "ocr-page", file: name, current: index + 1, total: images.length });
                const result = await ocrImage(images[index], signal);
                pages.push({ file: name, page: type.kind === "pdf" ? index + 1 : null, ...result });
            }
        }
        let used = 0;
        const contextParts = [];
        const sources = [];
        for (const page of pages) {
            const locator = page.page ? `Seite ${page.page}` : "Bild";
            if (page.text && used < OCR_LIMITS.maxContextChars) {
                const text = page.text.slice(0, OCR_LIMITS.maxContextChars - used);
                contextParts.push(`[OCR${sources.length + 1}] ${page.file}, ${locator}\n${text}`);
                sources.push({ number: sources.length + 1, title: page.file, file: page.file, locator, type: "ocr" });
                used += text.length;
            }
        }
        const averageConfidence = pages.length ? pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length : 0;
        return {
            context: contextParts.join("\n\n"), sources, pages: pages.map(page => ({ file: page.file, page: page.page, characters: page.text.length, confidence: Math.round(page.confidence) })),
            pageCount: pages.length, averageConfidence: Math.round(averageConfidence),
            lowQuality: contextParts.join("").length < 80 || averageConfidence < 45,
            warnings: pages.filter(page => !page.text).map(page => `${page.file}${page.page ? `, Seite ${page.page}` : ""}: kein Text erkannt.`)
        };
    } finally {
        if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        release();
    }
}

module.exports = { OCR_LIMITS, extractOcr, detect };
