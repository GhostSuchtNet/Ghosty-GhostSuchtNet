"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { persistArtifacts } = require("./python-tools");

const AUDIO_LIMITS = Object.freeze({ maxFiles: 3, maxFileBytes: 100 * 1024 * 1024, maxTotalBytes: 120 * 1024 * 1024, chunkSeconds: 600, overlapSeconds: 1 });
const WHISPER_URL = process.env.WHISPER_URL || "http://127.0.0.1:8090";
let activeTranscriptions = 0;
const MAX_ACTIVE_TRANSCRIPTIONS = 1;
const transcriptionQueue = [];

function acquireTranscription(signal, onProgress) {
    if (activeTranscriptions < MAX_ACTIVE_TRANSCRIPTIONS) {
        activeTranscriptions += 1;
        return Promise.resolve();
    }
    onProgress?.({ stage: "audio-queued", position: transcriptionQueue.length + 1 });
    return new Promise((resolve, reject) => {
        const job = { resolve, reject, signal };
        const abort = () => {
            const index = transcriptionQueue.indexOf(job);
            if (index >= 0) transcriptionQueue.splice(index, 1);
            reject(new DOMException("Audio-Transkription abgebrochen.", "AbortError"));
        };
        job.abort = abort;
        signal?.addEventListener("abort", abort, { once: true });
        transcriptionQueue.push(job);
    });
}

function releaseTranscription() {
    activeTranscriptions = Math.max(0, activeTranscriptions - 1);
    const next = transcriptionQueue.shift();
    if (!next) return;
    next.signal?.removeEventListener("abort", next.abort);
    activeTranscriptions += 1;
    next.resolve();
}

function safeName(value) {
    return path.basename(String(value || "audio")).replace(/[^\p{L}\p{N}._()\- ]/gu, "_").slice(0, 140) || "audio";
}

function audioType(buffer, filename) {
    const ext = path.extname(filename).toLowerCase();
    if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
    if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return "mp3";
    if (buffer.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
    if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
    if (buffer.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
    if (buffer.length > 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp" && [".m4a", ".mp4", ".aac"].includes(ext)) return "m4a";
    throw new Error(`${safeName(filename)}: Audiosignatur wird nicht unterstützt.`);
}

function run(command, args, { timeoutMs = 120000, maxOutput = 1024 * 1024, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
        const out = []; const err = []; let bytes = 0; let settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
        const abort = () => { child.kill("SIGKILL"); const error = new Error("Medienverarbeitung abgebrochen."); error.name = "AbortError"; finish(error); };
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`${path.basename(command)} hat das Zeitlimit überschritten.`)); }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes <= maxOutput) out.push(chunk); });
        child.stderr.on("data", chunk => { if (Buffer.concat(err).length < maxOutput) err.push(chunk); });
        child.on("error", finish);
        child.on("close", code => code === 0
            ? finish(null, { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") })
            : finish(new Error(`${path.basename(command)} fehlgeschlagen: ${Buffer.concat(err).toString("utf8").slice(-1200)}`)));
    });
}

function cleanupDirectory(directory) {
    if (!directory || !directory.startsWith(`${os.tmpdir()}${path.sep}ghost-ai-`)) return;
    try {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isFile() || entry.isSymbolicLink()) fs.unlinkSync(target);
            else if (entry.isDirectory()) cleanupDirectory(target);
        }
        fs.rmdirSync(directory);
    } catch (error) {
        if (error.code !== "ENOENT") console.error("[Media] Temporäre Bereinigung fehlgeschlagen:", error.message);
    }
}

async function durationOf(inputPath, signal) {
    const result = await run("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath], { timeoutMs: 30000, signal });
    const duration = Number(result.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 60 * 60) throw new Error("Audiodauer ist ungültig oder überschreitet 8 Stunden.");
    return duration;
}

async function makeChunk(inputPath, outputPath, start, duration, signal) {
    await run("/usr/bin/ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(start), "-t", String(duration), "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outputPath], { timeoutMs: 180000, signal });
}

