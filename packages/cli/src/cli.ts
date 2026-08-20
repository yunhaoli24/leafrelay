#!/usr/bin/env node
import {Command} from 'commander';
import {login} from './login';
import {serve} from './serve';

declare const LEAFRELAY_VERSION: string;

const program = new Command()
    .name('leafrelay')
    .description('Keep a local directory synchronized with an Overleaf project.')
    .version(LEAFRELAY_VERSION);

program.command('login')
    .description('Authenticate to Overleaf and save the session in ~/.leafrelay/config.json.')
    .argument('[server]', 'Overleaf server URL', 'https://www.overleaf.com/')
    .option('--cookie <cookie>', 'Overleaf browser cookie')
    .option('--email <email>', 'Overleaf account email')
    .option('--password <password>', 'Overleaf account password')
    .action(login);

program.command('serve')
    .description('Synchronize the current directory with its configured Overleaf project.')
    .argument('[directory]', 'Local replica directory', process.cwd())
    .action(serve);

program.parseAsync().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
