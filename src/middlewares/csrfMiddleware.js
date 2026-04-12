const uid = require('uid-safe');

exports.csrfProtection = async (req, res, next) => {
    // 1. Generate token if it doesn't exist
    if (!req.session.csrfToken) {
        req.session.csrfToken = await uid(18); // Generates a random string
        // Ensure token is persisted before the next request (fixes occasional mismatch issues)
        if (typeof req.session.save === 'function') {
            return req.session.save((err) => {
                if (err) return next(err);
                res.locals.csrfToken = req.session.csrfToken;
                return next();
            });
        }
    }

    // 2. Share token with views
    res.locals.csrfToken = req.session.csrfToken;

    // 3. Verify token on POST, PUT, DELETE requests
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const tokenFromForm =
            (req.body && req.body._csrf) ||
            (req.query && req.query._csrf) ||
            req.get('csrf-token') ||
            req.get('x-csrf-token');

        if (!tokenFromForm || tokenFromForm !== req.session.csrfToken) {
            return res.status(403).send('Forbidden: Invalid CSRF Token');
        }
    }

    next();
};
