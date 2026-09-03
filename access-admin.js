require("dotenv").config();

const crypto = require("crypto");
const mysql = require("mysql2/promise");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

for (const key of ["DB_USER", "DB_PASSWORD", "ACCESS_CODE_PEPPER"]) {
    if (!process.env[key]) {
        console.error(`Fehlt in .env: ${key}`);
        process.exit(1);
    }
}

const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "ghosty",
    charset: "utf8mb4",
    connectionLimit: 3
});

const PEPPER = process.env.ACCESS_CODE_PEPPER;

const PERMISSIONS = [
    ["feature.chat", "Chat verwenden"],
    ["model.ghosty-lite", "Ghosty Lite (Qwen 3.5 4B)"],
    ["model.ghosty-medium", "Ghosty Medium (Qwen 3.6 35B-A3B)"],
    ["model.ghosty-high", "Ghosty High (späteres großes Lokalmodell)"],
    ["model.qwen-cloud", "Qwen 3.8 27B Cloud"],
    ["model.gpt-oss", "GPT-OSS 120B"],
    ["model.gemini", "Gemini 3.7 Flash"],
    ["feature.vision", "Bildanalyse"],
    ["feature.code-export", "Code herunterladen"],
    ["feature.image-generation", "Bildgenerierung"],
    ["feature.music-generation", "Musikgenerierung"],
    ["feature.sound-generation", "Soundgenerierung"],
    ["feature.video-generation", "Videogenerierung"]
];

function hashSecret(value) {
    return crypto.createHmac("sha256", PEPPER).update(value).digest("hex");
}

function makeAccessCode() {
    return `GHST_${crypto.randomBytes(24).toString("base64url")}`;
}

function prefixOf(code) {
    return code.slice(0, 13);
}

function formatDate(value) {
    if (!value) return "unbegrenzt";
    return new Intl.DateTimeFormat("de-DE", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Berlin"
    }).format(new Date(value));
}

function statusOf(row) {
    if (!row.enabled) return "deaktiviert";
    if (row.expires_at && new Date(row.expires_at) <= new Date()) return "abgelaufen";
    return "aktiv";
}

async function askYesNo(rl, label, current = null) {
    const suffix = current === null ? "[j/n]" : current ? "[J/n]" : "[j/N]";
    while (true) {
        const answer = (await rl.question(`${label} ${suffix}: `)).trim().toLowerCase();
        if (!answer && current !== null) return current;
        if (["j", "ja", "y", "yes"].includes(answer)) return true;
        if (["n", "nein", "no"].includes(answer)) return false;
        console.log("Bitte nur j oder n eingeben.");
    }
}

async function askDuration(rl) {
    const allowed = new Set(["0", "1", "3", "5", "7", "14"]);
    console.log("\nGültigkeit:");
    console.log("  1  = 1 Tag");
    console.log("  3  = 3 Tage");
    console.log("  5  = 5 Tage");
    console.log("  7  = 7 Tage");
    console.log(" 14  = 14 Tage");
    console.log("  0  = unbegrenzt\n");

    while (true) {
        const answer = (await rl.question("> ")).trim();
        if (allowed.has(answer)) return Number(answer);
        console.log("Bitte nur 0, 1, 3, 5, 7 oder 14 eingeben.");
    }
}

async function askPermissions(rl, currentPermissions = null) {
    const selected = [];
    console.log("\nBerechtigungen:\n");

    for (const [permission, label] of PERMISSIONS) {
        const current = currentPermissions ? currentPermissions.has(permission) : null;
        if (await askYesNo(rl, label.padEnd(29), current)) {
            selected.push(permission);
        }
    }

    return selected;
}

