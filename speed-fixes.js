"use strict";

(() => {
    const THINKING_KEY = "ghostAiThinking";
    const MIGRATION_KEY = "ghostAiThinkingDefaultMigratedV1";

    // Einmalige Migration vom bisherigen Standard "medium" auf "instant".
    // Nach dieser Migration bleibt jede spätere bewusste Nutzerauswahl erhalten.
    if (localStorage.getItem(MIGRATION_KEY) !== "done") {
        const current = localStorage.getItem(THINKING_KEY);
        if (current === null || current === "medium") {
            localStorage.setItem(THINKING_KEY, "instant");
        }
        localStorage.setItem(MIGRATION_KEY, "done");
    }

    function fastPythonDecision(message, fileResult) {
        const text = String(message || "").toLowerCase();

        // Tabellen-/Datendateien dürfen weiterhin automatisch Python nutzen,
        // wenn die Anfrage tatsächlich nach Auswertung/Statistik verlangt.
        const hasTabularData = Boolean(
            fileResult?.documents?.some(document =>
                ["xlsx", "text"].includes(document.kind) &&
                /\.(csv|xlsx)$/i.test(document.name)
            )
        );

        if (hasTabularData && /berech|durchschnitt|median|standardabweich|statistik|diagramm|abweich|summe|prozent|analyse|regression|korrelation/i.test(text)) {
            return true;
        }

        // Keine automatische Python-Kette mehr für einfache Rechnungen wie
        // 3+3, 500/4 oder "rechne 12*8". Das spart einen kompletten KI-Aufruf
        // für die Python-Planung plus den Sandbox-Start.
        return /\b(?:standardabweichung|statistik|matrix|gleichungssystem|simulation|regression|korrelation|integral|ableitung|numerisch|balkendiagramm|liniendiagramm|histogramm|boxplot|scatterplot)\b/i.test(text);
    }

    function applyRuntimeFixes() {
        // script.js ist ein klassisches Browser-Script. Seine globale Funktion
        // kann nach dem Laden ersetzt werden, ohne den übrigen Tool-Workflow
        // anzufassen. Explizit aktiviertes Python bleibt davon unberührt.
        if (typeof window.shouldUsePythonAutomatically === "function") {
            window.shouldUsePythonAutomatically = fastPythonDecision;
        }

        const select = document.getElementById("thinking");
        const saved = localStorage.getItem(THINKING_KEY) || "instant";
        if (select && ["instant", "low", "medium", "high"].includes(saved)) {
            select.value = saved;
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", applyRuntimeFixes, { once: true });
    } else {
        applyRuntimeFixes();
    }

    // Falls script.js seine Funktionen erst unmittelbar nach dieser Datei
    // definiert, wird der Override im nächsten Event-Loop-Durchlauf erneut gesetzt.
    setTimeout(applyRuntimeFixes, 0);
})();
