"""Download pinned public OCR assets; never handles user images."""
import concurrent.futures, gzip, hashlib, json, pathlib, urllib.request
import yaml

root = pathlib.Path(__file__).resolve().parents[1] / 'dist'
rec_rev = '5c6f574b8e2230adf4287b33e736d71b9fabd28e'
det_rev = 'e6f4fa85f00e168c862bc462aebca69eef9b3d3d'
assets = {
 'models/korean-rec.onnx': f'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/{rec_rev}/inference.onnx',
 'models/text-det.onnx': f'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/{det_rev}/inference.onnx',
 'models/korean-inference.yml': f'https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec_onnx/resolve/{rec_rev}/inference.yml',
 'vendor/ort.wasm.min.js':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js',
 'vendor/ort-wasm-simd-threaded.mjs':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.mjs',
 'vendor/ort-wasm-simd-threaded.wasm':'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort-wasm-simd-threaded.wasm',
 'vendor/tesseract.min.js':'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
 'vendor/worker.min.js':'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
 'vendor/tesseract-core-simd-lstm.wasm.js':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm.js',
 'vendor/tesseract-core-simd-lstm.wasm':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-simd-lstm.wasm',
 'vendor/tesseract-core-lstm.wasm.js':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm.js',
 'vendor/tesseract-core-lstm.wasm':'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core-lstm.wasm',
 'models/kor.traineddata.gz':'https://tessdata.projectnaptha.com/4.0.0/kor.traineddata.gz',
 'models/eng.traineddata.gz':'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
 'models/address_dictionary.tsv.gz':None, # chosen below, as the Android app updates its own
}
# The same dictionary the Android app has: the one its latest release carries (how the app updates it), or the copy
# committed in the old repository layout, whichever was generated later (the latter is no longer kept up to date).
DICTIONARY_RAW='https://raw.githubusercontent.com/greatrima/roadnameconverter/main/app/src/main/assets/address_dictionary.tsv.gz'
def dictionary_generated(data):
 for line in gzip.decompress(data).decode('utf-8','replace').splitlines()[:5]:
  if line.startswith('# generated='):return line.split('=',1)[1].strip()
 return ''
def newest_dictionary():
 found=[]
 try:
  with urllib.request.urlopen('https://api.github.com/repos/greatrima/roadnameconverter/releases/latest',timeout=60) as res:
   release=json.load(res)
  url=next((a['browser_download_url'] for a in release.get('assets',[]) if a['name'].startswith('address_dictionary') and a['name'].endswith('.tsv.gz')),None)
  if url:found.append(url)
 except Exception as e:print('dictionary release:',e,flush=True)
 found.append(DICTIONARY_RAW)
 best=None
 for url in found:
  try:
   with urllib.request.urlopen(url,timeout=90) as res:data=res.read()
  except Exception as e:print('dictionary',url,e,flush=True);continue
  if best is None or dictionary_generated(data)>best[0]:best=(dictionary_generated(data),url,data)
 assert best,'no address dictionary'
 path=root/'models/address_dictionary.tsv.gz';path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():path.write_bytes(best[2])
 print('address dictionary from',best[1],flush=True)
 return best[1]
assets['models/address_dictionary.tsv.gz']=newest_dictionary()
def download(item):
 name,url=item; path=root/name; path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  with urllib.request.urlopen(url,timeout=90) as res: data=res.read()
  path.write_bytes(data)
 data=path.read_bytes()
 print(name,len(data),flush=True)
 return {'path':'./'+name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'source':url}
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
 records=list(pool.map(download,assets.items()))
config=yaml.safe_load((root/'models/korean-inference.yml').read_text())
chars=config['PostProcess']['character_dict']
(root/'models/korean-dict.json').write_text(json.dumps(['']+chars+[' '],ensure_ascii=False))
(root/'assets-manifest.json').write_text(json.dumps(records,indent=2))
with gzip.open(root/'models/address_dictionary.tsv.gz','rt',encoding='utf-8') as f:
 header,generated=f.readline().strip(),f.readline().strip()
assert header=='# address-lens-dictionary-v1' and generated.startswith('# generated='), 'unexpected dictionary format'
(root/'models/dictionary-version.json').write_text(json.dumps({'version':generated.split('=',1)[1].strip()}))
print('address dictionary:',generated,flush=True)
print('character count:',len(chars)+2,flush=True)
# "내 지역 주소 자료": the newest local-YYYYMM release of this repository, built by scripts/local-data.py from the
# Ministry of the Interior and Safety's public road address data; served next to the app (dist/local/<code>.tsv.gz).
import io, zipfile
with urllib.request.urlopen('https://api.github.com/repos/greatrima/roadname_pwa/releases?per_page=30',timeout=60) as res:
 releases=[r for r in json.load(res) if r['tag_name'].startswith('local-') and not r.get('draft')]
# The newest release that has its file (one left empty by a cut-off upload is skipped, not a failed deploy).
release=max((r for r in releases if any(a['name']=='local-data.zip' for a in r['assets'])),key=lambda r:r['tag_name'])
url=next(a['browser_download_url'] for a in release['assets'] if a['name']=='local-data.zip')
with urllib.request.urlopen(url,timeout=300) as res: bundle=res.read()
zipfile.ZipFile(io.BytesIO(bundle)).extractall(root)
print('local data:',release['tag_name'],len(bundle),flush=True)
