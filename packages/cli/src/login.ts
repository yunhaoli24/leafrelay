import {input, password, select} from '@inquirer/prompts';
import {BaseAPI, configPath, normalizeServerUrl, saveServerSession} from '@leafrelay/core';

export interface LoginOptions {
    cookie?: string;
    email?: string;
    password?: string;
}

export async function login(server: string, options: LoginOptions): Promise<void> {
    const url = normalizeServerUrl(server);
    const api = new BaseAPI(url);
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

    const response = cookie
        ? await api.cookiesLogin(cookie)
        : await api.passportLogin(email ?? '', secret ?? await password({message:'Password'}));
    if (response.type!=='success' || !response.identity || !response.userInfo) {
        throw new Error(response.message || `Login to ${url} failed.`);
    }

    await saveServerSession({
        url,
        userId:response.userInfo.userId,
        userEmail:response.userInfo.userEmail || email || '',
        identity:response.identity,
        updatedAt:new Date().toISOString(),
    });
    console.log(`Logged in to ${url} as ${response.userInfo.userEmail || email || response.userInfo.userId}.`);
    console.log(`Session saved to ${configPath()}.`);
}
