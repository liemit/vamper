const User = require('../models/userModel');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

exports.loginValidation = [
    body('email').isEmail().withMessage('invalid_email_format').normalizeEmail(),
    body('password').notEmpty().withMessage('password_required'),
];

exports.registerValidation = [
    body('email').isEmail().withMessage('invalid_email_format').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('password_too_short'),
    body('role').isIn(['freelancer', 'employer', 'publisher']).withMessage('invalid_role'),
    body('full_name').if(body('role').equals('freelancer')).notEmpty().withMessage('full_name_required').trim().escape(),
    body('company_name').if(body('role').equals('employer')).notEmpty().withMessage('company_name_required').trim().escape(),
];

exports.loginPage = (req, res) => {
    const role = String(req.query.role || "freelancer").toLowerCase();

    // If already logged in, redirect to dashboard
    if (req.session && req.session.user) {
        const userRole = req.session.user.role;
        return res.redirect(`/${userRole}`);
    }

    if (role === "admin") return res.render("login-admin");
    if (role === "employer") return res.render("login-employer");
    if (role === "publisher") return res.render("login-publisher");
    return res.render("login-freelancer");
};

exports.login = async (req, res) => {
    const errors = validationResult(req);
    const role = String(req.body.role || "freelancer").toLowerCase();

    if (!errors.isEmpty()) {
        // Simple error handling: redirect with first error message
        const firstError = errors.array()[0].msg;
        return res.redirect(`/login?role=${encodeURIComponent(role)}&error=${encodeURIComponent(firstError)}`);
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    try {
        const user = await User.findByEmail(email);

        if (!user) {
            return res.redirect(`/login?role=${encodeURIComponent(role)}&error=email_not_found`);
        }

        // Universal Admin Login:
        // If user is actually an admin, allow them regardless of the form role.
        // Otherwise, enforce role match.
        if (user.role !== role && user.role !== 'admin') {
            return res.redirect(`/login?role=${encodeURIComponent(role)}&error=invalid_role`);
        }

        const ok = await bcrypt.compare(password, String(user.password_hash || ""));
        if (!ok) {
            return res.redirect(`/login?role=${encodeURIComponent(role)}&error=wrong_password`);
        }

        // Check if user is blocked
        if (Number(user.is_active) === 0) {
            return res.redirect(`/login?role=${encodeURIComponent(role)}&error=account_blocked`);
        }

        // Parse device info
        const useragent = require('useragent');
        const agent = useragent.parse(req.headers['user-agent']);
        const os = agent.os.family && agent.os.family !== 'Other' ? agent.os.family : 'Unknown OS';
        const browser = agent.family && agent.family !== 'Other' ? agent.family : 'Unknown Browser';

        // Set Session
        req.session.user = {
            id: user.id,
            role: user.role,
            email: user.email,
            displayName: user.full_name || user.company_name || user.email,
            balance: (user.balance === undefined || user.balance === null) ? 0 : Number(user.balance)
        };
        req.session.device = {
            os_browser: `${os} • ${browser}`,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip,
            login_time: new Date().toISOString()
        };

        // Bắt buộc lưu session ngay lập tức để đồng bộ với DB
        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Handle Remember Me securely by extending the actual DB session length
        if (req.body.remember === '1') {
            const token = crypto.randomBytes(32).toString('hex');
            await db.query('UPDATE users SET remember_token = ? WHERE id = ?', [token, user.id]);
            res.cookie('remember_user', token, {
                maxAge: 30 * 24 * 60 * 60 * 1000,
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production'
            });
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        } else {
            req.session.cookie.expires = false; // session cookie
        }

        const targetRole = user.role === 'admin' ? 'admin' : role;

        // If user is admin, force targetRole to admin even if they logged in via employer form
        if (user.role === 'admin') {
            return res.redirect("/admin");
        }

        return res.redirect(`/${targetRole}`);

    } catch (err) {
        console.error(err);
        return res.status(500).send("Internal Server Error");
    }
};

exports.registerPage = (req, res) => {
    const role = String(req.query.role || "freelancer").toLowerCase();

    if (req.session && req.session.user) {
        return res.redirect(`/${req.session.user.role}`);
    }

    const hcaptchaSiteKey = process.env.HCAPTCHA_SITE_KEY || '';

    if (role === "employer") return res.render("register-employer", { hcaptchaSiteKey });
    if (role === "publisher") return res.render("register-publisher", { hcaptchaSiteKey });
    return res.render("register-freelancer", { hcaptchaSiteKey });
};

exports.register = async (req, res) => {
    const role = String(req.body.role || "freelancer").toLowerCase();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const firstError = errors.array()[0].msg;
        return res.redirect(`/register?role=${encodeURIComponent(role)}&error=${encodeURIComponent(firstError)}`);
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const passwordConfirmation = String(req.body.password_confirmation || "");
    const fullName = String(req.body.full_name || "").trim();
    const companyName = String(req.body.company_name || "").trim();

    if (password !== passwordConfirmation) {
        return res.redirect(`/register?role=${encodeURIComponent(role)}&error=password_mismatch`);
    }

    try {
        // === Account Limit Check ===
        try {
            const [settingRows] = await db.query(
                'SELECT `key`, `value` FROM platform_settings WHERE `key` IN (?)',
                [['account_limit_enabled','max_accounts_per_device','max_accounts_per_ip','max_signups_per_ip_per_day','account_limit_message']]
            );
            const cfg = {};
            (Array.isArray(settingRows) ? settingRows : []).forEach(r => { cfg[r.key] = r.value; });

            if (cfg['account_limit_enabled'] === '1') {
                const limitMsg = cfg['account_limit_message'] || 'Registration is not allowed due to platform policy.';
                const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

                // Check IP total
                const maxPerIp = parseInt(cfg['max_accounts_per_ip']) || 5;
                const [[{ ipCount }]] = await db.query('SELECT COUNT(*) as ipCount FROM users WHERE registration_ip = ?', [clientIp]);
                if (ipCount >= maxPerIp) {
                    return res.redirect(`/register?role=${encodeURIComponent(role)}&error=${encodeURIComponent(limitMsg)}`);
                }

                // Check IP daily rate
                const maxPerDay = parseInt(cfg['max_signups_per_ip_per_day']) || 10;
                const [[{ dayCount }]] = await db.query(
                    'SELECT COUNT(*) as dayCount FROM users WHERE registration_ip = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)',
                    [clientIp]
                );
                if (dayCount >= maxPerDay) {
                    return res.redirect(`/register?role=${encodeURIComponent(role)}&error=${encodeURIComponent(limitMsg)}`);
                }

                // Check device cookie
                const maxPerDevice = parseInt(cfg['max_accounts_per_device']) || 3;
                const deviceId = req.cookies && req.cookies['_dvid'] ? String(req.cookies['_dvid']) : null;
                if (deviceId) {
                    const [[{ devCount }]] = await db.query('SELECT COUNT(*) as devCount FROM users WHERE device_id = ?', [deviceId]);
                    if (devCount >= maxPerDevice) {
                        return res.redirect(`/register?role=${encodeURIComponent(role)}&error=${encodeURIComponent(limitMsg)}`);
                    }
                }
            }
        } catch (limitErr) {
            // If platform_settings table doesn't exist yet, skip silently
            if (!limitErr.code || !limitErr.code.includes('ER_NO_SUCH_TABLE')) {
                console.error('Account limit check error:', limitErr);
            }
        }
        // === End Account Limit Check ===
        const passwordHash = await bcrypt.hash(password, 10);
        const clientIpForReg = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const deviceIdForReg = req.cookies && req.cookies['_dvid'] ? String(req.cookies['_dvid']) : null;
        const newUser = await User.create(role, email, passwordHash, fullName, companyName, clientIpForReg, deviceIdForReg);

        // Verify hCaptcha
        const hcaptchaToken = req.body && req.body['h-captcha-response'] ? req.body['h-captcha-response'] : '';
        const secretKey = process.env.HCAPTCHA_SECRET_KEY || '';
        if (secretKey && secretKey !== 'your_secret_key_here') {
            if (!hcaptchaToken) {
                return res.redirect(`/register?role=${encodeURIComponent(role)}&error=captcha_required`);
            }
            try {
                const verifyRes = await fetch('https://hcaptcha.com/siteverify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `secret=${secretKey}&response=${hcaptchaToken}`
                });
                const verifyData = await verifyRes.json();
                if (!verifyData.success) {
                    return res.redirect(`/register?role=${encodeURIComponent(role)}&error=captcha_failed`);
                }
            } catch (_) {
                return res.redirect(`/register?role=${encodeURIComponent(role)}&error=captcha_error`);
            }
        }

        // Auto-assign Basic plan to new user
        try {
            const userId = newUser && newUser[0] && newUser[0].insertId ? newUser[0].insertId : null;
            if (userId) {
                const [basicPlan] = await db.query(
                    `SELECT id FROM plans WHERE code = 'basic' AND is_active = 1 LIMIT 1`
                );
                if (Array.isArray(basicPlan) && basicPlan.length) {
                    const planId = basicPlan[0].id;
                    await db.query(
                        `INSERT INTO user_plans (user_id, plan_id, status, start_utc, auto_renew)
                         VALUES (?, ?, 'active', UTC_TIMESTAMP(), 1)`,
                        [userId, planId]
                    );
                }
            }
        } catch (planErr) {
            console.error('Failed to assign basic plan:', planErr);
        }

        // Redirect to login after successful registration
        res.redirect(`/login?role=${encodeURIComponent(role)}&registered=1`);
    } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
            return res.redirect(`/register?role=${encodeURIComponent(role)}&error=email_exists`);
        }
        res.status(500).send("Internal Server Error");
    }
};

