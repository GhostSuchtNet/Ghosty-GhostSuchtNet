"use strict";

const path = require("path");
const JSZip = require("jszip");
const mammoth = require("mammoth");
const ExcelJS = require("exceljs");

const FILE_LIMITS = Object.freeze({
    maxFiles: 10,
    maxFileBytes: 20 * 1024 * 1024,
    maxTotalBytes: 50 * 1024 * 1024,
    maxContextChars: 48000,
    maxPythonDataChars: 300000,
    chunkChars: 2200,
    chunksPerFile: 8
});

const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".html", ".htm",
    ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java",
    ".kt", ".kts", ".py", ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp",
    ".cs", ".php", ".sql", ".sh", ".bash"
]);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UNCOMPRESSED_OFFICE_BYTES = 100 * 1024 * 1024;
const MAX_INDEX_CHARS_PER_FILE = 2 * 1024 * 1024;

function safeFilename(value) {
    return path.basename(String(value || "datei"))
        .replace(/[\u0000-\u001f\u007f]/g, "_")
        .replace(/[^\p{L}\p{N}._()\- ]/gu, "_")
        .slice(0, 160) || "datei";
}

function extensionOf(name) {
    return path.extname(String(name || "")).toLowerCase();
}

function startsWith(buffer, bytes) {
    return bytes.every((value, index) => buffer[index] === value);
}

function isProbablyText(buffer) {
    if (!buffer.length) return true;
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let invalid = 0;
    for (const byte of sample) {
        if (byte === 0) return false;
        if (byte < 9 || (byte > 13 && byte < 32)) invalid += 1;
    }
    return invalid / sample.length < 0.02;
}

async function identifyFile(file) {
    const buffer = file.buffer;
    const ext = extensionOf(file.originalname);
    if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: "pdf", mime: "application/pdf" };
    if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
        return { kind: "image", mime: "image/webp" };
    }
    if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
        let zip;
        try {
            zip = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
        } catch {
            throw new Error(`${safeFilename(file.originalname)} ist kein gültiges ZIP-basiertes Office-Dokument.`);
        }
        const names = Object.keys(zip.files);
        if (names.length > 5000) throw new Error(`${safeFilename(file.originalname)} enthält zu viele ZIP-Einträge.`);
        const uncompressedBytes = Object.values(zip.files).reduce((sum, entry) => sum + Number(entry?._data?.uncompressedSize || 0), 0);
        if (uncompressedBytes > MAX_UNCOMPRESSED_OFFICE_BYTES) throw new Error(`${safeFilename(file.originalname)} ist entpackt zu groß.`);
        if (names.includes("word/document.xml") && ext === ".docx") return { kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip };
        if (names.some(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)) && ext === ".pptx") return { kind: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip };
        if (names.includes("xl/workbook.xml") && ext === ".xlsx") return { kind: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
        throw new Error(`${safeFilename(file.originalname)} besitzt keinen unterstützten Office-Inhalt.`);
    }
    if (TEXT_EXTENSIONS.has(ext) && isProbablyText(buffer)) return { kind: "text", mime: file.mimetype || "text/plain" };
    throw new Error(`${safeFilename(file.originalname)}: Dateityp oder Dateiinhalt wird nicht unterstützt.`);
}

function xmlText(value) {
    return String(value || "")
        .replace(/<a:br\s*\/?>/gi, "\n")
        .replace(/<w:tab\s*\/?>/gi, "\t")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        .replace(/&quot;/g, "\"").replace(/&apos;/g, "'");
}

async function extractPdf(buffer) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, useSystemFonts: true });
    const pdf = await task.promise;
    const sections = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim();
        sections.push({ locator: `Seite ${pageNumber}`, text });
    }
    const hasLittleText = sections.reduce((sum, section) => sum + section.text.length, 0) < Math.max(80, pdf.numPages * 30);
    return { sections, summary: `${pdf.numPages} Seite(n)${hasLittleText ? "; möglicherweise überwiegend gescannt" : ""}`, warning: hasLittleText ? "Diese PDF enthält möglicherweise hauptsächlich gescannte Seiten." : "" };
}