async function createCode(rl) {
    console.log("\n╔══════════════════════════════════╗");
    console.log("║       Ghosty Code Generator      ║");
    console.log("╚══════════════════════════════════╝\n");

    const label = (await rl.question("Bezeichnung (z. B. Max, Master, Test): ")).trim() || null;
    const days = await askDuration(rl);
    const permissions = await askPermissions(rl);

    if (permissions.length === 0) {
        const ok = await askYesNo(rl, "\nKeine Berechtigung ausgewählt. Trotzdem erstellen?", false);
        if (!ok) {
            console.log("Abgebrochen.");
            return;
        }
    }

    const code = makeAccessCode();
    const codeHash = hashSecret(code);
    const prefix = prefixOf(code);
    const expiresAt = days === 0 ? null : new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.execute(
            `INSERT INTO access_codes
                (label, code_prefix, code_hash, expires_at, enabled)
             VALUES (?, ?, ?, ?, TRUE)`,
            [label, prefix, codeHash, expiresAt]
        );

        for (const permission of permissions) {
            await conn.execute(
                "INSERT INTO code_permissions (code_id, permission) VALUES (?, ?)",
                [result.insertId, permission]
            );
        }

        await conn.commit();

        console.log("\n========================================");
        console.log("ZUGANGSCODE ERSTELLT");
        console.log("========================================");
        console.log(`ID: ${result.insertId}`);
        console.log(`Name: ${label || "-"}`);
        console.log(`Gültig bis: ${formatDate(expiresAt)}`);
        console.log("\nCode:\n");
        console.log(code);
        console.log("\nACHTUNG:");
        console.log("Der vollständige Code wird nicht gespeichert.");
        console.log("Kopiere ihn jetzt an einen sicheren Ort.");
        console.log("========================================\n");
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function listCodes() {
    const [rows] = await pool.execute(
        `SELECT
            a.id,
            a.label,
            a.code_prefix,
            a.expires_at,
            a.enabled,
            a.last_used_at,
            GROUP_CONCAT(cp.permission ORDER BY cp.permission SEPARATOR ', ') AS permissions
         FROM access_codes a
         LEFT JOIN code_permissions cp ON cp.code_id = a.id
         GROUP BY a.id
         ORDER BY a.id DESC`
    );

    if (!rows.length) {
        console.log("Noch keine Zugangscodes vorhanden.");
        return;
    }

    console.table(rows.map(row => ({
        ID: row.id,
        Name: row.label || "-",
        Prefix: row.code_prefix,
        Ablauf: formatDate(row.expires_at),
        Status: statusOf(row),
        "Zuletzt benutzt": row.last_used_at ? formatDate(row.last_used_at) : "-"
    })));

    console.log("\nBerechtigungen:");
    for (const row of rows) {
        console.log(`#${row.id} ${row.label || "-"}: ${row.permissions || "(keine)"}`);
    }
}

async function getCode(id) {
    const [rows] = await pool.execute(
        "SELECT * FROM access_codes WHERE id = ? LIMIT 1",
        [id]
    );
    return rows[0] || null;
}

async function editCode(rl, id) {
    const code = await getCode(id);
    if (!code) {
        console.error(`Kein Zugangscode mit ID ${id} gefunden.`);
        return;
    }

    const [permRows] = await pool.execute(
        "SELECT permission FROM code_permissions WHERE code_id = ?",
        [id]
    );
    const currentPermissions = new Set(permRows.map(row => row.permission));

    console.log(`\nBearbeite #${id} (${code.label || code.code_prefix})`);
    console.log("Bei den j/n-Fragen kannst du ENTER drücken, um den bisherigen Wert zu behalten.");

    const permissions = await askPermissions(rl, currentPermissions);
    const labelAnswer = await rl.question(
        `\nNeue Bezeichnung [aktuell: ${code.label || "-"}] (ENTER = behalten): `
    );
    const newLabel = labelAnswer.trim() ? labelAnswer.trim() : code.label;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute("UPDATE access_codes SET label = ? WHERE id = ?", [newLabel, id]);
        await conn.execute("DELETE FROM code_permissions WHERE code_id = ?", [id]);

        for (const permission of permissions) {
            await conn.execute(
                "INSERT INTO code_permissions (code_id, permission) VALUES (?, ?)",
                [id, permission]
            );
        }

        await conn.commit();
        console.log(`Zugangscode #${id} wurde aktualisiert.`);
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

async function setEnabled(id, enabled) {
    const [result] = await pool.execute(
        "UPDATE access_codes SET enabled = ? WHERE id = ?",
        [enabled, id]
    );

    if (result.affectedRows === 0) {
        console.error(`Kein Zugangscode mit ID ${id} gefunden.`);
        return;
    }

    if (!enabled) {
        await pool.execute("DELETE FROM access_sessions WHERE code_id = ?", [id]);
    }

    console.log(enabled
        ? `Zugangscode #${id} ist wieder aktiviert.`
        : `Zugangscode #${id} wurde deaktiviert. Bestehende Sessions wurden gelöscht.`);
}

async function deleteCode(rl, id) {
    const code = await getCode(id);
    if (!code) {
        console.error(`Kein Zugangscode mit ID ${id} gefunden.`);
        return;
    }

    const ok = await askYesNo(
        rl,
        `Zugangscode #${id} (${code.label || code.code_prefix}) wirklich endgültig löschen?`,
        false
    );

    if (!ok) {
        console.log("Abgebrochen.");
        return;
    }

    await pool.execute("DELETE FROM access_codes WHERE id = ?", [id]);
    console.log(`Zugangscode #${id} wurde gelöscht.`);
}

async function migratePermissions() {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [oldRows] = await conn.execute(
            "SELECT code_id FROM code_permissions WHERE permission = 'model.local-qwen'"
        );

        for (const row of oldRows) {
            await conn.execute(
                `INSERT INTO code_permissions (code_id, permission)
                 SELECT ?, ?
                 WHERE NOT EXISTS (
                     SELECT 1 FROM code_permissions
                     WHERE code_id = ? AND permission = ?
                 )`,
                [row.code_id, "model.ghosty-medium", row.code_id, "model.ghosty-medium"]
            );
        }

        const [deleted] = await conn.execute(
            "DELETE FROM code_permissions WHERE permission = 'model.local-qwen'"
        );

        await conn.commit();

        console.log("\nBerechtigungs-Migration abgeschlossen.");
        console.log(`Alte model.local-qwen Einträge entfernt: ${deleted.affectedRows}`);
        console.log("Bestehende lokale Rechte heißen jetzt model.ghosty-medium.\n");
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

function usage() {
    console.log(`
Ghosty Zugangscode-Verwaltung

Befehle:
  node access-admin.js create
  node access-admin.js list
  node access-admin.js edit ID
  node access-admin.js disable ID
  node access-admin.js enable ID
  node access-admin.js delete ID
  node access-admin.js migrate-permissions
`);
}

async function main() {
    const command = process.argv[2];
    const id = Number(process.argv[3]);
    const rl = readline.createInterface({ input, output });

    try {
        await pool.query("SELECT 1");

        switch (command) {
            case "create":
                await createCode(rl);
                break;
            case "list":
                await listCodes();
                break;
            case "edit":
                if (!Number.isInteger(id) || id <= 0) return usage();
                await editCode(rl, id);
                break;
            case "disable":
                if (!Number.isInteger(id) || id <= 0) return usage();
                await setEnabled(id, false);
                break;
            case "enable":
                if (!Number.isInteger(id) || id <= 0) return usage();
                await setEnabled(id, true);
                break;
            case "delete":
                if (!Number.isInteger(id) || id <= 0) return usage();
                await deleteCode(rl, id);
                break;
            case "migrate-permissions":
                await migratePermissions();
                break;
            default:
                usage();
        }
    } catch (error) {
        console.error("\nFehler:", error.message);
        process.exitCode = 1;
    } finally {
        rl.close();
        await pool.end();
    }
}

main();
