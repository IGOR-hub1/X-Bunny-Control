'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const ownPublic=path.resolve(__dirname,'../public');
const controlPublic=fs.existsSync(path.join(ownPublic,'affiliates-admin.html'))
  ?ownPublic:path.resolve(__dirname,'../x-bunny-control/public');

test('painel Control contém os alvos de navegação e formulários usados pelo JavaScript',
  {skip:!fs.existsSync(path.join(controlPublic,'affiliates-admin.html'))},()=>{
  const root=controlPublic;
  const html=fs.readFileSync(path.join(root,'affiliates-admin.html'),'utf8');
  const script=fs.readFileSync(path.join(root,'affiliates-admin.js'),'utf8');
  const ids=new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(match=>match[1]));
  for(const match of script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g))
    assert.ok(ids.has(match[1]),`id ausente no HTML: ${match[1]}`);
  for(const view of ['overview','partners','campaigns','codes','reports','audit','settings']){
    assert.match(html,new RegExp(`data-view="${view}"`));
    assert.match(html,new RegExp(`data-panel="${view}"`));
  }
});
test('site principal não contém rota ou menu do novo Control',
  {skip:!fs.existsSync(path.resolve(__dirname,'../server.js'))},()=>{
  const root=path.resolve(__dirname,'../public');
  for(const name of fs.readdirSync(root).filter(file=>/\.(?:html|js)$/.test(file))){
    const source=fs.readFileSync(path.join(root,name),'utf8');
    assert.doesNotMatch(source,/x-bunny-control/i,`${name} referencia o domínio administrativo`);
  }
});
