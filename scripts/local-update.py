"""Monthly "내 지역 주소 자료": takes the newest month of the Ministry of the Interior and Safety's road address data
once it is out, builds it with local-data.py, publishes it as release local-YYYYMM and redeploys the site.

Run by hand when a new month is out (GitHub's runners cannot reach juso.go.kr). Needs a signed-in gh.
    python scripts/local-update.py                 next month after the newest local-* release
    python scripts/local-update.py 202609 --dry    one month, downloaded and built only (a reachability check)
"""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = 'greatrima/roadname_pwa'
HERE = pathlib.Path(__file__).resolve().parent


def gh(*args):
    return subprocess.run(['gh', *args], check=True, capture_output=True, text=True, encoding='utf-8').stdout


def newest_month():
    releases = json.loads(gh('api', f'repos/{REPO}/releases?per_page=50'))
    tags = sorted(r['tag_name'] for r in releases if r['tag_name'].startswith('local-'))
    return tags[-1].removeprefix('local-') if tags else None


def next_month(month):
    year, mon = int(month[:4]), int(month[4:])
    return f'{year + mon // 12}{mon % 12 + 1:02d}'


def download(month, folder):
    name = f'RNADDR_KOR_{month[2:]}.zip'
    query = urllib.parse.urlencode({
        'regYmd': month[:4], 'reqType': 'ALLRNADR_KOR', 'ctprvnCd': '00', 'stdde': month,
        'fileName': f'{month}_도로명주소 한글_전체분.zip', 'realFileName': name, 'intFileNo': 0, 'intNum': 0,
    })
    request = urllib.request.Request(f'https://business.juso.go.kr/api/jst/download?{query}', headers={'User-Agent': 'Mozilla/5.0'})
    path = pathlib.Path(folder) / name
    try:
        with urllib.request.urlopen(request, timeout=600) as res:
            path.write_bytes(res.read())
            print(month, res.status, res.headers.get('Content-Type'), path.stat().st_size, flush=True)
    except urllib.error.HTTPError as e:
        # A month not out yet is answered 400.
        if 400 <= e.code < 500: return None
        raise
    return path if zipfile.is_zipfile(path) else None


def build(source, out):
    spec = importlib.util.spec_from_file_location('local_data', HERE / 'local-data.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.build(str(source), str(out))
    return pathlib.Path(out) / 'local-data.zip'


def main():
    dry = '--dry' in sys.argv
    asked = next((a for a in sys.argv[1:] if a.isdigit()), None)
    month = asked or next_month(newest_month() or '202608')
    with tempfile.TemporaryDirectory() as folder:
        source = download(month, folder)
        if source is None:
            print(f'{month}: not out yet', flush=True)
            return
        bundle = build(source, pathlib.Path(folder) / 'out')
        if dry:
            print(f'{month}: built {bundle.stat().st_size} bytes (dry run, nothing published)', flush=True)
            return
        gh('release', 'create', f'local-{month}', str(bundle), '--repo', REPO, '--title', f'내 지역 주소 자료 {month}',
           '--notes', f'행정안전부 도로명주소 한글 전체분({month[:4]}년 {int(month[4:])}월, business.juso.go.kr 공개 자료)을 시·군·구별로 나눈 파일.')
        gh('workflow', 'run', 'pages.yml', '--repo', REPO, '--ref', 'main')
        print(f'{month}: published and the site is redeploying', flush=True)


if __name__ == '__main__':
    main()
