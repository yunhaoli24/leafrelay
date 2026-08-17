import assert from 'node:assert/strict';

const baseUrl = new URL(process.env.OVERLEAF_URL ?? 'http://localhost:8080/');

const loginResponse = await fetch(new URL('login', baseUrl), { redirect: 'manual' });
assert.equal(loginResponse.status, 200, 'the Overleaf login page is available');

const loginHtml = await loginResponse.text();
assert.match(
    loginHtml,
    /<input.*name="_csrf".*value="([^"]*)">/,
    'the login page exposes the CSRF token format used by LeafRelay',
);

const cookies = loginResponse.headers.getSetCookie();
assert.ok(cookies.length > 0, 'the login page establishes a session cookie');

const socketClientResponse = await fetch(new URL('socket.io/socket.io.js', baseUrl), {
    headers: { Cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') },
    redirect: 'manual',
});
assert.equal(socketClientResponse.status, 200, 'the Socket.IO client endpoint is available');

const projectResponse = await fetch(new URL('project', baseUrl), { redirect: 'manual' });
assert.ok(
    [302, 303].includes(projectResponse.status),
    `an unauthenticated project request redirects to login, received ${projectResponse.status}`,
);
