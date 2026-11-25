import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const shared=path.dirname(fileURLToPath(import.meta.url));
const role=process.argv[2];
if(!['control','partners'].includes(role))throw new Error('Painel inválido.');
// A mesma fonte funciona no monorepo e dentro de cada painel publicado sozinho.
const project=path.basename(shared)==='shared'
  ?path.resolve(shared,'..')
  :path.resolve(shared,'..',`x-bunny-${role}`);
const publicDir=path.join(project,'public');
const configured=String(process.env.X_BUNNY_SITE_URL||'');
let site;
try{site=new URL(configured);}catch{throw new Error('Configure X_BUNNY_SITE_URL com a origem HTTPS do site X-Bunny Animes.');}
if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)
  throw new Error('X_BUNNY_SITE_URL deve ser uma origem HTTPS, sem caminho ou parâmetros.');

fs.mkdirSync(publicDir,{recursive:true});
fs.copyFileSync(path.join(shared,'firebase-config.js'),path.join(publicDir,'firebase-config.js'));
fs.copyFileSync(path.join(shared,'login.js'),path.join(publicDir,'login.js'));
fs.copyFileSync(path.join(shared,'login.css'),path.join(publicDir,'login.css'));
fs.copyFileSync(path.join(shared,'panel.css'),path.join(publicDir,'panel.css'));
fs.writeFileSync(path.join(publicDir,'site-config.js'),
  `window.X_BUNNY_SITE_ORIGIN=${JSON.stringify(site.origin)};\n`);

const panel=role==='control'?'affiliates-admin.html':'affiliate.html';
const title=role==='control'?'Admin Supremo':'Painel dos parceiros';
const action=role==='control'?'adminData':'report';
fs.writeFileSync(path.join(publicDir,'login-config.js'),
  `window.X_BUNNY_LOGIN=${JSON.stringify({panel,action,title})};\n`);
fs.writeFileSync(path.join(publicDir,'index.html'),`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' https://www.gstatic.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.firebaseio.com https://*.firebasedatabase.app https://*.googleapis.com https://securetoken.googleapis.com https://identitytoolkit.googleapis.com https://www.google.com https://www.recaptcha.net; frame-src https://www.google.com https://www.recaptcha.net; img-src 'self' data: https://www.google.com https://www.gstatic.com; base-uri 'none'; object-src 'none'">
<title>${title} — X-Bunny</title><link rel="stylesheet" href="login.css">
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script><script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
<script src="firebase-config.js"></script><script src="login-config.js"></script><script src="login.js" defer></script></head>
<body><main><div class="mark">X-BUNNY</div><h1>${title}</h1><p>Entre com sua conta verificada do X-Bunny Animes.</p>
<form id="login"><label>E-mail<input name="email" type="email" autocomplete="email" required></label>
<label>Senha<input name="password" type="password" autocomplete="current-password" required></label><button>Entrar</button></form>
<div id="mfa" hidden><h2>Segunda etapa</h2><label>Telefone cadastrado<select id="mfa-factor"></select></label>
<div id="recaptcha-container"></div><button id="mfa-send" type="button">Enviar código SMS</button>
<form id="mfa-verify"><label>Código recebido<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button>Confirmar</button></form></div>
<p id="message" role="status"></p><a href="${site.origin}/">Voltar ao X-Bunny Animes</a></main></body></html>\n`);

console.log(`${role}: painel preparado para links em ${site.origin}`);
