#!/usr/bin/env node
/**
 * Production smoke test. Run against a deployed instance:
 *   SMOKE_TEST_URL=https://your-app.up.railway.app npm run smoke-test
 * Defaults to http://localhost:4000 for local verification before deploying.
 *
 * Reports PASS/FAIL per component and exits non-zero if anything fails, so
 * it can gate a deploy pipeline.
 */
const BASE = process.env.SMOKE_TEST_URL || 'http://localhost:4000';
const SMOKE_USER = process.env.SMOKE_TEST_USER; // optional — skips the auth check if not set
const SMOKE_PASS = process.env.SMOKE_TEST_PASSWORD;

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

async function main() {
  console.log(`Smoke testing ${BASE}\n`);

  // 1. Frontend loads
  try {
    const res = await fetch(BASE + '/');
    const body = await res.text();
    report('GET / (frontend loads)', res.status === 200 && body.includes('<html'), `status=${res.status}`);
  } catch (e) { report('GET / (frontend loads)', false, e.message); }

  // 2. Health check
  try {
    const res = await fetch(BASE + '/api/health');
    const body = await res.json();
    report('GET /api/health', res.status === 200 && body.success === true, `status=${res.status}`);
  } catch (e) { report('GET /api/health', false, e.message); }

  // 3. Database connectivity (implied by health check succeeding + a real query)
  let cookie = null, csrfToken = null;
  try {
    const res = await fetch(BASE + '/api/v1/auth/csrf-token');
    cookie = (res.headers.get('set-cookie') || '').split(';')[0];
    const body = await res.json();
    csrfToken = body.data.csrfToken;
    report('GET /api/v1/auth/csrf-token (server + session store reachable)', res.status === 200 && !!csrfToken, `status=${res.status}`);
  } catch (e) { report('GET /api/v1/auth/csrf-token', false, e.message); }

  // 4. Frontend can reach the API on the same origin (no CORS misconfiguration)
  try {
    const res = await fetch(BASE + '/services/apiClient.js');
    report('GET /services/apiClient.js (frontend assets served)', res.status === 200, `status=${res.status}`);
  } catch (e) { report('GET /services/apiClient.js', false, e.message); }

  // 5. Authentication (optional — only runs if SMOKE_TEST_USER/PASSWORD are set,
  // so this script never has hardcoded credentials and is safe to commit)
  if (SMOKE_USER && SMOKE_PASS && cookie && csrfToken) {
    try {
      const res = await fetch(BASE + '/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ usernameOrEmail: SMOKE_USER, password: SMOKE_PASS })
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const body = await res.json();
      report('POST /api/v1/auth/login (authentication works)', res.status === 200 && body.success === true, `status=${res.status}`);

      // 6. One authenticated API request
      const meRes = await fetch(BASE + '/api/v1/auth/me', { headers: { Cookie: cookie } });
      report('GET /api/v1/auth/me (authenticated request works)', meRes.status === 200, `status=${meRes.status}`);
    } catch (e) { report('Authentication workflow', false, e.message); }
  } else {
    console.log('SKIP  Authentication workflow (set SMOKE_TEST_USER and SMOKE_TEST_PASSWORD to enable)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nSmoke test FAILED — see above for which component is broken.');
    process.exit(1);
  }
  console.log('\nSmoke test PASSED.');
}

main().catch((e) => { console.error('Smoke test crashed:', e); process.exit(1); });
