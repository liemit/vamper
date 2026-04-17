const path = require("path");

const express = require("express");

const session = require("express-session");

const cookieParser = require("cookie-parser");

require("dotenv").config();



// Initialize DB connection
const db = require("./config/db");
const NotificationService = require("./services/notificationService");

// Ensure required tables exist
(async () => {
    try {
        // Kiểm tra xem cột remember_token đã tồn tại chưa
        const [columns] = await db.query("SHOW COLUMNS FROM users LIKE 'remember_token'");
        if (columns.length === 0) {
            await db.query(`
                ALTER TABLE users ADD COLUMN remember_token VARCHAR(255) NULL AFTER password_hash;
            `);
            console.log('Database: Column "remember_token" added to users table.');
        } else {
            // already exists, no log needed
        }
    } catch (err) {
        console.error('Error checking/adding remember_token column:', err);
    }

    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
                id bigint UNSIGNED NOT NULL AUTO_INCREMENT,
                email varchar(190) NOT NULL,
                token varchar(255) NOT NULL,
                created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY password_resets_email_index (email)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        // Table ready, no log needed
    } catch (err) {
        console.error('Error creating password_resets table:', err);
    }
})();



const helmet = require("helmet");

const app = express();



// Middleware
app.use(
helmet({
contentSecurityPolicy: false,
})
);




app.use(express.json({ limit: '10gb' }));

app.use(express.urlencoded({ extended: true, limit: '10gb' }));

app.use(cookieParser());

// Set device ID cookie for account limit tracking
app.use((req, res, next) => {
    if (!req.cookies['_dvid']) {
        const dvid = require('crypto').randomBytes(16).toString('hex');
        res.cookie('_dvid', dvid, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    }
    next();
});



// Session Setup
const MySQLStore = require('express-mysql-session')(session);
const sessionStore = new MySQLStore({
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
  createDatabaseTable: true,
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
}, db);

app.use(session({
  key: 'vamper_session',
  secret: process.env.SESSION_SECRET || 'vamper_secret_key_123',
  store: sessionStore,
  resave: true, 
  saveUninitialized: true,
  proxy: true, // Thêm proxy: true để nhận IP thật từ các thiết bị di động/proxy
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // Tăng lên 30 ngày cho đồng bộ với Remember Me
    secure: false, 
    httpOnly: true,
    sameSite: 'lax' // Thêm sameSite: 'lax' để tăng tính tương thích trình duyệt
  }
}));



const flash = require('connect-flash');

app.use(flash());



// Maintenance Mode Middleware (Database-driven)

let maintenanceModeCache = false;

let lastMaintenanceCheck = 0;

const MAINTENANCE_CACHE_TTL = 10000; // 10 seconds cache to avoid overloading DB



// Trust proxy is required when behind Cloudflare or Nginx to get the real client IP

app.set('trust proxy', true);



app.use(async (req, res, next) => {

    // Exclude admin routes, static files, and login from maintenance

    const path = req.path;

    const isAsset = path.startsWith('/css') || path.startsWith('/js') || path.startsWith('/img') || path.endsWith('.css') || path.endsWith('.js');

    const isAdmin = path.startsWith('/admin');

    const isLogin = path.startsWith('/login') || path.startsWith('/logout');



    // Allow localhost / local IP to bypass maintenance mode completely for testing

    // When behind Cloudflare, req.ip will now be the real visitor's IP because of 'trust proxy'

    const clientIp = req.ip || req.connection.remoteAddress;

    const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';

    

    // Also allow bypass if user is logged in as admin

    const isSessionAdmin = req.session && req.session.user && req.session.user.role === 'admin';



    if (!isAsset && !isAdmin && !isLogin && !isLocalhost && !isSessionAdmin) {

        // Check DB every 10 seconds max

        const now = Date.now();

        if (now - lastMaintenanceCheck > MAINTENANCE_CACHE_TTL) {

            try {

                const [rows] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = "maintenance_mode" LIMIT 1');

                if (rows && rows.length > 0) {

                    maintenanceModeCache = rows[0].setting_value === 'true';

                }

                lastMaintenanceCheck = now;

            } catch (err) {

                console.error('Error checking maintenance mode from DB:', err);

            }

        }



        if (maintenanceModeCache) {

            return res.status(503).render('maintenance', { title: 'Under Maintenance' });

        }

    }

    next();

});