async function extractDocx(buffer) {
    const result = await mammoth.convertToHtml({ buffer }, { includeDefaultStyleMap: true });
    const html = String(result.value || "")
        .replace(/<\/(h[1-6]|p|li|tr)>/gi, "\n")
        .replace(/<\/t[dh]>/gi, "\t");
    const text = xmlText(html).replace(/\n{3,}/g, "\n\n").trim();
    return { sections: [{ locator: "Dokument", text }], summary: "DOCX: Überschriften, Absätze, Listen und Tabellen extrahiert", warning: result.messages?.length ? "Einige DOCX-Elemente konnten nur vereinfacht gelesen werden." : "" };
}

async function extractPptx(zip) {
    const slideNames = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => Number(a.match(/(\d+)/)?.[1]) - Number(b.match(/(\d+)/)?.[1]));
    const sections = [];
    for (let index = 0; index < slideNames.length; index += 1) {
        const xml = await zip.file(slideNames[index]).async("string");
        const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/gi)].map(match => xmlText(match[1]).trim()).filter(Boolean);
        sections.push({ locator: `Folie ${index + 1}`, text: texts.join("\n") });
    }
    return { sections, summary: `${sections.length} Folie(n); Text und Tabellenzellen extrahiert`, warning: "" };
}

function excelValue(cell) {
    if (cell.formula) return `${cell.result ?? ""} (Formel: ${cell.formula})`;
    if (cell.value && typeof cell.value === "object") {
        if (cell.value.richText) return cell.value.richText.map(part => part.text).join("");
        if (cell.value.text) return cell.value.text;
        if (cell.value.result !== undefined) return String(cell.value.result);
    }
    return cell.value === null || cell.value === undefined ? "" : String(cell.value);
}

async function extractXlsx(buffer) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer, { ignoreNodes: ["dataValidations"] });
    const sections = [];
    workbook.eachSheet(sheet => {
        const rows = [];
        const rowLimit = Math.min(sheet.rowCount, 2500);
        for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
            const row = sheet.getRow(rowNumber);
            const values = [];
            for (let column = 1; column <= Math.min(sheet.columnCount, 100); column += 1) values.push(excelValue(row.getCell(column)));
            rows.push(`${rowNumber}: ${values.join("\t")}`);
        }
        if (sheet.rowCount > rowLimit) rows.push(`… ${sheet.rowCount - rowLimit} weitere Zeilen nicht vollständig in den Analyseindex übernommen.`);
        sections.push({ locator: `Tabelle \"${sheet.name}\" (${sheet.rowCount} Zeilen × ${sheet.columnCount} Spalten)`, text: rows.join("\n") });
    });
    return { sections, summary: `${workbook.worksheets.length} Tabellenblatt/-blätter`, warning: "" };
}

function decodeText(buffer) {
    let text = buffer.toString("utf8");
    const replacements = (text.match(/�/g) || []).length;
    if (replacements > Math.max(2, text.length / 200)) text = new TextDecoder("windows-1252").decode(buffer);
    return text.replace(/\r\n?/g, "\n");
}

function extractText(buffer, name) {
    const text = decodeText(buffer);
    const ext = extensionOf(name);
    if (ext === ".csv") {
        const first = text.split("\n", 1)[0] || "";
        const candidates = [",", ";", "\t", "|"];
        const separator = candidates.sort((a, b) => first.split(b).length - first.split(a).length)[0];
        const rows = text.split("\n").filter(Boolean).length;
        return { sections: [{ locator: `CSV (${rows} Zeilen, Trennzeichen ${JSON.stringify(separator)})`, text }], summary: `${rows} CSV-Zeilen`, warning: "" };
    }
    const numbered = text.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
    return { sections: [{ locator: `Zeilen 1–${Math.max(1, text.split("\n").length)}`, text: numbered }], summary: `${Math.max(1, text.split("\n").length)} Zeilen`, warning: "" };
}

