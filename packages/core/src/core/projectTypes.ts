/* eslint-disable @typescript-eslint/naming-convention */

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';

export const FolderKeys: Readonly<Record<string, FolderKey>> = {
    folder: 'folders',
    doc: 'docs',
    file: 'fileRefs',
    outputs: 'outputs',
};

export interface ProjectLinkedFileProvider {
    provider: 'project_file';
    source_project_id: string;
    source_entity_path: string;
}

export interface UrlLinkedFileProvider {
    provider: 'url';
    url: string;
}

export interface FileEntity {
    _id: string;
    name: string;
    _type?: FileType;
    readonly?: boolean;
}

export interface DocumentEntity extends FileEntity {
    version?: number;
    mtime?: number;
    lastVersion?: number;
    localCache?: string;
    remoteCache?: string;
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null;
    created: string;
}

export interface OutputFileEntity extends FileEntity {
    path: string;
    url: string;
    type: string;
    build: string;
}

export interface FolderEntity extends FileEntity {
    docs: DocumentEntity[];
    fileRefs: FileRefEntity[];
    folders: FolderEntity[];
    outputs?: OutputFileEntity[];
}

export interface MemberEntity {
    _id: string;
    first_name: string;
    last_name?: string;
    email: string;
    privileges?: string;
    signUpDate?: string;
}

export interface ProjectSettingsSchema {
    learnedWords: string[];
    languages: Array<{code:string; name:string}>;
    compilers: Array<{code:string; name:string}>;
}

export interface ProjectEntity {
    _id: string;
    name: string;
    rootDoc_id: string;
    rootFolder: FolderEntity[];
    publicAccessLevel: string;
    compiler: string;
    spellCheckLanguage: string;
    deletedDocs: Array<{
        _id: string;
        name: string;
        deletedAt: string;
    }>;
    members: MemberEntity[];
    invites: MemberEntity[];
    owner: MemberEntity;
    features: Record<string, unknown>;
    settings: ProjectSettingsSchema;
}
