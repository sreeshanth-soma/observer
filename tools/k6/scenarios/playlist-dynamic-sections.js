/**
 * Scenario: Dynamic Sections Playlist Performance
 *
 * Resolves a playlist containing many dynamic sections. Each dynamic section
 * runs a fresh search query against the media table, so resolve time scales
 * with (number of dynamic sections) × (media library size). Known perf issue:
 * a playlist with many dynamic sections recalculates on every display/edit load.
 *
 * The test playlist is created in setup() with 10 dynamic sections, each
 * selecting 5 items via a simple-mode query that matches all approved media.
 *
 * Endpoint: POST /api.php (c=playlists, a=resolve)
 * Auth: v1 session auth (i/k params)
 * Body: { id: <playlist_id>, player_id: <player_id> }
 * Response: { status: true, msg: "Playlist resolved.", data: [items...] }
 */

import { sleep } from 'k6';
import { PLAYER_ID } from '../lib/config.js';
import { apiCall } from '../lib/auth.js';
import { checkResponse } from '../lib/checks.js';

const SCENARIO = 'playlist_dynamic_sections';

export default function (data) {
    if (!data.dynamicPlaylistId) {
        return; // setup failed to create the playlist; skip iteration
    }

    const res = apiCall(data.session, 'playlists', 'resolve', {
        id:        data.dynamicPlaylistId,
        player_id: PLAYER_ID,
    }, { tags: { scenario: SCENARIO } });

    checkResponse(res, SCENARIO);

    sleep(0.5);
}
