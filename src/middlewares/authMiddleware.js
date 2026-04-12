const User = require('../models/userModel');
const db = require('../config/db');

exports.isAuthenticated = async (req, res, next) => {
    const ensureDevice = () => {
        if (!req.session.device) {
            const useragent = require('useragent');
            const agent = useragent.parse(req.headers['user-agent']);
            const os = agent.os.family && agent.os.family !== 'Other' ? agent.os.family : 'Unknown OS';
            const browser = agent.family && agent.family !== 'Other' ? agent.family : 'Unknown Browser';
            req.session.device = {
                os_browser: `${os} • ${browser}`,
                ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                login_time: new Date().toISOString()
            };
        }
    };

    if (req.session && req.session.user) {
        // [DEBUG]
        // console.log('[AUTH-DEBUG] User:', req.session.user.email, 'SID:', req.sessionID);
        // console.log('[AUTH-DEBUG] User-Agent:', req.headers['user-agent']);
        // console.log('[AUTH-DEBUG] Cookies:', req.cookies);

        // Kiểm tra xem session còn tồn tại trong Database không (đề phòng trường hợp bị Revoke từ xa)
        try {
            const currentSessionId = req.sessionID;
            const [rows] = await db.query('SELECT session_id FROM sessions WHERE session_id = ?', [currentSessionId]);
            
            if (rows.length === 0) {
                console.log('[AUTH-DEBUG] Session NOT found in DB. Logging out:', currentSessionId);
                return req.session.destroy((err) => {
                    if (err) console.error('Session destroy error:', err);
                    res.clearCookie('vamper_session');
                    res.clearCookie('remember_user');
                    return res.redirect('/login');
                });
            }
        } catch (err) {
            console.error('Session DB check error:', err);
        }

        // Cập nhật cookie Remember Me nếu có thay đổi session (để đồng bộ)
        if (req.cookies.remember_user) {
            const userId = req.session.user.id;
            const [userRows] = await db.query('SELECT remember_token FROM users WHERE id = ?', [userId]);
            if (userRows.length > 0 && userRows[0].remember_token !== req.cookies.remember_user) {
                // Token không khớp nữa (có thể đã logout ở thiết bị khác và xóa token)
                res.clearCookie('remember_user');
            }
        }

        ensureDevice();
        try {
            const u = req.session.user;
            if (u && (u.is_active === 0 || u.is_active === false)) {
                try { req.session.destroy(() => {}); } catch (_) {}
                return res.redirect('/login');
            }
            if (u && u.banned_until) {
                const d = new Date(u.banned_until);
                if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now()) {
                    try { req.session.destroy(() => {}); } catch (_) {}
                    return res.redirect('/login');
                }
            }
        } catch (_) {}
        return next();
    }



    return res.redirect('/login');
};

exports.restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!req.session.user) {
            return res.redirect('/login');
        }

        const userRole = req.session.user.role;


        if (roles.includes(userRole) || userRole === 'admin') {

            if (userRole === 'admin') {

                if (roles.includes('admin')) {
                    return next();
                }
                return res.redirect('/admin');
            }

            return next();
        }

        // Role mismatch
        return res.redirect('/');
    };
};