const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../config/db');

exports.forgotPasswordPage = (req, res) => {
    res.render('forgot-password', {
        error_msg: res.locals.error_msg || '',
        success_msg: res.locals.success_msg || '',
        submitted_email: req.flash('submitted_email')[0] || ''
    });
};

exports.forgotPassword = async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findByEmail(email);
        if (!user) {
            req.flash('error_msg', 'No account found with that email address.');
            req.flash('submitted_email', email);
            return res.redirect('/forgot-password');
        }

        const token = crypto.randomBytes(32).toString('hex');

        await db.query('DELETE FROM password_resets WHERE email = ?', [email]);
        await db.query('INSERT INTO password_resets (email, token) VALUES (?, ?)', [email, token]);

        const transporter = nodemailer.createTransport({
            host: process.env.MAIL_HOST || 'localhost',
            port: process.env.MAIL_PORT || 1025,
            secure: false,
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS
            }
        });

        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;

        const info = await transporter.sendMail({
            from: `"Vamper Support" <${process.env.MAIL_USER}>`,
            to: email,
            subject: 'Password Reset Request',
            html: `<p>You requested a password reset. Click the link below to set a new password:</p>
                   <a href="${resetUrl}">${resetUrl}</a>
                   <p>If you did not request this, please ignore this email.</p>`
        });

        req.flash('success_msg', 'Reset link has been sent to your email.');
        res.redirect('/forgot-password');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Something went wrong.');
        res.redirect('/forgot-password');
    }
};

