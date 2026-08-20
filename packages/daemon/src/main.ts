import {LeafRelayDaemonServer} from './server';

const server = new LeafRelayDaemonServer();

const stop = () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    void server.stop().finally(() => process.exit(0));
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', error => {
    console.error(error);
    void server.stop().finally(() => process.exit(1));
});
process.on('unhandledRejection', error => {
    console.error(error);
    void server.stop().finally(() => process.exit(1));
});

await server.start();
