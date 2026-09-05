"use strict";

const dns = require("dns").promises;
const ipaddr = require("ipaddr.js");
const { JSDOM, VirtualConsole } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const SEARXNG_URL = process.env.SEARXNG_URL || "http://127.0.0.1:8888";
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 6500;
const MAX_TOTAL_CONTEXT_CHARS = 52000;
const NORMAL_MAX_SOURCES = 15;
const DEEP_MIN_SOURCES = 10;
const DEEP_MAX_SOURCES = 25;
const TRACKING_PARAMETERS = new Set([
    "fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "igshid",
    "ref", "ref_src", "source", "campaign"
]);

const BLOCKED_TRUSTED_HOSTS = [
    "wikipedia.org", "reddit.com", "facebook.com", "instagram.com",
    "tiktok.com", "twitter.com", "x.com", "threads.net", "quora.com",
    "fandom.com", "pinterest.com", "linkedin.com", "snapchat.com",
    "tumblr.com", "discord.com", "telegram.org", "t.me", "vk.com",
    "weibo.com", "mastodon.social"
];

function signalWithTimeout(signal, timeoutMs) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException("Abgebrochen", "AbortError");
}

function normalizeWebsiteUrl(input) {
    let value = String(input || "").trim()
        .replace(/^https:\/\/\s+/i, "https://")
        .replace(/^http:\/\/\s+/i, "http://");
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    return value;
}

function isUnsafeIp(ip) {
    try {
        let parsed = ipaddr.parse(ip);
        if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
            parsed = parsed.toIPv4Address();
        }
        return parsed.range() !== "unicast";
    } catch {
        return true;
    }
}

async function assertSafeUrl(input) {
    let url;
    try {
        url = new URL(normalizeWebsiteUrl(input));
    } catch {
        throw new Error("Die URL ist ungültig.");
    }

    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("Nur HTTP und HTTPS sind erlaubt.");
    }
    if (url.username || url.password) {
        throw new Error("URLs mit Zugangsdaten sind nicht erlaubt.");
    }
    if (url.port && !["80", "443"].includes(url.port)) {
        throw new Error("Dieser Port ist nicht erlaubt.");
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
        throw new Error("Lokale Adressen sind nicht erlaubt.");
    }

    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(result => isUnsafeIp(result.address))) {
        throw new Error("Private oder lokale Serveradressen sind nicht erlaubt.");
    }
    return url;
}

async function readLimitedBody(response) {
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) throw new Error("Die Webseite ist zu groß.");
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            throw new Error("Die Webseite ist zu groß.");
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
}

async function fetchWebsite(originalUrl, { signal = null } = {}) {
    let currentUrl = originalUrl;
    for (let redirect = 0; redirect < 5; redirect += 1) {
        throwIfAborted(signal);
        const safeUrl = await assertSafeUrl(currentUrl);
        const response = await fetch(safeUrl.href, {
            redirect: "manual",
            signal: signalWithTimeout(signal, 12000),
            headers: {
                "User-Agent": "GhostAI-WebReader/2.0",
                Accept: "text/html,application/xhtml+xml,text/plain"
            }
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location) throw new Error("Fehlerhafte Webseiten-Weiterleitung.");
            currentUrl = new URL(location, safeUrl.href).href;
            continue;
        }
        if (!response.ok) throw new Error(`Webseite antwortet mit HTTP ${response.status}.`);

        const contentType = response.headers.get("content-type") || "";
        const allowed = contentType.includes("text/html") ||
            contentType.includes("application/xhtml+xml") ||
            contentType.includes("text/plain");
        if (!allowed) throw new Error("Diese Datei ist keine normale Webseite.");
        return { html: await readLimitedBody(response), finalUrl: safeUrl.href };
    }
    throw new Error("Die Webseite hat zu viele Weiterleitungen.");
}