async function whisperChunk(chunkPath, signal) {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(chunkPath)], { type: "audio/wav" }), path.basename(chunkPath));
    form.append("response_format", "verbose_json");
    form.append("temperature", "0.0");
    let response;
    try {
        response = await fetch(`${WHISPER_URL}/inference`, { method: "POST", body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]) : AbortSignal.timeout(15 * 60 * 1000) });
    } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        throw new Error("Whisper-Dienst nicht erreichbar.");
    }
    const raw = await response.text();
    if (!response.ok) throw new Error(`Whisper-Dienst antwortet mit HTTP ${response.status}.`);
    try { return JSON.parse(raw); } catch { throw new Error("Whisper-Dienst lieferte kein gültiges JSON."); }
}

function timestamp(seconds, decimal = false) {
    const value = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = Math.floor(value % 60);
    const millis = Math.round((value - Math.floor(value)) * 1000);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}${decimal ? "." : ","}${String(millis).padStart(3, "0")}`;
}

function displayTimestamp(seconds) {
    const value = Math.floor(Math.max(0, Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const secs = value % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function chunkPlan(duration) {
    const total = Number(duration);
    if (!Number.isFinite(total) || total <= 0) return [];
    if (total <= AUDIO_LIMITS.chunkSeconds) return [{ start: 0, duration: total }];
    const step = AUDIO_LIMITS.chunkSeconds - AUDIO_LIMITS.overlapSeconds;
    const count = Math.ceil((total - AUDIO_LIMITS.overlapSeconds) / step);
    return Array.from({ length: count }, (_, index) => {
        const start = index * step;
        return { start, duration: Math.min(AUDIO_LIMITS.chunkSeconds, total - start) };
    }).filter(chunk => chunk.duration > 0);
}

function exportsFor(name, segments) {
    const base = safeName(name).replace(/\.[^.]+$/, "") || "transkript";
    const plain = segments.map(segment => `[${displayTimestamp(segment.start)}] ${segment.text}`).join("\n");
    const srt = segments.map((segment, index) => `${index + 1}\n${timestamp(segment.start)} --> ${timestamp(segment.end)}\n${segment.text}\n`).join("\n");
    const vtt = `WEBVTT\n\n${segments.map(segment => `${timestamp(segment.start, true)} --> ${timestamp(segment.end, true)}\n${segment.text}\n`).join("\n")}`;
    const json = JSON.stringify(segments, null, 2);
    return persistArtifacts([
        { name: `${base}-transkript.txt`, data: Buffer.from(plain).toString("base64") },
        { name: `${base}-transkript.srt`, data: Buffer.from(srt).toString("base64") },
        { name: `${base}-transkript.vtt`, data: Buffer.from(vtt).toString("base64") },
        { name: `${base}-transkript.json`, data: Buffer.from(json).toString("base64") }
    ]);
}

function transcriptContext(transcripts, question, maxChars = 30000) {
    const query = [...new Set(String(question || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
    const blocks = [];
    const perTranscriptBudget = Math.floor(maxChars / Math.max(1, transcripts.length)) - 180;
    for (const transcript of transcripts) {
        const rows = transcript.segments.map((segment, index) => ({
            index,
            text: `[${displayTimestamp(segment.start)}–${displayTimestamp(segment.end)}] ${segment.text}`,
            score: query.reduce((sum, token) => sum + (String(segment.text).toLowerCase().includes(token) ? 1 : 0), 0)
        }));
        const all = rows.map(row => row.text).join("\n");
        let selected = rows;
        if (all.length > perTranscriptBudget) {
            const candidates = [];
            rows.filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 100).forEach(row => candidates.push(row.index, row.index - 1, row.index + 1));
            const step = Math.max(1, Math.ceil(rows.length / 180));
            for (let index = 0; index < rows.length; index += step) candidates.push(index);
            candidates.push(0, rows.length - 1);
            const indexes = new Set();
            let used = 0;
            for (const index of candidates) {
                if (index < 0 || index >= rows.length || indexes.has(index)) continue;
                if (used + rows[index].text.length + 1 > perTranscriptBudget) continue;
                indexes.add(index);
                used += rows[index].text.length + 1;
            }
            selected = [...indexes].sort((a, b) => a - b).map(index => rows[index]);
        }
        blocks.push(`[AUDIOQUELLE ${blocks.length + 1}]\nDatei: ${transcript.name}\nDauer: ${displayTimestamp(transcript.duration)}\n\n${selected.map(row => row.text).join("\n")}`);
    }
    return blocks.join("\n\n").slice(0, maxChars);
}

async function transcribeOne(file, onProgress, signal) {
    const name = safeName(file.originalname);
    const type = audioType(file.buffer, name);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-ai-audio-"));
    const inputPath = path.join(directory, `input.${type}`);
    fs.writeFileSync(inputPath, file.buffer, { mode: 0o600 });
    try {
        onProgress?.({ stage: "audio-prepare", name });
        const duration = await durationOf(inputPath, signal);
        const chunks = chunkPlan(duration);
        const segments = [];
        for (let index = 0; index < chunks.length; index += 1) {
            signal?.throwIfAborted?.();
            const { start, duration: length } = chunks[index];
            const chunkPath = path.join(directory, `chunk-${String(index).padStart(3, "0")}.wav`);
            await makeChunk(inputPath, chunkPath, start, length, signal);
            onProgress?.({ stage: "audio-transcribe", name, current: index + 1, total: chunks.length, duration });
            const result = await whisperChunk(chunkPath, signal);
            const incoming = Array.isArray(result.segments) && result.segments.length
                ? result.segments.map(segment => ({ start: start + Number(segment.start || 0), end: start + Number(segment.end || 0), text: String(segment.text || "").trim() }))
                : [{ start, end: start + length, text: String(result.text || "").trim() }];
            for (const segment of incoming) {
                if (!segment.text) continue;
                const previous = segments.at(-1);
                if (previous && segment.end <= previous.end + 0.15) continue;
                if (previous && segment.start < previous.end) segment.start = previous.end;
                segments.push(segment);
            }
        }
        onProgress?.({ stage: "audio-merge", name, duration });
        return { name, duration, language: "auto", segments, text: segments.map(segment => segment.text).join(" "), artifacts: exportsFor(name, segments) };
    } finally {
        cleanupDirectory(directory);
    }
}

async function transcribeAudioFiles(files, { onProgress = null, signal = null, question = "" } = {}) {
    if (!Array.isArray(files) || !files.length || files.length > AUDIO_LIMITS.maxFiles) throw new Error(`Ein bis ${AUDIO_LIMITS.maxFiles} Audiodateien erforderlich.`);
    if (files.some(file => file.size > AUDIO_LIMITS.maxFileBytes) || files.reduce((sum, file) => sum + file.size, 0) > AUDIO_LIMITS.maxTotalBytes) throw new Error("Audio-Upload überschreitet das Größenlimit.");
    await acquireTranscription(signal, onProgress);
    try {
        const transcripts = [];
        for (const file of files) transcripts.push(await transcribeOne(file, onProgress, signal));
        const sources = []; let sourceNumber = 0;
        for (const transcript of transcripts) {
            sources.push({ number: ++sourceNumber, title: `${transcript.name} – Transkript`, file: transcript.name, locator: `00:00–${displayTimestamp(transcript.duration)}`, type: "audio" });
        }
        return { transcripts, sources, context: transcriptContext(transcripts, question), artifacts: transcripts.flatMap(item => item.artifacts) };
    } finally { releaseTranscription(); }
}

module.exports = { AUDIO_LIMITS, audioType, chunkPlan, transcribeAudioFiles };
