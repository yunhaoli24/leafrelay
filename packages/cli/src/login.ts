import {input, password, select} from '@inquirer/prompts';
import {configPath, normalizeServerUrl} from '@leafrelay/core';
import {connectCliDaemon} from './daemonClient';

export interface LoginOptions {
    cookie?: string;
    email?: string;
    password?: string;
}

export async function login(server: string, options: LoginOptions): Promise<void> {
    const url = normalizeServerUrl(server);
    const environmentCookie = process.env.LEAFRELAY_COOKIE;
    let cookie = options.cookie ?? environmentCookie;
    let email = options.email;
    let secret = options.password;

    if (!cookie && !email) {
        const method = await select({
            message:`Log in to ${url}`,
            choices:[
                {name:'Browser cookie', value:'cookie'},
                {name:'Email and password', value:'password'},
            ],
        });
        if (method==='cookie') {
            cookie = await password({message:'Cookie'});
        } else {
            email = await input({message:'Email'});
            secret = await password({message:'Password'});
        }
    }

    const client = await connectCliDaemon();
    try {
        const user = await client.login(cookie
            ? {server:url, cookie}
            : {server:url, email:email ?? '', password:secret ?? await password({message:'Password'})});
        console.log(`Logged in to ${url} as ${user.userEmail || email || user.userId}.`);
        console.log(`Session saved to ${configPath()}.`);
    } finally {
        client.close();
    }
}
