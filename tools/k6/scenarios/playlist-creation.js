/**
 * Scenario: Playlist Creation
 *
 * Creates playlists via v1 API (playlists/save).
 * Uses an empty items array (valid per the playlists controller).
 * Each playlist is marked private to avoid polluting the public catalog.
 *
 * Endpoint: POST /api.php (c=playlists, a=save)
 * Auth: v1 session auth (i/k params)
 * Body: { name, description, status, type, items }
 * Response: { status: true, msg: "...", data: <playlist_id> }
 */

import { sleep } from 'k6';
import exec from 'k6/execution';
import { apiCall } from '../lib/auth.js';
import { checkResponse } from '../lib/checks.js';

const SCENARIO = 'playlist_creation';

export default function (data) {
    const vu   = exec.vu.idInTest;
    const iter = exec.vu.iterationInScenario;

    const res = apiCall(data.session, 'playlists', 'save', {
        name:        `k6-test-${vu}-${iter}`,
        description: 'Load test playlist — safe to delete',
        status:      'private',
        type:        'standard',
        items:       [],
    }, { tags: { scenario: SCENARIO } });

    checkResponse(res, SCENARIO);

    sleep(0.5);
}
