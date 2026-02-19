import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'fs';

mkdirSync('public/data/pages', { recursive: true });
cpSync('src/data', 'public/data', { recursive: true });

// Generate pages manifest so the CMS editor can discover all pages dynamically
const pageFiles = readdirSync('src/data/pages')
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''));
writeFileSync('public/data/pages-manifest.json', JSON.stringify(pageFiles));
