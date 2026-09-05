"use strict";

function containsAny(text, regexes) {
    return regexes.some(regex => regex.test(text));
}

function classifyRequest(request = {}) {
    const text = String(request.text || "").trim();
    const lower = text.toLowerCase();
    const categories = new Set();

    const files = Array.isArray(request.files) ? request.files : [];
    const hasFiles = files.length > 0;

    if (
        /(?:\d|\bx\b|\by\b).*(?:\+|-|\*|\/|\^|=)/i.test(text) ||
        containsAny(lower, [
            /\bberechne\b/,
            /\bgleichung\b/,
            /\bnullstelle/,
            /\bintegral/,
            /\bableitung/,
            /\bmatrix/,
            /\bprozent/
        ])
    ) {
        categories.add("math");
    }

    if (
        hasFiles ||
        containsAny(lower, [
            /\bpdf\b/,
            /\bdocx\b/,
            /\bxlsx\b/,
            /\bcsv\b/,
            /\bdatei\b/,
            /\bkonvertier/,
            /\bumwandeln\b/,
            /\barchiv\b/
        ])
    ) {
        categories.add("file");
    }

    if (
        /```/.test(text) ||
        containsAny(lower, [
            /\bjavascript\b/,
            /\btypescript\b/,
            /\bpython\b/,
            /\bjava\b/,
            /\bc\+\+\b/,
            /\bcode\b/,
            /\bcompiler/,
            /\beslint\b/,
            /\bdebug/
        ])
    ) {
        categories.add("code");
    }

    if (
        containsAny(lower, [
            /\bübersetz/,
            /\brechtschreib/,
            /\bgrammatik/,
            /\bzeichensetzung/,
            /\bformuliere\b/
        ])
    ) {
        categories.add("language");
    }

    if (
        containsAny(lower, [
            /\bwikipedia\b/,
            /\bwer ist\b/,
            /\bwas ist\b/,
            /\bwann wurde\b/,
            /\bdefinition\b/
        ])
    ) {
        categories.add("knowledge");
    }

    if (
        containsAny(lower, [
            /\bsha-?256\b/,
            /\bsha-?512\b/,
            /\bbase64\b/,
            /\bhash\b/,
            /\bqr-?code\b/,
            /\bbarcode\b/
        ])
    ) {
        categories.add("utility");
    }

    if (!categories.size) {
        categories.add("general");
    }

    let complexity = "low";

    if (
        text.length > 3000 ||
        containsAny(lower, [
            /\bkomplex/,
            /\barchitektur/,
            /\brace condition\b/,
            /\bgründlich analys/,
            /\bmehrstufig/,
            /\bvollständig debug/
        ])
    ) {
        complexity = "high";
    } else if (
        text.length > 800 ||
        categories.has("math") ||
        categories.has("code") ||
        /\bvergleiche\b/.test(lower) ||
        /\bbegründe\b/.test(lower)
    ) {
        complexity = "medium";
    }

    let creativity = "normal";

    if (
        /\bgeschichte\b|\bstory\b|\broman\b|\bkreativ\b/.test(lower)
    ) {
        creativity = "story";
    } else if (
        /\bideen\b|\bbrainstorm\b|\bvorschläge\b/.test(lower)
    ) {
        creativity = "ideas";
    } else if (
        categories.has("math") ||
        categories.has("code")
    ) {
        creativity = "precise";
    }

    let freshness = "static";

    if (
        /\baktuell\b|\bheute\b|\bgerade\b|\blive\b|\bneueste\b|\bnews\b|\bpreis\b/.test(lower)
    ) {
        freshness = "live";
    } else if (
        /\bdiese woche\b|\bdiesen monat\b|\bkürzlich\b/.test(lower)
    ) {
        freshness = "recent";
    }

    return {
        categories: [...categories],
        complexity,
        creativity,
        freshness,
        hasFiles
    };
}

module.exports = { classifyRequest };
