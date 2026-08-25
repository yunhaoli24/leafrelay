import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {load} from 'cheerio';
import makeFetchCookie from 'fetch-cookie';
import {CookieJar} from 'tough-cookie';
import {
    BaseAPI,
    saveServerSession,
} from '../../packages/core/dist/index.js';
import {LeafRelayDaemonClient} from '../../packages/daemon/dist/index.js';
import {startServe} from '../../packages/cli/dist/index.js';

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
const leafrelayHome = join(directory, 'home');
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
process.env.LEAFRELAY_HOME = leafrelayHome;

const running = await startServe(replica);
const secondClient = await LeafRelayDaemonClient.connect({clientName:'test', clientVersion:'integration'});
const sharedReplica = await secondClient.attachReplica({directory:replica});
const observedProject = await secondClient.openProject(baseUrl.host, projectId);
let runningStopped = false;
let secondReplicaDetached = false;
const observer = {
    entry:path => secondClient.callProject(observedProject.projectKey, 'remote.entry', [path]),
    read:path => secondClient.callProject(observedProject.projectKey, 'remote.read', [path]),
    write:(path, content) => secondClient.callProject(observedProject.projectKey, 'remote.write', [path, content]),
};

async function waitFor(check, message) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (await check()) { return; }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(message);
}

async function hasCheckpoint(path) {
    try {
        const key = createHash('sha256').update(path).digest('hex');
        const record = JSON.parse(await readFile(
            join(replica, '.overleaf', 'sync', 'paths', key.slice(0, 2), `${key}.json`),
            'utf8',
        ));
        return record.path===path && typeof record.hash==='string';
    } catch {
        return false;
    }
}

try {
    const initialStatus = await secondClient.status();
    assert.equal(initialStatus.projects, 1, 'the daemon owns one project runtime');
    assert.equal(initialStatus.replicas.length, 1, 'the daemon owns one local watcher');
    assert.equal(initialStatus.replicas[0].clients, 2, 'both clients share the same replica');

    const secondReplica = join(directory, 'second-replica');
    await mkdir(join(secondReplica, '.overleaf'), {recursive:true});
    await writeFile(join(secondReplica, '.overleaf', 'settings.json'), await readFile(join(replica, '.overleaf', 'settings.json')));
    await assert.rejects(
        secondClient.attachReplica({directory:secondReplica}),
        /already synchronized/,
        'a second writable root for one project must be rejected',
    );

    await writeFile(join(replica, 'local.tex'), 'local to Overleaf\n');
    await waitFor(async () => {
        if (!await observer.entry('/local.tex')) { return false; }
        return new TextDecoder().decode(await observer.read('/local.tex'))==='local to Overleaf\n';
    }, 'a local filesystem change was not uploaded by leafrelay serve');

    await observer.write('/remote.tex', new TextEncoder().encode('Overleaf to local\n'));
    await waitFor(async () => {
        try { return await readFile(join(replica, 'remote.tex'), 'utf8')==='Overleaf to local\n'; }
        catch { return false; }
    }, 'an Overleaf change was not downloaded by leafrelay serve');

    await writeFile(join(replica, 'merge.tex'), 'first\nmiddle\nthird\n');
    await waitFor(async () => await observer.entry('/merge.tex')!==undefined && await hasCheckpoint('/merge.tex'), 'merge fixture was not checkpointed');
    await writeFile(join(replica, 'merge.tex'), 'FIRST\nmiddle\nthird\n');
    await observer.write('/merge.tex', new TextEncoder().encode('first\nmiddle\nTHIRD\n'));
    await waitFor(async () => {
        const local = await readFile(join(replica, 'merge.tex'), 'utf8');
        const remote = new TextDecoder().decode(await observer.read('/merge.tex'));
        return local==='FIRST\nmiddle\nTHIRD\n' && remote===local;
    }, 'non-overlapping local and Overleaf edits were not merged');

    await writeFile(join(replica, 'conflict.tex'), 'base\n');
    await waitFor(async () => await observer.entry('/conflict.tex')!==undefined && await hasCheckpoint('/conflict.tex'), 'conflict fixture was not checkpointed');
    let conflictPath;
    const conflictListener = secondClient.onReplicaConflict(event => { conflictPath = event.path; });
    await writeFile(join(replica, 'conflict.tex'), 'local\n');
    await observer.write('/conflict.tex', new TextEncoder().encode('remote\n'));
    await waitFor(() => conflictPath==='/conflict.tex', 'an overlapping edit did not produce a path conflict');
    await secondClient.resolveConflict({replicaId:sharedReplica.replicaId, path:'/conflict.tex', winner:'local'});
    await waitFor(async () => new TextDecoder().decode(await observer.read('/conflict.tex'))==='local\n', 'local conflict resolution was not applied');
    conflictListener.dispose();

    const previousPid = (await secondClient.status()).pid;
    process.kill(previousPid, 'SIGTERM');
    await waitFor(async () => {
        try { return (await secondClient.status()).pid!==previousPid; }
        catch { return false; }
    }, 'clients did not reconnect after the daemon restarted');
    await writeFile(join(replica, 'after-restart.tex'), 'restored watcher\n');
    await waitFor(async () => {
        if (!await observer.entry('/after-restart.tex')) { return false; }
        return new TextDecoder().decode(await observer.read('/after-restart.tex'))==='restored watcher\n';
    }, 'the replica was not restored after daemon restart');

    await running.stop();
    runningStopped = true;
    await secondClient.detachReplica(sharedReplica.replicaId);
    secondReplicaDetached = true;
    await waitFor(async () => (await secondClient.status()).replicas.length===0, 'the detached replica watcher did not stop');
    await writeFile(join(replica, 'after-detach.tex'), 'must remain local\n');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(await observer.entry('/after-detach.tex'), null, 'a replica without clients continued uploading');
    await observer.write('/after-detach-remote.tex', new TextEncoder().encode('must remain remote\n'));
    await new Promise(resolve => setTimeout(resolve, 750));
    await assert.rejects(
        readFile(join(replica, 'after-detach-remote.tex')),
        error => error?.code==='ENOENT',
        'a replica without clients continued downloading',
    );
} finally {
    if (!runningStopped) { await running.stop(); }
    if (!secondReplicaDetached) { await secondClient.detachReplica(sharedReplica.replicaId).catch(() => {}); }
    await secondClient.closeProject(observedProject.projectKey).catch(() => {});
    await secondClient.shutdownDaemon().catch(() => {});
    secondClient.close();
    await api.deleteProject(login.identity, projectId);
    await rm(directory, {recursive:true, force:true});
}
