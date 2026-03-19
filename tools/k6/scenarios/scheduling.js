/**
 * Scenario: Scheduling (Timeslot Creation)
 *
 * Creates timeslots via v1 API (timeslots/create).
 * Each VU/iteration uses a unique start time far in the future to avoid
 * collision errors (the timeslots controller checks for overlapping slots).
 *
 * Endpoint: POST /api.php (c=timeslots, a=create)
 * Auth: v1 session auth (i/k params)
 * Required fields: user_id, player_id, mode, start, duration
 * Response: { status: true, msg: "Timeslot added." }
 */

import { sleep } from 'k6';
import exec from 'k6/execution';
import { PLAYER_ID, TEST_USER_ID } from '../lib/config.js';
import { apiCall } from '../lib/auth.js';
import { checkResponse } from '../lib/checks.js';

const SCENARIO = 'scheduling';

/**
 * Convert a Unix timestamp to 'Y-m-d H:i:s' UTC string.
 * The timeslots model validates start with DateTime::createFromFormat('Y-m-d H:i:s').
 */
function toDatetime(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Base start time: 2 years in the future + random offset per run.
// Randomization avoids collisions when re-running the test (previous timeslots still in DB).
const RUN_OFFSET = Math.floor(Math.random() * 100000000);
const BASE_START = Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 3600 + RUN_OFFSET;

export default function (data) {
    const vu   = exec.vu.idInTest;
    const iter = exec.vu.iterationInScenario;

    // Space timeslots apart: each VU gets a 100,000s window, each iteration 7,200s (2h).
    // With 1h duration and 2h spacing, no overlaps occur.
    const startUnix = BASE_START + (vu * 100000) + (iter * 7200);

    const res = apiCall(data.session, 'timeslots', 'save', {
        user_id:     TEST_USER_ID,
        player_id:   PLAYER_ID,
        mode:        'once',
        x_data:      '',
        description: `k6-load-test vu${vu} iter${iter}`,
        start:       toDatetime(startUnix),
        duration:    3600,
    }, { tags: { scenario: SCENARIO } });

    checkResponse(res, SCENARIO);

    sleep(0.5);
}