const { normalizeLang, getTranslator } = require('./i18n/translations');

const { isAuthenticated: requireAuth } = require('./middlewares/authMiddleware');

const freelancerController = require('./controllers/freelancerController');

const employerController = require('./controllers/employerController');



app.use((req, res, next) => {

  const queryLang = req.query && req.query.lang ? String(req.query.lang) : '';

  if (queryLang) {

    req.session.lang = normalizeLang(queryLang);

  }



  const sessionLang = req.session && req.session.lang ? String(req.session.lang) : '';

  const lang = normalizeLang(sessionLang);

  res.locals.lang = lang;

  res.locals.t = getTranslator(lang);

  res.locals.req = req;

  next();

});



app.use(async (req, res, next) => {

  const sessionUser = (req.session && req.session.user) ? req.session.user : null;

  const currentUser = (sessionUser && (sessionUser.id || sessionUser.email)) ? sessionUser : null;



  if (currentUser && currentUser.id) {

    try {

      const [rows] = await db.execute('SELECT balance FROM users WHERE id = ? LIMIT 1', [currentUser.id]);

      if (Array.isArray(rows) && rows.length > 0) {

        const rawBalance = rows[0].balance;

        const balance = (rawBalance === undefined || rawBalance === null) ? 0 : Number(rawBalance);

        currentUser.balance = Number.isFinite(balance) ? balance : 0;

      }

    } catch (err) {

      // ignore DB errors here to avoid breaking all pages if balance column isn't migrated yet

    }

  }



  res.locals.user = currentUser;

  res.locals.query = req.query || {};

  res.locals.success_msg = req.flash('success_msg');

  res.locals.error_msg = req.flash('error_msg');

  res.locals.fmtViews = function(n) {
    n = Number(n) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  };

  res.locals.uploadBaseUrl = process.env.UPLOAD_BASE_URL || '';

  // Load footer banners for all pages
  try {
    const [footerBanners] = await db.query(
      "SELECT * FROM banners WHERE position = 'footer' AND is_active = 1 ORDER BY sort_order ASC"
    );
    res.locals.footerBanners = Array.isArray(footerBanners) ? footerBanners : [];
  } catch (_) {
    res.locals.footerBanners = [];
  }

  next();
});



