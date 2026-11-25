import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const shared=path.dirname(fileURLToPath(import.meta.url));
const roots=path.basename(shared)==='shared'
  ?[path.resolve(shared,'../public')]
  :['control','partners'].map(role=>path.resolve(shared,`../x-bunny-${role}/public`));
for(const root of roots){
  for(const name of fs.readdirSync(root).filter(file=>file.endsWith('.html'))){
    const html=fs.readFileSync(path.join(root,name),'utf8');
    for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
      const ref=match[1].split('?')[0];
      if(!ref||ref.startsWith('#')||ref.startsWith('https:')||ref.startsWith('data:')||ref.startsWith('/'))continue;
      if(!fs.existsSync(path.join(root,ref)))throw new Error(`${root}/${name} referencia arquivo ausente: ${ref}`);
    }
  }
}
console.log('Referências locais dos painéis disponíveis: OK');
