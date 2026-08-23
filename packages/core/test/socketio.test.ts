import {describe, expect, it} from 'vitest';
import type {BaseAPI, Identity} from '../src/api/base';
import {SocketIOAPI, type OnlineUserSchema} from '../src/api/socketio';
import type {ProjectEntity} from '../src/core/projectTypes';

class FakeSocket {
    private readonly listeners = new Map<string,Array<(...args:any[]) => void>>();
    readonly outbound:Array<{event:string; args:any[]}> = [];
    readonly io = {reconnect:() => {}};
    projectJoinCount = 0;

    on(event:string, handler:(...args:any[]) => void) {
        const handlers = this.listeners.get(event) ?? [];
        handlers.push(handler);
        this.listeners.set(event, handlers);
        return this;
    }

    emit(event:string, ...args:any[]) {
        this.outbound.push({event, args});
        return this;
    }

    serverEmit(event:string, ...args:any[]) {
        for (const handler of this.listeners.get(event) ?? []) { handler(...args); }
    }

    markProjectJoined() { this.projectJoinCount += 1; }

    removeAllListeners() { this.listeners.clear(); }
    disconnect() {}
}

function project(name:string):ProjectEntity {
    return {
        _id:`project-${name}`,
        name,
        rootDoc_id:'',
        rootFolder:[{_id:`root-${name}`, name:'root', folders:[], docs:[], fileRefs:[], _type:'folder'}],
        publicAccessLevel:'private',
        compiler:'pdflatex',
        spellCheckLanguage:'en',
        deletedDocs:[],
        members:[],
        invites:[],
        owner:{} as ProjectEntity['owner'],
        features:{},
        settings:{},
    };
}

describe('SocketIOAPI realtime reconnect', () => {
    it('waits for the new project session and blocks operations until it is joined', async () => {
        const socket = new FakeSocket();
        const api = {
            _initSocketV0:() => socket,
        } as unknown as BaseAPI;
        const identity = {cookies:'session=value', csrfToken:'token'} as Identity;
        const client = new SocketIOAPI('https://www.overleaf.com', api, identity, 'project-id');
        const disconnected:unknown[] = [];
        const joined:string[] = [];
        client.updateEventHandlers({
            onDisconnected:reason => disconnected.push(reason),
            onProjectJoined:value => joined.push(value.name),
        });

        const firstJoin = client.joinProject('project-id');
        socket.serverEmit('joinProjectResponse', {publicId:'public-1', project:project('first')});
        expect((await firstJoin).name).toBe('first');

        socket.serverEmit('disconnect', 'transport close (code 1006)');
        const secondJoin = client.joinProject('project-id');
        let secondJoinSettled = false;
        void secondJoin.then(() => { secondJoinSettled = true; });

        const users = client.getConnectedUsers();
        await Promise.resolve();
        expect(secondJoinSettled).toBe(false);
        expect(socket.outbound.some(item => item.event==='clientTracking.getConnectedUsers')).toBe(false);

        socket.serverEmit('joinProjectResponse', {publicId:'public-2', project:project('second')});
        expect((await secondJoin).name).toBe('second');
        await Promise.resolve();

        const request = socket.outbound.find(item => item.event==='clientTracking.getConnectedUsers');
        expect(request).toBeDefined();
        const connectedUsers:OnlineUserSchema[] = [];
        request!.args.at(-1)(undefined, connectedUsers);
        expect(await users).toEqual([]);
        expect(disconnected).toEqual(['transport close (code 1006)']);
        expect(joined).toEqual(['first', 'second']);
        expect(socket.projectJoinCount).toBe(2);
    });
});