app.use(async (req, res, next) => {

  try {

    const currentUser = res.locals.user;

    let role = currentUser && currentUser.role ? String(currentUser.role).toLowerCase() : 'guest';

    if (role === 'publisher') role = 'freelancer';



    let menu = null;



    try {

      const [locRows] = await db.query(

        'SELECT menu_id FROM menu_locations WHERE location = ? AND role = ? LIMIT 1',

        ['header', role]

      );

      const loc = Array.isArray(locRows) && locRows.length ? locRows[0] : null;

      if (loc && loc.menu_id) {

        const mid = Number(loc.menu_id);

        if (Number.isFinite(mid) && mid > 0) {

          const [mRows] = await db.query('SELECT id FROM menus WHERE id = ? AND is_active = 1 LIMIT 1', [mid]);

          menu = Array.isArray(mRows) && mRows.length ? mRows[0] : null;

        }

      }



      if (!menu && role !== 'guest') {

        const [locRowsGuest] = await db.query(

          'SELECT menu_id FROM menu_locations WHERE location = ? AND role = ? LIMIT 1',

          ['header', 'guest']

        );

        const locGuest = Array.isArray(locRowsGuest) && locRowsGuest.length ? locRowsGuest[0] : null;

        if (locGuest && locGuest.menu_id) {

          const mid = Number(locGuest.menu_id);

          if (Number.isFinite(mid) && mid > 0) {

            const [mRows] = await db.query('SELECT id FROM menus WHERE id = ? AND is_active = 1 LIMIT 1', [mid]);

            menu = Array.isArray(mRows) && mRows.length ? mRows[0] : null;

          }

        }

      }

    } catch (err) {

      // table may not exist yet; ignore

      menu = null;

    }



    if (!menu || !menu.id) {

      res.locals.mainNavItems = [];

      return next();

    }



    const menuId = Number(menu.id);

    const [items] = await db.query(

      `SELECT mi.*,

              GROUP_CONCAT(mir.role) AS roles

       FROM menu_items mi

       LEFT JOIN menu_item_roles mir ON mir.menu_item_id = mi.id

       WHERE mi.menu_id = ? AND mi.is_active = 1

       GROUP BY mi.id

       ORDER BY mi.sort_order ASC, mi.id ASC`,

      [menuId]

    );



    const filtered = (Array.isArray(items) ? items : []).filter((it) => {

      const rolesCsv = it && it.roles ? String(it.roles) : '';

      const roleList = rolesCsv

        ? rolesCsv.split(',').map((r) => String(r).toLowerCase().trim()).filter(Boolean)

        : [];



      if (roleList.length > 0) {

        return roleList.includes(role);

      }



      if (it.requires_auth && !currentUser) return false;

      return true;

    });



    const byId = new Map();

    filtered.forEach((it) => {

      byId.set(Number(it.id), { ...it, children: [] });

    });



    const roots = [];

    byId.forEach((node) => {

      const parentId = node.parent_id === null || node.parent_id === undefined ? null : Number(node.parent_id);

      if (parentId && byId.has(parentId)) {

        byId.get(parentId).children.push(node);

      } else {

        roots.push(node);

      }

    });



    let categoriesNav = [];

    try {

      const [catRows] = await db.query('SELECT id, name, slug FROM categories ORDER BY id ASC');

      categoriesNav = Array.isArray(catRows) ? catRows : [];

    } catch (err) {

      categoriesNav = [];

    }



    const categoryBaseHref = role === 'freelancer' ? '/freelancer/categories/' : '/categories/';

    const catChildren = categoriesNav

      .filter((c) => c && c.slug && c.name)

      .map((c) => ({

        id: `cat_${c.id}`,

        label: String(c.name),

        url: categoryBaseHref + encodeURIComponent(String(c.slug)),

        target: '_self',

        icon: null,

        item_type: 'link',

        children: []

      }));



    const attachCategoriesToWork = (items) => {

      if (!Array.isArray(items)) return false;

      for (const it of items) {

        const rawLabel = (it && it.label !== undefined && it.label !== null) ? String(it.label) : '';

        const normalizedLabel = rawLabel.toLowerCase().trim();

        if (normalizedLabel === 'work') {

          it.children = Array.isArray(it.children) ? it.children : [];

          it.children = [...it.children, ...catChildren];

          return true;

        }

        if (it && it.children && it.children.length) {

          const ok = attachCategoriesToWork(it.children);

          if (ok) return true;

        }

      }

      return false;

    };



    res.locals.categoriesNav = categoriesNav;

    attachCategoriesToWork(roots);



    res.locals.mainNavItems = roots;

    return next();

  } catch (err) {

    res.locals.mainNavItems = [];

    return next();

  }

});



const { csrfProtection } = require('./middlewares/csrfMiddleware');

app.use(csrfProtection);



// Maintenance Mode API

app.get('/admin/maintenance/status', async (req, res) => {

    try {

        const [rows] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = "maintenance_mode" LIMIT 1');

        const isMaintenance = (rows && rows.length > 0) ? rows[0].setting_value === 'true' : false;

        res.json({ maintenance: isMaintenance });

    } catch (err) {

        res.status(500).json({ maintenance: false, error: err.message });

    }

});



