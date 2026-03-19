/**
 * Authentication helpers for k6 load tests.
 *
 * Observer uses v1-style session auth for all API calls:
 *   POST /api.php with form params: c (controller), a (action), d (JSON data), i (auth id), k (auth key)
 *
 * This approach works reliably on any Observer setup (Apache, Nginx, PHP dev server)
 * without needing app key permissions for v2 routes.
 *
 * For remote.php (device sync), auth is per-request via form-encoded id/pw.
 */

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './config.js';

/**
 * Login via the v1 API and return session credentials.
 * @returns {{ id: string, key: string }}
 */
export function login(username, password) {
    const payload = {
        c: 'account',
        a: 'login',
        d: JSON.stringify({ username, password }),
    };

    const res = http.post(`${BASE_URL}/api.php`, payload);

    const ok = check(res, {
        'login: status 200': (r) => r.status === 200,
        'login: success':    (r) => {
            try { return r.json().status === true; }
            catch (e) { return false; }
        },
    });

    if (!ok) {
        throw new Error(`Login failed: ${res.body}`);
    }

    const data = res.json().data;
    return { id: String(data.id), key: data.key };
}

/**
 * Make an authenticated v1 API call.
 *
 * All Observer API calls go through api.php with these POST params:
 *   c = controller name (e.g. 'media', 'playlists', 'timeslots')
 *   a = action/method name (e.g. 'save', 'create')
 *   d = JSON-encoded request data
 *   i = session auth ID
 *   k = session auth key
 *
 * @param {object} session - { id, key } from login()
 * @param {string} controller - controller name
 * @param {string} action - method name
 * @param {object} data - request data (will be JSON-encoded)
 * @param {object} [extraOpts] - extra k6 request options (e.g. tags)
 * @returns {object} k6 HTTP response
 */
export function apiCall(session, controller, action, data, extraOpts = {}) {
    const payload = {
        c: controller,
        a: action,
        d: JSON.stringify(data),
        i: session.id,
        k: session.key,
    };

    return http.post(`${BASE_URL}/api.php`, payload, extraOpts);
}