async function readWebsite(inputUrl, { signal = null } = {}) {
    const { html, finalUrl } = await fetchWebsite(inputUrl, { signal });
    const dom = new JSDOM(html, { url: finalUrl, virtualConsole: new VirtualConsole() });
    const fallbackText = dom.window.document.body?.textContent || "";
    const documentTitle = dom.window.document.title || "";
    const article = new Readability(dom.window.document).parse();
    const text = String(article?.textContent || fallbackText)
        .replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_CHARS);
    return {
        url: finalUrl,
        title: article?.title || documentTitle || finalUrl,
        excerpt: article?.excerpt || "",
        text
    };
}

function canonicalUrl(value) {
    try {
        const url = new URL(value);
        url.hash = "";
        url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
        if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
        for (const key of [...url.searchParams.keys()]) {
            if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
        }
        url.searchParams.sort();
        if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
        return url.href;
    } catch {
        return "";
    }
}

function hostMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function detectTrustedSourceRequest(message) {
    return /(?:nur\s+)?(?:mit\s+)?(?:vertrauensw(?:ü|u)rdig(?:e|en|er|es)?|seri(?:ö|o)s(?:e|en|er|es)?|offiziell(?:e|en|er|es)?|wissenschaftlich(?:e|en|er|es)?)\s+quellen|pr(?:i|ä)m(?:ä|a)rquellen|pr(?:ü|u)fe\s+(?:das\s+)?offiziell|nutze\s+(?:beh(?:ö|o)rden|ministerien)/i
        .test(String(message || ""));
}

function isBlockedTrustedUrl(value, allowYouTube = false) {
    try {
        const parsed = new URL(value);
        const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
        if (BLOCKED_TRUSTED_HOSTS.some(domain => hostMatches(hostname, domain))) return true;
        if (!allowYouTube && ["youtube.com", "youtu.be"].some(domain => hostMatches(hostname, domain))) return true;
        if (/^(?:forum|forums|wiki)\./.test(hostname) || /\/(?:forum|forums|wiki)(?:\/|$)/i.test(parsed.pathname)) return true;
        return false;
    } catch {
        return true;
    }
}

function detectOfficialOnlyRequest(message) {
    return /(?:nur\s+)?(?:mit\s+)?offiziell(?:e|en|er|es)?\s+quellen|pr(?:ü|u)fe\s+(?:das\s+)?offiziell/i
        .test(String(message || ""));
}

function cleanTrustedQuery(message) {
    return String(message || "")
        .replace(/(?:pr(?:ü|u)fe|nutze)?\s*(?:nur\s+)?(?:mit\s+)?(?:vertrauensw(?:ü|u)rdig(?:e|en|er|es)?|seri(?:ö|o)s(?:e|en|er|es)?|offiziell(?:e|en|er|es)?|wissenschaftlich(?:e|en|er|es)?)\s+quellen[,.:]?/gi, " ")
        .replace(/^\s*pr(?:ü|u)fe\s+/i, "")
        .replace(/\s+/g, " ").trim();
}

function isLikelyOfficialResult(result, query) {
    try {
        const hostname = new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
        if (sourcePriority(result.url) <= 2) return true;
        const normalizedHost = hostname.replace(/[^a-z0-9]/g, "");
        const stopWords = new Set(["welche", "welcher", "welches", "aktuell", "version", "quellen", "quelle", "official", "offiziell"]);
        const tokens = String(query || "").toLowerCase().replace(/[^a-z0-9äöüß.]+/g, " ")
            .split(/\s+/).map(token => token.replace(/[^a-z0-9]/g, ""))
            .filter(token => token.length >= 4 && !stopWords.has(token));
        if (tokens.some(token => normalizedHost.includes(token))) return true;
        return /\b(?:official|offizielle|documentation|dokumentation)\b/i.test(`${result.title} ${result.snippet}`) &&
            !/\b(?:forum|community|wiki|blog)\b/i.test(`${hostname} ${result.title}`);
    } catch {
        return false;
    }
}