app.post('/admin/maintenance/toggle', requireAuth, async (req, res) => {

    if (req.session.user && req.session.user.role === 'admin') {

        try {

            const [rows] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = "maintenance_mode" LIMIT 1');

            const currentState = (rows && rows.length > 0) ? rows[0].setting_value === 'true' : false;

            const newState = !currentState;
            
            await db.query(
                'INSERT INTO system_settings (setting_key, setting_value) VALUES ("maintenance_mode", ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [String(newState), String(newState)]
            );


            // Invalidate cache immediately for this instance

            maintenanceModeCache = newState;

            lastMaintenanceCheck = Date.now();

            

            res.json({ success: true, maintenance: newState });

        } catch (err) {

            res.status(500).json({ success: false, message: 'DB Error' });

        }

    } else {

        res.status(403).json({ success: false, message: 'Unauthorized' });

    }

});



// View Engine

app.set("views", path.join(__dirname, "views"));

app.set("view engine", "ejs");



// Static Files

app.use(express.static(path.join(__dirname, "views")));

app.use(express.static(path.join(__dirname, "public")));



// Routes

const routes = require('./routes');



// Freelancer Timesheets

app.get('/freelancer/timesheets/:id', requireAuth, freelancerController.timesheets);

app.post('/freelancer/timesheets/:id/save', requireAuth, freelancerController.saveTimesheet);



// Employer Timesheets

app.get('/employer/timesheets/:id', requireAuth, employerController.timesheets);

app.post('/employer/timesheets/:tid/approve', requireAuth, employerController.approveTimesheet);

app.post('/employer/timesheets/:tid/reject', requireAuth, employerController.rejectTimesheet);



app.use('/', routes);



const port = process.env.PORT || 3000;

// ─── Auto-renew cron job ───────────────────────────────────────────────────
// Runs every hour. Renews plans that have auto_renew=1 and are either:
//   1. Expired (end_utc < NOW())
//   2. Quota full for current month (all 3 types exceeded their monthly limit)
const pad = (n) => String(n).padStart(2, '0');