function tokenize(value) {
    return String(value || "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
}

function chunkSections(sections, filename) {
    const chunks = [];
    let indexedChars = 0;
    for (const section of sections) {
        const remaining = MAX_INDEX_CHARS_PER_FILE - indexedChars;
        if (remaining <= 0) break;
        const text = String(section.text || "").trim().slice(0, remaining);
        if (!text) continue;
        indexedChars += text.length;
        for (let offset = 0; offset < text.length; offset += FILE_LIMITS.chunkChars) {
            const slice = text.slice(offset, offset + FILE_LIMITS.chunkChars);
            chunks.push({ filename, locator: section.locator, text: slice, tokens: tokenize(slice) });
        }
    }
    return chunks;
}

function rankChunks(chunks, question) {
    const query = [...new Set(tokenize(question))];
    const documentFrequency = new Map();
    for (const chunk of chunks) {
        for (const token of new Set(chunk.tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
    return chunks.map(chunk => {
        const counts = new Map();
        chunk.tokens.forEach(token => counts.set(token, (counts.get(token) || 0) + 1));
        let score = 0;
        query.forEach(token => {
            const frequency = counts.get(token) || 0;
            const idf = Math.log(1 + (chunks.length + 1) / ((documentFrequency.get(token) || 0) + 1));
            score += frequency * idf;
        });
        return { ...chunk, score };
    }).sort((a, b) => b.score - a.score);
}

async function extractUploadedFiles(files, question, signal = null) {
    if (!Array.isArray(files) || !files.length) throw new Error("Keine Datei hochgeladen.");
    if (files.length > FILE_LIMITS.maxFiles) throw new Error(`Maximal ${FILE_LIMITS.maxFiles} Dateien pro Anfrage.`);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > FILE_LIMITS.maxTotalBytes) throw new Error("Alle Dateien zusammen dürfen maximal 50 MB groß sein.");

    const documents = [];
    const allChunks = [];
    const pythonInputs = [];
    for (const file of files) {
        signal?.throwIfAborted?.();
        const name = safeFilename(file.originalname);
        const identified = await identifyFile(file);
        let extracted;
        if (identified.kind === "pdf") extracted = await extractPdf(file.buffer);
        else if (identified.kind === "docx") extracted = await extractDocx(file.buffer);
        else if (identified.kind === "pptx") extracted = await extractPptx(identified.zip);
        else if (identified.kind === "xlsx") extracted = await extractXlsx(file.buffer);
        else if (identified.kind === "text") extracted = extractText(file.buffer, name);
        else extracted = { sections: [], summary: "Bilddatei; wird über die Bildanalyse verarbeitet", warning: "" };
        signal?.throwIfAborted?.();

        const chunks = chunkSections(extracted.sections, name);
        allChunks.push(...chunks);
        documents.push({ name, mime: identified.mime, kind: identified.kind, size: file.size, summary: extracted.summary, warning: extracted.warning, sectionCount: extracted.sections.length });
        const currentPythonChars = pythonInputs.reduce((sum, item) => sum + item.content.length, 0);
        if (["text", "xlsx"].includes(identified.kind) && currentPythonChars < FILE_LIMITS.maxPythonDataChars) {
            const content = extracted.sections.map(section => `# ${section.locator}\n${section.text}`).join("\n\n").slice(0, FILE_LIMITS.maxPythonDataChars - currentPythonChars);
            pythonInputs.push({ name: identified.kind === "xlsx" ? `${name}.extracted.txt` : name, content });
        }
    }

    const ranked = rankChunks(allChunks, question);
    const selected = [];
    const perFile = new Map();
    let contextChars = 0;
    for (const chunk of ranked) {
        const used = perFile.get(chunk.filename) || 0;
        if (used >= FILE_LIMITS.chunksPerFile || contextChars + chunk.text.length > FILE_LIMITS.maxContextChars) continue;
        selected.push(chunk);
        perFile.set(chunk.filename, used + 1);
        contextChars += chunk.text.length;
    }
    const context = selected.map((chunk, index) => `[DATEIQUELLE ${index + 1}]\nDatei: ${chunk.filename}\nFundstelle: ${chunk.locator}\n\n${chunk.text}`).join("\n\n");
    const sources = selected.map((chunk, index) => ({ number: index + 1, title: `${chunk.filename} – ${chunk.locator}`, file: chunk.filename, locator: chunk.locator, type: "file" }));
    return { documents, context, sources, pythonInputs, totalBytes };
}

module.exports = { FILE_LIMITS, IMAGE_TYPES, extractUploadedFiles, safeFilename };