function sourcePriority(value) {
    try {
        const hostname = new URL(value).hostname.toLowerCase();
        if (/\.(gov|gouv|bund|europa)\./.test(`.${hostname}.`) ||
            hostname.endsWith(".gov") || hostname.endsWith(".eu") ||
            /(^|\.)(bund\.de|gesetze-im-internet\.de|europa\.eu)$/.test(hostname)) return 0;
        if (/\.(edu|ac)\./.test(`.${hostname}.`) || hostname.endsWith(".edu")) return 1;
        if (/doi\.org$|arxiv\.org$|pubmed\.ncbi\.nlm\.nih\.gov$/.test(hostname)) return 2;
        return 3;
    } catch {
        return 9;
    }
}

async function searchWeb(query, maxResults = 15, options = {}) {
    const cleanQuery = String(query || "").trim().slice(0, 500);
    if (!cleanQuery) throw new Error("Suchanfrage fehlt.");
    const params = new URLSearchParams({
        q: cleanQuery,
        format: "json",
        categories: "general",
        language: "all",
        safesearch: "1"
    });
    const response = await fetch(`${SEARXNG_URL}/search?${params}`, {
        signal: signalWithTimeout(options.signal || null, 15000)
    });
    if (!response.ok) throw new Error(`SearXNG antwortet mit HTTP ${response.status}.`);
    const data = await response.json();
    const allowYouTube = /\b(?:youtube|video(?:s)?)\b/i.test(options.message || cleanQuery);
    const seen = new Set();
    let results = (data.results || []).map(result => ({
        title: String(result.title || result.url || "").slice(0, 500),
        url: canonicalUrl(result.url),
        snippet: String(result.content || "").replace(/\s+/g, " ").trim().slice(0, 1800),
        engine: String(result.engine || "").slice(0, 80)
    })).filter(result => {
        if (!result.url || seen.has(result.url)) return false;
        seen.add(result.url);
        return !options.trusted || !isBlockedTrustedUrl(result.url, allowYouTube);
    });
    if (options.officialOnly) results = results.filter(result => isLikelyOfficialResult(result, cleanQuery));
    if (options.trusted) results = results.sort((a, b) => sourcePriority(a.url) - sourcePriority(b.url));
    return results.slice(0, Math.min(Math.max(Number(maxResults) || 15, 1), 30));
}