async function runAutoRenew() {
    const results = { renewed: [], skipped: [], errors: [] };
    try {
        const now = new Date();
        const pk = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}`;

        const [candidates] = await db.query(
            `SELECT up.id AS up_id, up.user_id, up.plan_id,
                    p.code AS plan_code, p.price_monthly, p.currency,
                    up.end_utc
             FROM user_plans up
             JOIN plans p ON p.id = up.plan_id
             WHERE up.status = 'active' AND up.auto_renew = 1
               AND p.is_active = 1
               AND p.price_monthly > 0
               AND (
                 up.end_utc < UTC_TIMESTAMP()
                 OR up.user_id IN (
                   SELECT uu.user_id FROM upload_usage uu
                   JOIN plan_limits pl_img ON pl_img.plan_id = up.plan_id AND pl_img.kind = 'image' AND pl_img.is_active = 1
                   JOIN plan_limits pl_vid ON pl_vid.plan_id = up.plan_id AND pl_vid.kind = 'video' AND pl_vid.is_active = 1
                   JOIN plan_limits pl_fil ON pl_fil.plan_id = up.plan_id AND pl_fil.kind = 'file'  AND pl_fil.is_active = 1
                   WHERE uu.user_id = up.user_id AND uu.period_key = ?
                     AND uu.image_bytes >= (pl_img.monthly_quota_mb * 1024 * 1024)
                     AND uu.video_bytes >= (pl_vid.monthly_quota_mb * 1024 * 1024)
                     AND uu.file_bytes  >= (pl_fil.monthly_quota_mb * 1024 * 1024)
                 )
               )`,
            [pk]
        );

        if (!Array.isArray(candidates) || !candidates.length) {
            console.log('[AutoRenew] No candidates found.');
            return results;
        }

        for (const row of candidates) {
            try {
                const price = Number(row.price_monthly || 0);
                const userId = row.user_id;
                const planId = row.plan_id;
                const planCode = row.plan_code;

                if (price > 0) {
                    const [upd] = await db.execute(
                        `UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
                        [price, userId, price]
                    );
                    if (!upd || !upd.affectedRows) {
                        await db.execute(
                            `UPDATE user_plans SET auto_renew = 0 WHERE id = ?`,
                            [row.up_id]
                        );
                        console.log(`[AutoRenew] User ${userId}: insufficient balance, auto_renew disabled.`);
                        results.skipped.push({ userId, planCode, reason: 'Insufficient balance' });

                        // Notify user: insufficient balance
                        await NotificationService.createPersonal(
                            userId,
                            '⚠️ Auto-renew failed — Insufficient balance',
                            `Your ${planCode} plan could not be renewed automatically because your balance is insufficient.\n\nPlan: ${planCode}\nPrice: ${price} USD\n\nPlease top up your balance and reactivate your plan manually to continue enjoying uninterrupted service.`,
                            'billing',
                            '/freelancer/profile#pane-plan',
                            'warning'
                        );

                        continue;
                    }
                    await db.execute(
                        `INSERT INTO transactions (user_id, amount, type, status, description, related_contract_id)
                         VALUES (?, ?, 'service_fee', 'completed', ?, NULL)`,
                        [userId, price, `Auto-renew: ${planCode}`]
                    );
                }

                const y = now.getUTCFullYear();
                const m = now.getUTCMonth();
                const next = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
                const end = new Date(next.getTime() - 1000);
                const endStr = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())} ${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}`;

                await db.query(
                    `UPDATE user_plans SET status = 'canceled' WHERE user_id = ? AND status = 'active'`,
                    [userId]
                );
                await db.query(
                    `INSERT INTO user_plans (user_id, plan_id, status, start_utc, end_utc, auto_renew)
                     VALUES (?, ?, 'active', UTC_TIMESTAMP(), ?, 1)`,
                    [userId, planId, endStr]
                );
                await db.query(
                    `DELETE FROM upload_usage WHERE user_id = ? AND period_key = ?`,
                    [userId, pk]
                );

                console.log(`[AutoRenew] User ${userId} renewed plan "${planCode}" until ${endStr}`);
                results.renewed.push({ userId, planCode, newEndUtc: endStr, charged: price });

                // Notify user: renewal successful
                const chargedText = price > 0 ? `\n💳 Amount charged: ${price} USD` : '';
                await NotificationService.createPersonal(
                    userId,
                    `✅ Your ${planCode} plan has been renewed`,
                    `Your subscription has been automatically renewed successfully.\n\n📦 Plan: ${planCode.charAt(0).toUpperCase() + planCode.slice(1)}${chargedText}\n📅 Valid until: ${endStr} (UTC)\n🔄 Auto-renew: Enabled\n\nYour upload quota has been reset for the new period. You can continue uploading files without interruption.\n\nThank you for using Vamper!`,
                    'billing',
                    '/freelancer/profile#pane-plan',
                    'success'
                );
            } catch (innerErr) {
                console.error(`[AutoRenew] Error renewing user ${row.user_id}:`, innerErr.message);
                results.errors.push({ userId: row.user_id, error: innerErr.message });
            }
        }
    } catch (err) {
        console.error('[AutoRenew] Job error:', err.message);
        results.errors.push({ error: err.message });
    }
    return results;
}

// Export for use in admin controller
module.exports.runAutoRenew = runAutoRenew;

// Run once on startup, then every hour
runAutoRenew();
setInterval(runAutoRenew, 60 * 60 * 1000);
// ──────────────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  const c = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    bgBlue: '\x1b[44m',
    white: '\x1b[37m',
  };

  const line = `${c.gray}${'─'.repeat(52)}${c.reset}`;
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  console.log('');
  console.log(line);
  console.log(`  ${c.bgBlue}${c.white}${c.bright}  VAMPER  ${c.reset}  ${c.bright}${c.cyan}Freelance Marketplace${c.reset}`);
  console.log(line);
  console.log(`  ${c.green}✔${c.reset}  Status   ${c.bright}Running${c.reset}`);
  console.log(`  ${c.blue}🌐${c.reset}  Local    ${c.cyan}http://localhost:${port}${c.reset}`);
  console.log(`  ${c.magenta}🗄${c.reset}  Database ${c.green}Connected${c.reset}`);
  console.log(`  ${c.yellow}⏰${c.reset}  Started  ${c.gray}${now}${c.reset}`);
  console.log(`  ${c.gray}📋  Mode     ${process.env.NODE_ENV || 'development'}${c.reset}`);
  console.log(line);
  console.log('');
});

