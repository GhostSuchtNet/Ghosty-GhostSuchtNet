"use strict";

function normalizePrompt(prompt) {
    return String(prompt || "")
        .trim()
        .replace(/[−–—]/g, "-")
        .replace(/×/g, "*")
        .replace(/÷/g, "/")
        .replace(/\*\*/g, "^")
        .replace(/(\d),(\d)/g, "$1.$2");
}

function extractExpression(prompt) {
    let text = normalizePrompt(prompt);
    if (!text || text.length > 220) return null;

    text = text
        .replace(/[?!]+$/g, "")
        .trim()
        .replace(/^(?:was\s+ist|wie\s+viel\s+ist|wie\s+viel\s+sind|rechne|berechne|calculate|what\s+is)\s+/i, "")
        .trim();

    if (!text || !/[+\-*/%^]/.test(text)) return null;
    if (!/^[0-9+\-*/%^().\s]+$/.test(text)) return null;

    return text.replace(/\s+/g, "");
}

class Parser {
    constructor(input) {
        this.input = input;
        this.index = 0;
    }

    parse() {
        const value = this.parseExpression();
        if (this.index !== this.input.length) throw new Error("Ungültiger Ausdruck.");
        if (!Number.isFinite(value)) throw new Error("Das Ergebnis ist nicht endlich.");
        return value;
    }

    peek() {
        return this.input[this.index] || "";
    }

    consume(char) {
        if (this.peek() !== char) return false;
        this.index += 1;
        return true;
    }

    parseExpression() {
        let value = this.parseTerm();
        while (true) {
            if (this.consume("+")) value += this.parseTerm();
            else if (this.consume("-")) value -= this.parseTerm();
            else break;
        }
        return value;
    }

    parseTerm() {
        let value = this.parsePower();
        while (true) {
            if (this.consume("*")) value *= this.parsePower();
            else if (this.consume("/")) {
                const divisor = this.parsePower();
                if (divisor === 0) throw new Error("Division durch 0 ist nicht erlaubt.");
                value /= divisor;
            } else if (this.consume("%")) {
                const divisor = this.parsePower();
                if (divisor === 0) throw new Error("Modulo durch 0 ist nicht erlaubt.");
                value %= divisor;
            } else break;
        }
        return value;
    }

    parsePower() {
        let value = this.parseUnary();
        if (this.consume("^")) {
            value = value ** this.parsePower();
        }
        return value;
    }

    parseUnary() {
        if (this.consume("+")) return this.parseUnary();
        if (this.consume("-")) return -this.parseUnary();
        return this.parsePrimary();
    }

    parsePrimary() {
        if (this.consume("(")) {
            const value = this.parseExpression();
            if (!this.consume(")")) throw new Error("Schließende Klammer fehlt.");
            return value;
        }

        const start = this.index;
        let dots = 0;
        while (/[0-9.]/.test(this.peek())) {
            if (this.peek() === ".") dots += 1;
            if (dots > 1) throw new Error("Ungültige Zahl.");
            this.index += 1;
        }

        if (start === this.index) throw new Error("Zahl erwartet.");
        const raw = this.input.slice(start, this.index);
        if (raw === ".") throw new Error("Ungültige Zahl.");

        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error("Ungültige Zahl.");
        return value;
    }
}

function formatResult(value) {
    if (Object.is(value, -0)) value = 0;
    if (Number.isInteger(value)) return String(value);

    const rounded = Number.parseFloat(value.toPrecision(14));
    return String(rounded);
}

function trySimpleCalculation(prompt) {
    const expression = extractExpression(prompt);
    if (!expression) return null;

    try {
        const value = new Parser(expression).parse();
        return {
            expression,
            value,
            answer: formatResult(value)
        };
    } catch {
        return null;
    }
}

module.exports = {
    trySimpleCalculation
};
