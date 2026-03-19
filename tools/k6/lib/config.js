/**
 * Configuration loader for k6 load tests.
 *
 * Reads environment variables set by run.sh (sourced from config.env)
 * and exports them as a single config object. Validates that all
 * required variables are present at import time.
 */

// Required environment variables — k6 will fail fast if any are missing.
const required = ['OB_BASE_URL', 'OB_USERNAME', 'OB_PASSWORD', 'OB_PLAYER_ID', 'OB_PLAYER_PASSWORD'];

for (const name of required) {
    if (!__ENV[name]) {
        throw new Error(`Missing required environment variable: ${name}. Check your config.env file.`);
    }
}

export const BASE_URL         = __ENV.OB_BASE_URL.replace(/\/+$/, ''); // strip trailing slash
export const USERNAME         = __ENV.OB_USERNAME;
export const PASSWORD         = __ENV.OB_PASSWORD;
export const PLAYER_ID        = __ENV.OB_PLAYER_ID;
export const PLAYER_PASSWORD  = __ENV.OB_PLAYER_PASSWORD;
export const TEST_MEDIA_ID    = __ENV.OB_TEST_MEDIA_ID || '';
export const TEST_USER_ID     = __ENV.OB_TEST_USER_ID || '1';
export const LOAD_LEVEL       = __ENV.K6_LOAD_LEVEL || '10';

// VU counts per scenario for each concurrency level.
// Weighted by scenario heaviness: media_upload is expensive, media_availability is cheap.
//
//   Level  Total VUs  Breakdown
//   ─────  ─────────  ─────────────────────────────────────────
//     10        10    upload=1  playlist=2  schedule=2  avail=3  sync=2
//    100       100    upload=10 playlist=20 schedule=20 avail=30 sync=20
//   1000      1000    upload=100 playlist=200 schedule=200 avail=300 sync=200
//
export const VU_MAP = {
    '10':   { media_upload: 1,   playlist_creation: 2,   scheduling: 2,   media_availability: 3,   playout_device_sync: 2   },
    '100':  { media_upload: 10,  playlist_creation: 20,  scheduling: 20,  media_availability: 30,  playout_device_sync: 20  },
    '1000': { media_upload: 100, playlist_creation: 200, scheduling: 200, media_availability: 300, playout_device_sync: 200 },
};

// Test duration per concurrency level.
export const DURATION_MAP = {
    '10':   '30s',
    '100':  '60s',
    '1000': '120s',
};
