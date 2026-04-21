/**
 * Scenario: Preview Window Encoding
 *
 * Hits the v2 preview endpoint which triggers ffmpeg transcoding on cache miss
 * and serves the cached output on cache hit. Under concurrent load, multiple
 * workers may race to transcode the same file, and even cache-hit responses
 * are not free (file read + sendfile via PHP).
 *
 * Endpoint: GET /api/v2/downloads/media/{id}/preview
 * Auth: v1 session auth via X-Auth-ID / X-Auth-Key headers
 * Response: binary (mp3 for audio, mp4 for video)
 */

import http from 'k6/http';
import { sleep, check } from 'k6';
import { BASE_URL } from '../lib/config.js';

const SCENARIO = 'preview_encoding';

export default function (data) {
    const res = http.get(`${BASE_URL}/api/v2/downloads/media/${data.mediaId}/preview`, {
        headers: {
            'X-Auth-ID':  data.session.id,
            'X-Auth-Key': data.session.key,
        },
        tags: { scenario: SCENARIO },
        responseType: 'binary',
    });

    const ok = check(res, {
        'status 200': (r) => r.status === 200,
        'has body':   (r) => r.body && r.body.byteLength > 0,
    }, { scenario: SCENARIO });

    if (!ok) {
        console.warn(`[${SCENARIO}] check failed (HTTP ${res.status})`);
    }

    sleep(0.5);
}
