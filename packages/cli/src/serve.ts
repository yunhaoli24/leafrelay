import {startServe} from '@leafrelay/core';

export async function serve(directory=process.cwd()):Promise<void> {
    const running = await startServe(directory);
    await new Promise<void>((resolveStop) => {
        const stop = () => {
            process.off('SIGINT', stop);
            process.off('SIGTERM', stop);
            running.stop().then(resolveStop, error => {
                console.error(error);
                resolveStop();
            });
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
    });
}
