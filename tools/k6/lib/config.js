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
export const LOAD_LEVEL       = __ENV.K6_LOAD_LEVEL || 'low';

// VU counts per scenario for each load level.
// Weighted by scenario heaviness: media_upload is expensive, media_availability is cheap.
export const VU_MAP = {
    low:    { media_upload: 2,   playlist_creation: 3,   scheduling: 3,   media_availability: 5,   playout_device_sync: 2  },
    medium: { media_upload: 20,  playlist_creation: 30,  scheduling: 30,  media_availability: 50,  playout_device_sync: 20 },
    high:   { media_upload: 100, playlist_creation: 200, scheduling: 200, media_availability: 500, playout_device_sync: 100 },
};

// Test duration per load level.
export const DURATION_MAP = {
    low:    '30s',
    medium: '60s',
    high:   '120s',
};
