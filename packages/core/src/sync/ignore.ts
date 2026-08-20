import {minimatch} from 'minimatch';

export const DEFAULT_IGNORE_PATTERNS = [
    '**/.*',
    '**/.*/**',
    '**/*.aux',
    '**/__latexindent*',
    '**/*.bbl',
    '**/*.bcf',
    '**/*.blg',
    '**/*.fdb_latexmk',
    '**/*.fls',
    '**/*.lof',
    '**/*.log',
    '**/*.lot',
    '**/*.out',
    '**/*.run.xml',
    '**/*.synctex(busy)',
    '**/*.synctex.gz',
    '**/*.toc',
    '**/*.xdv',
    '**/main.pdf',
    '**/output.pdf',
];

export function createIgnoreMatcher(patterns:unknown): (path:string)=>boolean {
    const configured = Array.isArray(patterns)
        ? patterns.filter((pattern):pattern is string => typeof pattern==='string')
        : [];
    const allPatterns = [...DEFAULT_IGNORE_PATTERNS, ...configured];
    return path => {
        const normalized = path.replace(/^\/+/, '');
        return normalized.split('/').some(part => part.startsWith('.')) ||
            allPatterns.some(pattern => minimatch(normalized, pattern, {dot:true}));
    };
}