function extractUrls(message) {
    const text = String(message || "")
        .replace(/https:\/\/\s+/gi, "https://")
        .replace(/http:\/\/\s+/gi, "http://");
    return [...new Set((text.match(/https?:\/\/[^\s<>"']+/gi) || [])
        .map(url => url.replace(/[),.;!?]+$/, "")))];
}

function isDateTimeRequest(message) {
    return /\b(?:wie\s+sp(?:ä|a)t|welche\s+uhrzeit|wie\s+viel\s+uhr|welches\s+datum|welche(?:n|r|s)?\s+wochentag|was\s+f(?:ü|u)r\s+ein\s+datum|uhrzeit\s+(?:haben|ist)|datum\s+(?:haben|ist)|wochentag\s+(?:haben|ist))\b/i
        .test(String(message || ""));
}

function shouldUseWebAutomatically(message) {
    const text = String(message || "").toLowerCase();
    if (extractUrls(text).length) return true;
    if (isDateTimeRequest(text)) return false;
    return [
        "suche im internet", "internetsuche", "internetzugriff", "suche online",
        "suche nach", "schau nach", "schau im internet nach", "recherchiere",
        "recherchiere online", "aktuelle informationen", "aktuell", "heute",
        "gerade", "momentan", "derzeit", "neueste", "news", "welche version",
        "websuche", "online nach"
    ].some(term => text.includes(term)) || /\b20(?:2[4-9]|[3-9]\d)\b/.test(text);
}

function safeDomain(value) {
    try {
        return new URL(value).hostname.replace(/^www\./, "").slice(0, 120);
    } catch {
        return "Webseite";
    }
}

function normalizeEvaluation(evaluation, sourceCount, query) {
    const raw = evaluation && typeof evaluation === "object" ? evaluation : {};
    const needMoreSources = Boolean(raw.needMoreSources) || sourceCount < 2;
    const requested = Number(raw.additionalSources);
    return {
        needMoreSources,
        additionalSources: needMoreSources
            ? Math.min(10, Math.max(3, Number.isFinite(requested) ? Math.round(requested) : 3))
            : 0,
        searchQueries: (Array.isArray(raw.searchQueries) ? raw.searchQueries : [raw.searchQuery || query])
            .map(value => String(value || "").trim().slice(0, 500)).filter(Boolean).slice(0, 5),
        reason: String(raw.reason || "").trim().slice(0, 1000),
        contradictions: Boolean(raw.contradictions)
    };
}

async function buildWebContext({ message, mode = "auto", deepResearch = false, onStatus = null, evaluateSources = null, signal = null }) {
    const cleanMessage = String(message || "").trim();
    const selectedMode = ["off", "auto", "always"].includes(mode) ? mode : "auto";
    const maxSources = deepResearch ? DEEP_MAX_SOURCES : NORMAL_MAX_SOURCES;
    const minimumSources = deepResearch ? DEEP_MIN_SOURCES : 1;
    const emit = event => {
        if (typeof onStatus === "function") onStatus(event);
    };

    if (selectedMode === "off" && !deepResearch) return { used: false, reason: "off", context: "", sources: [] };
    const urls = extractUrls(cleanMessage);
    if (!deepResearch && !urls.length && isDateTimeRequest(cleanMessage)) {
        return { used: false, reason: "server-time", context: "", sources: [] };
    }
    const useWeb = deepResearch || selectedMode === "always" || urls.length > 0 ||
        (selectedMode === "auto" && shouldUseWebAutomatically(cleanMessage));
    if (!useWeb) return { used: false, reason: "not-needed", context: "", sources: [] };
    if (deepResearch) emit({ stage: "deep-start", min: DEEP_MIN_SOURCES, max: DEEP_MAX_SOURCES });

    const trusted = detectTrustedSourceRequest(cleanMessage);
    const officialOnly = detectOfficialOnlyRequest(cleanMessage);
    const researchQuery = trusted ? (cleanTrustedQuery(cleanMessage) || cleanMessage) : cleanMessage;
    const records = [];
    const seen = new Set();
    let totalChars = 0;

    function addRecord({ title, url, text }) {
        const canonical = canonicalUrl(url);
        if (!canonical || seen.has(canonical) || !String(text || "").trim() || records.length >= maxSources) return false;
        const remaining = MAX_TOTAL_CONTEXT_CHARS - totalChars;
        if (remaining <= 0) return false;
        const perSourceLimit = deepResearch ? 4600 : MAX_PAGE_CHARS;
        const clipped = String(text).slice(0, Math.min(perSourceLimit, remaining));
        records.push({ title: String(title || canonical).slice(0, 500), url: canonical, text: clipped });
        seen.add(canonical);
        totalChars += clipped.length;
        emit({ stage: "count", count: records.length, min: minimumSources, max: maxSources, deepResearch });
        return true;
    }

    async function readCandidate(candidate) {
        throwIfAborted(signal);
        if (!candidate?.url || seen.has(canonicalUrl(candidate.url)) || records.length >= maxSources) return false;
        const domain = safeDomain(candidate.url);
        emit({ stage: "read", domain });
        try {
            const page = await readWebsite(candidate.url, { signal });
            return addRecord({ title: page.title || candidate.title, url: page.url, text: page.text });
        } catch (error) {
            if (signal?.aborted) throw error;
            emit({ stage: "read-error", domain });
            return addRecord({ title: candidate.title, url: candidate.url, text: candidate.snippet });
        }
    }

    function diverseCandidates(candidates) {
        const unique = [];
        const duplicateDomains = [];
        const domains = new Set();
        const localSeen = new Set();
        for (const candidate of candidates) {
            const canonical = canonicalUrl(candidate?.url);
            if (!canonical || localSeen.has(canonical) || seen.has(canonical)) continue;
            localSeen.add(canonical);
            const domain = safeDomain(canonical);
            if (domains.has(domain)) duplicateDomains.push(candidate);
            else {
                domains.add(domain);
                unique.push(candidate);
            }
        }
        return [...unique, ...duplicateDomains];
    }

    async function readUntil(candidates, target) {
        const before = records.length;
        for (const candidate of diverseCandidates(candidates)) {
            await readCandidate(candidate);
            if (records.length >= target || records.length >= maxSources || totalChars >= MAX_TOTAL_CONTEXT_CHARS) break;
        }
        return records.length - before;
    }

    let initialResults = [];
    if (urls.length) {
        await readUntil(urls.slice(0, deepResearch ? 10 : 3).map(url => ({ url, title: url, snippet: "" })), deepResearch ? Math.min(urls.length, DEEP_MIN_SOURCES) : Math.min(urls.length, 3));
    }
    if (!urls.length || deepResearch) {
        emit({ stage: "search" });
        initialResults = await searchWeb(researchQuery, deepResearch ? 30 : maxSources, { trusted, officialOnly, message: cleanMessage, signal });
        await readUntil(initialResults, deepResearch ? DEEP_MIN_SOURCES : Math.min(3, maxSources));
    }

    let rounds = 0;
    while (records.length && records.length < maxSources && rounds < (deepResearch ? 4 : 1)) {
        if (deepResearch && records.length < DEEP_MIN_SOURCES) {
            const added = await readUntil(initialResults, DEEP_MIN_SOURCES);
            if (!added) break;
            continue;
        }
        emit({ stage: "evaluate", count: records.length, max: maxSources });
        let evaluation = null;
        if (typeof evaluateSources === "function") {
            try {
                evaluation = await evaluateSources({
                    query: cleanMessage,
                    trusted,
                    deepResearch,
                    signal,
                    sources: records.map(record => ({ title: record.title, url: record.url, text: record.text.slice(0, 1800) }))
                });
            } catch (error) {
                if (signal?.aborted) throw error;
            }
        }
        const decision = normalizeEvaluation(evaluation, records.length, cleanMessage);
        if (decision.contradictions) emit({ stage: "conflict" });
        if (!decision.needMoreSources) break;
        const target = Math.min(maxSources, records.length + decision.additionalSources);
        emit({ stage: "more", count: decision.additionalSources, current: records.length, max: maxSources, reason: decision.reason });
        const queryResults = [];
        for (const query of decision.searchQueries.length ? decision.searchQueries : [cleanMessage]) {
            emit({ stage: "search", query: query.slice(0, 160) });
            try {
                queryResults.push(...await searchWeb(query, 20, { trusted, officialOnly, message: cleanMessage, signal }));
            } catch (error) {
                if (signal?.aborted) throw error;
                emit({ stage: "search-error" });
            }
        }
        const added = await readUntil([...initialResults, ...queryResults], target);
        if (!added) break;
        rounds += 1;
    }

    emit({ stage: "answer", count: records.length, min: minimumSources, max: maxSources, deepResearch });
    const sources = records.map((record, index) => ({
        number: index + 1,
        title: record.title,
        url: record.url
    }));
    const finalContextBudget = deepResearch ? 12000 : 16000;
    const excerptChars = records.length
        ? Math.max(deepResearch ? 380 : 850, Math.floor(finalContextBudget / records.length) - 180)
        : 0;
    const context = records.map((record, index) =>
        `[QUELLE ${index + 1}]\nTitel: ${record.title}\nURL: ${record.url}\n\n${record.text.slice(0, excerptChars)}`
    ).join("\n\n");
    return {
        used: sources.length > 0,
        reason: urls.length ? "direct-url" : (sources.length ? "search" : "no-results"),
        trusted,
        officialOnly,
        deepResearch,
        minimumSources,
        maxSources,
        incomplete: deepResearch && sources.length < DEEP_MIN_SOURCES,
        context,
        sources
    };
}

module.exports = {
    searchWeb,
    readWebsite,
    buildWebContext,
    extractUrls,
    shouldUseWebAutomatically,
    detectTrustedSourceRequest,
    isDateTimeRequest
};
