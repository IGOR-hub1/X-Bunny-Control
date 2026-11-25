'use strict';
const {createStore}=require('./firebase-rtdb-store');

function fail(message){return Object.assign(new Error(message),{statusCode:503});}
function parseAccount(name){
  const raw=process.env[name];
  if(!raw)throw fail(`Configure ${name} somente no servidor.`);
  try{return JSON.parse(raw);}catch{throw fail(`${name} inválido.`);}
}
function createProjectStores(options={}){
  const mainId=String(options.mainProjectId||process.env.MAIN_FIREBASE_PROJECT_ID||'animes-64408').trim();
  const partnerId=String(options.partnersProjectId||process.env.PARTNERS_FIREBASE_PROJECT_ID||'').trim();
  if(!partnerId)throw fail('Configure PARTNERS_FIREBASE_PROJECT_ID.');
  if(mainId===partnerId)throw fail('Firebase Partners deve ser outro projeto.');
  const partnerURL=options.partnersDatabaseURL||process.env.PARTNERS_FIREBASE_DATABASE_URL;
  if(!partnerURL)throw fail('Configure PARTNERS_FIREBASE_DATABASE_URL.');
  const main=options.mainStore||createStore({
    projectId:mainId,
    databaseURL:options.mainDatabaseURL||process.env.MAIN_FIREBASE_DATABASE_URL||`https://${mainId}-default-rtdb.firebaseio.com`,
    account:options.mainAccount||parseAccount('MAIN_FIREBASE_SERVICE_ACCOUNT_JSON'),
    fetch:options.fetch
  });
  const partners=options.partnersStore||createStore({
    projectId:partnerId,
    databaseURL:partnerURL,
    account:options.partnersAccount||parseAccount('PARTNERS_FIREBASE_SERVICE_ACCOUNT_JSON'),
    fetch:options.fetch
  });
  return {main,partners};
}
module.exports={createProjectStores};
