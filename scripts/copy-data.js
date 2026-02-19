import { cpSync, mkdirSync } from 'fs';

mkdirSync('public/data/pages', { recursive: true });
cpSync('src/data', 'public/data', { recursive: true });