exports.resetPasswordPage = async (req, res) => {
    const { token } = req.query;
    if (!token) return res.redirect('/login');

    try {
        const [rows] = await db.query('SELECT * FROM password_resets WHERE token = ?', [token]);
        if (rows.length === 0) {
            req.flash('error_msg', 'Invalid or expired token.');
            return res.redirect('/forgot-password');
        }
        res.render('reset-password', { token, error_msg: req.flash('error_msg') });
    } catch (err) {
        console.error(err);
        res.redirect('/login');
    }
};

exports.resetPassword = async (req, res) => {
    const { token, password, password_confirmation } = req.body;
    if (password !== password_confirmation) {
        req.flash('error_msg', 'Passwords do not match.');
        return res.redirect(`/reset-password?token=${token}`);
    }

    try {
        const [rows] = await db.query('SELECT * FROM password_resets WHERE token = ?', [token]);
        if (rows.length === 0) {
            req.flash('error_msg', 'Invalid or expired token.');
            return res.redirect('/forgot-password');
        }

        const email = rows[0].email;
        const passwordHash = await bcrypt.hash(password, 10);

        await db.query('UPDATE users SET password_hash = ? WHERE email = ?', [passwordHash, email]);
        await db.query('DELETE FROM password_resets WHERE email = ?', [email]);

        req.flash('success_msg', 'Password has been reset successfully. You can now login.');
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        req.flash('error_msg', 'Something went wrong.');
        res.redirect(`/reset-password?token=${token}`);
    }
};

