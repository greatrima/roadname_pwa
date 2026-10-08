const CACHE='roadname-assets-v18';
const SHELL=['./index.html','./style.css?v=18','./app.js?v=18','./address-core.mjs','./address-convert.mjs','./address-suggest.mjs','./address-memory.mjs','./address-dictionary.mjs','./dictionary-worker.mjs','./ocr-core.js','./paddle-worker.js','./manifest.webmanifest','./cache-list.json','./vendor/tesseract.min.js'];
const OPTIONAL=['./apple-touch-icon.png','./icon-192.png','./icon-512.png','./jebichan-icon.png','./share-qr.png','./licenses.txt'];
const same=(a,b)=>new URL(a,self.location).pathname===b;
self.addEventListener('install',event=>event.waitUntil((async()=>{
 const cache=await caches.open(CACHE);
 // Keep large models/runtime from any previous version so an update does not re-download ~30 MB.
 // The address dictionary is not copied: a new deploy may ship a newer one.
 for(const key of await caches.keys()){
  if(!key.startsWith('roadname-assets-')||key===CACHE)continue;
  const old=await caches.open(key);
  for(const request of await old.keys()){const path=new URL(request.url).pathname;if((path.includes('/models/')||path.includes('/vendor/'))&&!path.includes('dictionary')){const response=await old.match(request);if(response)await cache.put(request,response)}}
 }
 await cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})));
 // Icons and the example photo are optional; a missing one must not break offline installation.
 await Promise.all(OPTIONAL.map(async url=>{try{const res=await fetch(new Request(url,{cache:'reload'}));if(res.ok)await cache.put(url,res)}catch{}}));
 self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('roadname-assets-')&&key!==CACHE)await caches.delete(key);await self.clients.claim()})()));
// App code (HTML/JS/JSON) is network-first so a deploy takes effect on the next launch;
// offline or on a slow connection (3 s) the cached copy is used. Models/runtime stay cache-first.
const withTimeout=(promise,ms)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')),ms))]);
async function networkFirst(cache,request,key){
 try{const res=await withTimeout(fetch(request),3000);if(res.ok&&!res.redirected){await cache.put(key,res.clone());return res}throw new Error(String(res.status))}
 catch{return await cache.match(key)||Response.error()}
}
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin)return;
 const root=new URL('./',self.location).pathname,relative=url.pathname.slice(root.length);
 const known=[...SHELL,...OPTIONAL].some(p=>same(p,url.pathname));
 const heavy=relative.startsWith('models/')||relative.startsWith('vendor/');
 if(request.mode!=='navigate'&&!known&&!heavy)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  if(request.mode==='navigate')return networkFirst(cache,request,'./index.html');
  if(known&&!heavy)return networkFirst(cache,new Request(request,{cache:'no-cache'}),request);
  const saved=await cache.match(request);if(saved)return saved;
  const res=await fetch(request);if(res.ok&&!res.redirected)await cache.put(request,res.clone());return res;
 })());
});
