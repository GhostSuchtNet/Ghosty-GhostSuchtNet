const crypto = require("crypto");
const mysql = require("mysql2/promise");

const COOKIE_NAME = "ghosty_session";
const MAX_FAILED_ATTEMPTS = 3;
const BLOCK_HOURS = 3;
const DEFAULT_SESSION_DAYS = 30;

function createAuth() {
    for (const key of ["DB_USER", "DB_PASSWORD", "ACCESS_CODE_PEPPER"]) {
        if (!process.env[key]) {
            throw new Error(`Fehlt in .env: ${key}`);
        }
    }

    const pepper = process.env.ACCESS_CODE_PEPPER;

    const pool = mysql.createPool({
        host: process.env.DB_HOST || "127.0.0.1",
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || "ghosty",
        charset: "utf8mb4",
        connectionLimit: 10
    });

    function hashSecret(value) {
        return crypto.createHmac("sha256", pepper).update(value).digest("hex");
    }

    function normalizeIp(ip) {
        if (!ip) return "unknown";
        return String(ip).replace(/^::ffff:/, "");
    }

    function isExpired(value) {
        return value && new Date(value) <= new Date();
    }

    async function getPermissions(codeId) {
        const [rows] = await pool.execute(
            "SELECT permission FROM code_permissions WHERE code_id = ?",
            [codeId]
        );
        return new Set(rows.map(row => row.permission));
    }

    async function clearFailedAttempts(ip) {
        await pool.execute("DELETE FROM login_security WHERE ip_address = ?", [ip]);
    }

    async function getBlockState(ip) {
        const [rows] = await pool.execute(
            "SELECT failed_attempts, blocked_until FROM login_security WHERE ip_address = ? LIMIT 1",
            [ip]
        );

        if (!rows[0]) return { blocked: false, failedAttempts: 0 };

        if (rows[0].blocked_until && new Date(rows[0].blocked_until) > new Date()) {
            return {
                blocked: true,
                failedAttempts: Number(rows[0].failed_attempts || 0),
                blockedForSeconds: Math.max(
                    1,
                    Math.ceil((new Date(rows[0].blocked_until).getTime() - Date.now()) / 1000)
                )
            };
        }

        if (rows[0].blocked_until && new Date(rows[0].blocked_until) <= new Date()) {
            await pool.execute(
                "UPDATE login_security SET failed_attempts = 0, blocked_until = NULL WHERE ip_address = ?",
                [ip]
            );
            return { blocked: false, failedAttempts: 0 };
        }

        return {
            blocked: false,
            failedAttempts: Number(rows[0].failed_attempts || 0)
        };
    }

    async function registerFailedAttempt(ip) {
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            const [rows] = await conn.execute(
                `SELECT failed_attempts, blocked_until
                 FROM login_security
                 WHERE ip_address = ?
                 FOR UPDATE`,
                [ip]
            );

            let current = 0;

            if (rows[0]) {
                if (rows[0].blocked_until && new Date(rows[0].blocked_until) > new Date()) {
                    const blockedForSeconds = Math.max(
                        1,
                        Math.ceil((new Date(rows[0].blocked_until).getTime() - Date.now()) / 1000)
                    );
                    await conn.commit();
                    return { blocked: true, remainingAttempts: 0, blockedForSeconds };
                }

                if (!rows[0].blocked_until || new Date(rows[0].blocked_until) <= new Date()) {
                    current = Number(rows[0].failed_attempts || 0);
                    if (rows[0].blocked_until) current = 0;
                }
            }

            const next = current + 1;

            if (next >= MAX_FAILED_ATTEMPTS) {
                const blockedUntil = new Date(Date.now() + BLOCK_HOURS * 60 * 60 * 1000);

                await conn.execute(
                    `INSERT INTO login_security
                        (ip_address, failed_attempts, last_failed_at, blocked_until)
                     VALUES (?, ?, NOW(), ?)
                     ON DUPLICATE KEY UPDATE
                        failed_attempts = VALUES(failed_attempts),
                        last_failed_at = NOW(),
                        blocked_until = VALUES(blocked_until)`,
                    [ip, MAX_FAILED_ATTEMPTS, blockedUntil]
                );

                await conn.commit();
                return {
                    blocked: true,
                    remainingAttempts: 0,
                    blockedForSeconds: BLOCK_HOURS * 60 * 60
                };
            }

            await conn.execute(
                `INSERT INTO login_security
                    (ip_address, failed_attempts, last_failed_at, blocked_until)
                 VALUES (?, ?, NOW(), NULL)
                 ON DUPLICATE KEY UPDATE
                    failed_attempts = VALUES(failed_attempts),
                    last_failed_at = NOW(),
                    blocked_until = NULL`,
                [ip, next]
            );

            await conn.commit();
            return {
                blocked: false,
                remainingAttempts: MAX_FAILED_ATTEMPTS - next
            };
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    }

    async function findCode(rawCode) {
        const [rows] = await pool.execute(
            `SELECT id, label, code_prefix, expires_at, enabled
             FROM access_codes
             WHERE code_hash = ?
             LIMIT 1`,
            [hashSecret(rawCode)]
        );
        return rows[0] || null;
    }

    function sessionExpiryForCode(code) {
        const normal = new Date(Date.now() + DEFAULT_SESSION_DAYS * 24 * 60 * 60 * 1000);
        if (!code.expires_at) return normal;
        const codeExpiry = new Date(code.expires_at);
        return codeExpiry < normal ? codeExpiry : normal;
    }

    async function createSession(codeId, expiresAt) {
        const rawToken = crypto.randomBytes(32).toString("base64url");
        await pool.execute(
            `INSERT INTO access_sessions
                (session_hash, code_id, expires_at, last_seen_at)
             VALUES (?, ?, ?, NOW())`,
            [hashSecret(rawToken), codeId, expiresAt]
        );
        return rawToken;
    }

    function setSessionCookie(res, token, expiresAt) {
        res.cookie(COOKIE_NAME, token, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: "/",
            expires: expiresAt
        });
    }

    function clearSessionCookie(res) {
        res.clearCookie(COOKIE_NAME, {
            httpOnly: true,
            secure: true,
            sameSite: "strict",
            path: "/"
        });
    }

    async function login(req, res) {
        const ip = normalizeIp(req.ip);
        const block = await getBlockState(ip);

        if (block.blocked) {
            return res.status(429).json({
                error: "Diese IP ist wegen zu vieler Fehlversuche vorübergehend gesperrt.",
                blocked: true,
                blockedForSeconds: block.blockedForSeconds
            });
        }

        const rawCode = String(req.body?.code || "").trim();

        if (!rawCode || rawCode.length > 200) {
            const failed = await registerFailedAttempt(ip);
            return res.status(failed.blocked ? 429 : 401).json({
                error: failed.blocked
                    ? "Zu viele Fehlversuche. Diese IP wurde für 3 Stunden gesperrt."
                    : "Ungültiger Zugangscode.",
                blocked: failed.blocked,
                remainingAttempts: failed.remainingAttempts,
                blockedForSeconds: failed.blockedForSeconds
            });
        }

        const code = await findCode(rawCode);

        if (!code || !code.enabled) {
            const failed = await registerFailedAttempt(ip);
            return res.status(failed.blocked ? 429 : 401).json({
                error: failed.blocked
                    ? "Zu viele Fehlversuche. Diese IP wurde für 3 Stunden gesperrt."
                    : "Ungültiger Zugangscode.",
                blocked: failed.blocked,
                remainingAttempts: failed.remainingAttempts,
                blockedForSeconds: failed.blockedForSeconds
            });
        }

        if (isExpired(code.expires_at)) {
            const failed = await registerFailedAttempt(ip);
            return res.status(failed.blocked ? 429 : 401).json({
                error: failed.blocked
                    ? "Zu viele Fehlversuche. Diese IP wurde für 3 Stunden gesperrt."
                    : "Dieser Zugangscode ist abgelaufen.",
                blocked: failed.blocked,
                remainingAttempts: failed.remainingAttempts,
                blockedForSeconds: failed.blockedForSeconds
            });
        }

        const permissions = await getPermissions(code.id);
        await clearFailedAttempts(ip);

        const expiresAt = sessionExpiryForCode(code);
        const token = await createSession(code.id, expiresAt);

        await pool.execute(
            "UPDATE access_codes SET last_used_at = NOW() WHERE id = ?",
            [code.id]
        );

        setSessionCookie(res, token, expiresAt);

        return res.json({
            ok: true,
            code: {
                id: code.id,
                label: code.label,
                prefix: code.code_prefix,
                expiresAt: code.expires_at
            },
            permissions: [...permissions]
        });
    }

    async function logout(req, res) {
        const rawToken = req.cookies?.[COOKIE_NAME];
        if (rawToken) {
            await pool.execute(
                "DELETE FROM access_sessions WHERE session_hash = ?",
                [hashSecret(rawToken)]
            );
        }
        clearSessionCookie(res);
        return res.json({ ok: true });
    }

    async function authMiddleware(req, res, next) {
        try {
            const rawToken = req.cookies?.[COOKIE_NAME];
            if (!rawToken) {
                return res.status(401).json({ error: "Zugangscode erforderlich." });
            }

            const [rows] = await pool.execute(
                `SELECT
                    s.id AS session_id,
                    s.code_id,
                    s.expires_at AS session_expires_at,
                    a.label,
                    a.code_prefix,
                    a.expires_at AS code_expires_at,
                    a.enabled
                 FROM access_sessions s
                 JOIN access_codes a ON a.id = s.code_id
                 WHERE s.session_hash = ?
                 LIMIT 1`,
                [hashSecret(rawToken)]
            );

            const row = rows[0];

            if (!row || !row.enabled || isExpired(row.session_expires_at) || isExpired(row.code_expires_at)) {
                if (row?.session_id) {
                    await pool.execute("DELETE FROM access_sessions WHERE id = ?", [row.session_id]);
                }
                clearSessionCookie(res);
                return res.status(401).json({
                    error: "Sitzung ungültig, abgelaufen oder Zugang deaktiviert."
                });
            }

            const permissions = await getPermissions(row.code_id);
            req.auth = {
                codeId: row.code_id,
                label: row.label,
                prefix: row.code_prefix,
                expiresAt: row.code_expires_at,
                permissions
            };

            await pool.execute(
                "UPDATE access_sessions SET last_seen_at = NOW() WHERE id = ?",
                [row.session_id]
            );

            next();
        } catch (error) {
            next(error);
        }
    }

    function requirePermission(permission) {
        return (req, res, next) => {
            if (!req.auth?.permissions?.has(permission)) {
                return res.status(403).json({
                    error: "Für diese Funktion besitzt dein Zugangscode keine Berechtigung."
                });
            }
            next();
        };
    }

    function me(req, res) {
        return res.json({
            loggedIn: true,
            code: {
                id: req.auth.codeId,
                label: req.auth.label,
                prefix: req.auth.prefix,
                expiresAt: req.auth.expiresAt
            },
            permissions: [...req.auth.permissions]
        });
    }

    return {
        pool,
        login,
        logout,
        me,
        authMiddleware,
        requirePermission
    };
}

module.exports = { createAuth };