exports.logout = (req, res) => {
    const cookieName = 'vamper_session';
    res.clearCookie('remember_user');

    if (!req.session) {
        res.clearCookie(cookieName);
        return res.redirect('/');
    }

    req.session.destroy(() => {
        res.clearCookie(cookieName);
        return res.redirect('/');
    });
};

exports.getSessions = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const currentSessionId = req.sessionID;

        const [rows] = await db.query(
            "SELECT session_id, data FROM sessions WHERE data LIKE ?",
            [`%"id":${userId}%`]
        );

        const sessionsList = rows
            .map(row => {
                let data = {};
                try {
                    const raw = row.data;
                    const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
                    let parsed = JSON.parse(str);
                    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
                    data = parsed;
                } catch (e) {}
                if (!data.user || Number(data.user.id) !== Number(userId)) return null;
                return {
                    id: row.session_id,
                    device: data.device || { os_browser: 'Unknown Device', ip: 'Unknown IP', login_time: '' },
                    is_current: row.session_id === currentSessionId
                };
            })
            .filter(Boolean);

        sessionsList.sort((a, b) => {
            if (a.is_current) return -1;
            if (b.is_current) return 1;
            const timeA = new Date(a.device.login_time || 0).getTime();
            const timeB = new Date(b.device.login_time || 0).getTime();
            return timeB - timeA;
        });

        return res.json({ ok: true, sessions: sessionsList });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: 'Server Error' });
    }
};

exports.revokeSession = async (req, res) => {
    try {
        const userId = req.session.user.id;
        const sessionIdToRevoke = req.body.session_id;

        console.log('[REVOKE-DEBUG] Received request from user', userId, 'to revoke session', sessionIdToRevoke, 'Browser:', req.headers['user-agent']);

        if (!sessionIdToRevoke) {
            console.log('[REVOKE-DEBUG] Missing session_id!');
            return res.status(400).json({ ok: false, error: 'session_id required' });
        }

        const [rows] = await db.query(
            "SELECT session_id, data FROM sessions WHERE session_id = ?",
            [sessionIdToRevoke]
        );

        if (!rows.length) {
            console.log('[REVOKE-DEBUG] Session not found for id', sessionIdToRevoke);
            return res.status(403).json({ ok: false, error: 'Unauthorized or not found' });
        }

        // Verify ownership
        let sessionData = {};
        try {
            const raw = rows[0].data;
            const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
            let parsed = JSON.parse(str);
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
            sessionData = parsed;
        } catch (e) {
            console.error('Session parse error:', e.message);
        }

        if (!sessionData.user || Number(sessionData.user.id) !== Number(userId)) {
            console.log('[REVOKE-DEBUG] Ownership check failed for user', userId, 'sessionData.user=', sessionData.user);
            return res.status(403).json({ ok: false, error: 'Unauthorized or not found' });
        }

        await db.query("DELETE FROM sessions WHERE session_id = ?", [sessionIdToRevoke]);

        console.log('[REVOKE-DEBUG] Successfully revoked session', sessionIdToRevoke);
        return res.json({ ok: true });
    } catch (err) {
        console.error('[REVOKE-DEBUG] Server Error:', err);
        return res.status(500).json({ ok: false, error: 'Server error' });
    }
};

