const CACHE='roadname-assets-v40';
const SHELL=['./index.html','./style.css?v=40','./app.js?v=40','./address-core.mjs','./address-convert.mjs','./address-suggest.mjs','./address-memory.mjs','./address-notes.mjs','./sorting.mjs','./local-address.mjs','./recent-address.mjs','./region-label.mjs','./address-dictionary.mjs','./dictionary-worker.mjs','./ocr-core.js','./paddle-worker.js','./manifest.webmanifest','./cache-list.json','./vendor/tesseract.min.js'];
const OPTIONAL=['./apple-touch-icon.png','./icon-192.png','./icon-512.png','./jebichan-icon.png','./share-qr.png','./logo-96.png','./logo-256.png','./licenses.txt'];
const same=(a,b)=>new URL(a,self.location).pathname===b;
// The beta (/beta/) shares the site's origin and so its Cache Storage: each keeps caches named with its own path and
// deletes only those, never the other's.
const SCOPE=new URL('./',self.location).pathname;
const NAME=`${CACHE}@${SCOPE}`;
const mine=key=>key.startsWith('roadname-assets-')&&(key.endsWith(`@${SCOPE}`)||(!key.includes('@')&&!SCOPE.endsWith('/beta/')));
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(NAME);
 // Keep large models/runtime from any previous version so an update does not re-download ~30 MB.
 // The address dictionary is not copied: a new deploy may ship a newer one.
 for(const key of await caches.keys()){
  if(!key.startsWith('roadname-assets-')||key===NAME)continue;
  const old=await caches.open(key);
  for(const request of await old.keys()){const path=new URL(request.url).pathname;if((path.includes('/models/')||path.includes('/vendor/'))&&!path.includes('dictionary')){const response=await old.match(request);if(response)await cache.put(request,response)}}
 }
 await cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})));
 // Icons and the example photo are optional; a missing one must not break offline installation.
 await Promise.all(OPTIONAL.map(async url=>{try{const res=await fetch(new Request(url,{cache:'reload'}));if(res.ok)await cache.put(url,res)}catch{}}));
 self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(mine(key)&&key!==NAME)await caches.delete(key);await self.clients.claim()})()));
// App code (HTML/JS/JSON) is network-first so a deploy takes effect on the next launch. The cached copy is used when
// the network fails or the phone is offline, not merely because it is slow: a new page with an old cached module
// left the app unable to start. Models/runtime stay cache-first.
const withTimeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),ms))]);
async function networkFirst(cache,request,key,store=true){
 const keep=async res=>{if(res.ok&&!res.redirected){if(store)await cache.put(key,res.clone());return res}throw new Error(String(res.status))};
 const network=fetch(request);network.catch(()=>{});
 // Offline: the cached copy at once if there is one (a slow 3 s wait otherwise).
 if(self.navigator&&self.navigator.onLine===false){const saved=await cache.match(key);if(saved)return saved}
 try{return await keep(await withTimeout(network,30000))}
 catch{
  const saved=await cache.match(key);if(saved)return saved;
  try{return await keep(await network)}catch{return Response.error()}
 }
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const root=new URL('./',self.location).pathname,relative=url.pathname.slice(root.length);
 const known=[...SHELL,...OPTIONAL].some(p=>same(p,url.pathname));
 const heavy=relative.startsWith('models/')||relative.startsWith('vendor/');
 if(request.mode!=='navigate'&&!known&&!heavy)return;
 event.respondWith((async()=>{
  const cache=await caches.open(NAME);
  // The app's page is kept as the offline start page; another page of the site (licenses.txt) is shown as itself and
  // never stored in its place.
  if(request.mode==='navigate'){
   const app=relative===''||relative==='index.html';
   return app?networkFirst(cache,request,'./index.html'):networkFirst(cache,request,request,known);
  }
  if(known&&!heavy)return networkFirst(cache,new Request(request,{cache:'no-cache'}),request);
  const saved=await cache.match(request);if(saved)return saved;
  const res=await fetch(request);if(res.ok&&!res.redirected)await cache.put(request,res.clone());return res;
 })());
});
