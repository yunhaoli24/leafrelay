import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {load} from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import {CookieJar} from 'tough-cookie';
import {
    BaseAPI,
    RemoteProject,
    saveServerSession,
    startServe,
} from '../../packages/core/dist/index.js';

const baseUrl = new URL(process.env.OVERLEAF_URL ?? 'http://localhost:8080/');
const sessionFetch = makeFetchCookie(fetch, new CookieJar());
const loginResponse = await sessionFetch(new URL('login', baseUrl));
assert.equal(loginResponse.status, 200, 'the Overleaf login page is available');
assert.ok(load(await loginResponse.text())('input[name="_csrf"]').attr('value'), 'the login page exposes a CSRF token');

const email = `leafrelay-${Date.now()}@example.com`;
const password = 'LeafRelay-Integration-2026';
const createOutput = execFileSync('docker', [
    'compose', '-f', 'test/integration/docker-compose.yml', 'exec', '-T', 'sharelatex',
    '/bin/bash', '-ce',
    `cd /overleaf/services/web && node modules/server-ce-scripts/scripts/create-user --admin --email=${email}`,
], {encoding:'utf8'});
const activationUrlText = createOutput.match(
    /https?:\/\/[^\s"\\]+\/user\/activate\?token=[a-zA-Z0-9_-]+&user_id=[a-f0-9]{24}/,
)?.[0];
assert.ok(activationUrlText, `create-user did not return an activation URL:\n${createOutput}`);
const activationUrl = new URL(activationUrlText);
activationUrl.protocol = baseUrl.protocol;
activationUrl.host = baseUrl.host;

const activationPage = await sessionFetch(activationUrl);
assert.equal(activationPage.status, 200, `activation page returned ${activationPage.status}`);
const activationHtml = await activationPage.text();
const activationForm = load(activationHtml)('form[action="/user/password/set"]');
const activationCsrf = activationForm.find('input[name="_csrf"]').attr('value');
const passwordResetToken = activationForm.find('input[name="passwordResetToken"]').attr('value');
assert.ok(activationCsrf, 'the activation page exposes a CSRF token');
assert.ok(passwordResetToken, 'the activation page exposes a password reset token');
const passwordResponse = await sessionFetch(new URL('user/password/set', baseUrl), {
    method:'POST',
    redirect:'manual',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
        passwordResetToken,
        password,
        _csrf:activationCsrf,
    }),
});
assert.ok([200, 302].includes(passwordResponse.status), `password setup returned ${passwordResponse.status}`);

const api = new BaseAPI(baseUrl.href);
const login = await api.passportLogin(email, password);
assert.equal(login.type, 'success', login.message);
assert.ok(login.identity && login.userInfo);
const created = await api.newProject(login.identity, 'LeafRelay Integration', 'none');
assert.equal(created.type, 'success', created.message);
const projectId = created.message;
assert.ok(projectId);

const directory = await mkdtemp(join(tmpdir(), 'leafrelay-integration-'));
const config = join(directory, 'leafrelay-config.json');
const replica = join(directory, 'replica');
await mkdir(join(replica, '.overleaf'), {recursive:true});
const projectUri = `overleaf-workshop://${baseUrl.host}/LeafRelay%20Integration?${encodeURIComponent(`user=${login.userInfo.userId}&project=${projectId}`)}`;
await writeFile(join(replica, '.overleaf', 'settings.json'), JSON.stringify({
    uri:projectUri,
    serverName:baseUrl.host,
    serverUrl:baseUrl.href,
    projectName:'LeafRelay Integration',
    localReplica:{settings:{}},
}, null, 2));
await saveServerSession({
    url:baseUrl.href,
    userId:login.userInfo.userId,
    userEmail:login.userInfo.userEmail,
    identity:login.identity,
    updatedAt:new Date().toISOString(),
}, config);
process.env.LEAFRELAY_CONFIG = config;

const running = await startServe(replica);
const observer = new RemoteProject(baseUrl.href, projectId, login.identity.cookies);
await observer.connect();

async function waitFor(check, message) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (await check()) { return; }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(message);
}

try {
    await writeFile(join(replica, 'local.tex'), 'local to Overleaf\n');
    await waitFor(async () => {
        if (!observer.entry('/local.tex')) { return false; }
        return new TextDecoder().decode(await observer.read('/local.tex'))==='local to Overleaf\n';
    }, 'a local filesystem change was not uploaded by leafrelay serve');

    await observer.write('/remote.tex', new TextEncoder().encode('Overleaf to local\n'));
    await waitFor(async () => {
        try { return await readFile(join(replica, 'remote.tex'), 'utf8')==='Overleaf to local\n'; }
        catch { return false; }
    }, 'an Overleaf change was not downloaded by leafrelay serve');
} finally {
    observer.disconnect();
    await running.stop();
    await api.deleteProject(login.identity, projectId);
    await rm(directory, {recursive:true, force:true});
}
