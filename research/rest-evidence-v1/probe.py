"""Isolated read-only sampling. Never imports/starts capture or uses credentials.
40 REST GET maximum; six public receipt RPC reads; 300s wall; 1MiB/body;
one request at a time; no retries. Stop a host on 403/429/503 or timeout.
"""
import datetime as dt
import hashlib
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

OUT = pathlib.Path('research/rest-evidence-v1/evidence')
WALLETS = ['0x82cf2b31d18fca19830e216b98cffa5dbc6c0998','0x924379a79c64b77ad5816ad362122a5f6228658e','0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029','0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b','0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227']
MAX_BYTES = 1024 * 1024
OUT.mkdir(parents=True, exist_ok=False)
started = time.monotonic()
blocked = set()
receipts = []
candidates = []

def now():
    return dt.datetime.now(dt.UTC).isoformat()

def request(url, params=None, meta=None):
    host = urllib.parse.urlsplit(url).hostname
    if time.monotonic()-started > 290 or host in blocked:
        return None
    record = dict(meta or {}, url=url, requestUtc=now(), method='POST' if params else 'GET')
    body = b''
    try:
        req = urllib.request.Request(url, data=json.dumps(params).encode() if params else None,
             headers={'Accept':'application/json','Content-Type':'application/json','User-Agent':'PolyShadow-bounded-readonly-research/1'})
        try:
            response = urllib.request.urlopen(req, timeout=8)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            record['status'] = response.status
            record['headers'] = {k:response.headers.get(k) for k in ('date','age','cache-control','etag','retry-after')}
            body = response.read(MAX_BYTES+1)
        if len(body)>MAX_BYTES:
            record['error'] = 'BODY_BUDGET_EXHAUSTED'
            blocked.add(host)
            body = body[:MAX_BYTES]
        if record['status'] in (403,429,503):
            blocked.add(host)
    except Exception as error:
        record['error'] = type(error).__name__
        blocked.add(host)
    record.update(responseUtc=now(), bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
    file = f'response-{len(receipts):03}.json'
    (OUT/file).write_bytes(body)
    record['bodyFile'] = file
    receipts.append(record)
    with (OUT/'requests.ndjson').open('a') as stream:
        stream.write(json.dumps(record, sort_keys=True)+'\n')
    time.sleep(0.25)
    try:
        return json.loads(body) if record.get('status')==200 and not record.get('error') else None
    except ValueError:
        return None

for source in ('trades','activity'):
    for wallet in WALLETS:
        for index, offset in enumerate((0,98,196,0)):
            query = dict(user=wallet,limit=100,offset=offset)
            if source=='trades':
                query['takerOnly']='false'
            data=request('https://data-api.polymarket.com/'+source+'?'+urllib.parse.urlencode(query),
                         meta=dict(source=source,wallet=wallet,page=index,offset=offset,limit=100))
            if isinstance(data,list) and offset:
                for row in data:
                    tx=row.get('transactionHash') if isinstance(row,dict) else None
                    if tx and tx not in candidates and len(candidates)<6:
                        candidates.append(tx)
            if data is None:
                break
for tx in candidates:
    request('https://polygon-bor-rpc.publicnode.com',
            dict(jsonrpc='2.0',id=1,method='eth_getTransactionReceipt',params=[tx]),dict(source='CHAIN_RECEIPT',tx=tx))
manifest={'version':1,'scope':'public current-time sample, not stopped-experiment reconstruction','wallets':WALLETS,
          'maxRestRequests':40,'maxRpcRequests':6,'maxBodyBytes':MAX_BYTES,'maxWallSeconds':300,'requests':len(receipts),
          'blockedHosts':sorted(blocked),'observedSeconds':time.monotonic()-started,
          'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.iterdir()) if p.is_file()}}
(OUT/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
