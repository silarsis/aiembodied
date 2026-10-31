"""Before/after review of the same five exported characters, at fixed framing."""
import hashlib
import json
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(os.environ.get('FACE_DEMO_OUTPUT','artifacts/face-seam-review-2026-10-31'))
baseline=Path('artifacts/local-face-mvp-2026-10-31')
characters=json.loads((root/'characters.json').read_text(encoding='utf-8'))
try:font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',18);small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',14)
except OSError:font=ImageFont.load_default(size=18);small=ImageFont.load_default(size=14)
cell,label,header=240,130,70
sheet=Image.new('RGB',(label+4*cell,header+5*cell+44),'#101a29');draw=ImageDraw.Draw(sheet)
draw.text((16,12),'Face seams — same references and 3D source meshes',font=font,fill='#edf4ff')
columns=[('before','neutral','Before'),('after','neutral','After'),('before','happy','Before: smile'),('after','happy','After: smile')]
for i,(_,_,title) in enumerate(columns):draw.text((label+i*cell+10,44),title,font=font,fill='#b7d8fb')
proof=[];rows=[];animations=[]
for row,(id,name,_) in enumerate(characters):
    first,role=name.split(' — ')
    draw.text((12,header+row*cell+86),first,font=font,fill='#edf4ff');draw.text((12,header+row*cell+112),role,font=small,fill='#a9bdd8')
    for col,(version,emotion,_) in enumerate(columns):
        file=root/(('before/'+id) if version=='before' else id)/'runtime'/(emotion+'.png')
        sheet.paste(Image.open(file).convert('RGB').resize((cell-6,cell-6),Image.Resampling.LANCZOS),(label+col*cell+3,header+row*cell+3))
    report=json.loads((root/id/'avatar.report.json').read_text(encoding='utf-8'))
    same_reference=hashlib.sha256((root/id/'concept.png').read_bytes()).hexdigest()==hashlib.sha256((baseline/id/'concept.png').read_bytes()).hexdigest()
    same_mesh=None
    if (root/id/'source.glb').exists() and (baseline/id/'source.glb').exists():
        same_mesh=hashlib.sha256((root/id/'source.glb').read_bytes()).hexdigest()==hashlib.sha256((baseline/id/'source.glb').read_bytes()).hexdigest()
    proof.append({'id':id,'sameReference':same_reference,'sameSourceMesh':same_mesh,'seam':report['faceFit']['seam'],'blinkClosureGapMeters':report['faceFit']['blinkClosureGapMeters']})
    rows.append(f'<tr><th>{name}<a href="{id}/avatar.vrm" download>Download rebuilt avatar</a></th><td><button data-version="before" data-id="{id}"><img src="before/{id}/runtime/neutral.png" alt="{name} before"></button></td><td><button data-version="after" data-id="{id}"><img src="{id}/runtime/neutral.png" alt="{name} after"></button></td></tr>')
    animations.append(f'<figure><img src="{id}/animation.gif" alt="{name} speech, blink and smile"><figcaption>{name}</figcaption></figure>')
draw.text((12,header+5*cell+12),'Actual three-vrm renders. Single-view fitting remains approximate around hair, ears and the neck.',font=small,fill='#b7cbe4')
sheet.save(root/'before-after.png')
(root/'comparison-proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8')
html='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Face seam refinement</title><style>
*{box-sizing:border-box}body{margin:0;padding:28px;background:#101a29;color:#e5eefc;font:16px system-ui,sans-serif}main{max-width:1100px;margin:auto}h1{font-size:30px}p{line-height:1.6;color:#bdcfe5}a{color:#8bd1ff}nav{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}nav button,dialog button{padding:10px 16px;background:#233953;color:#e5eefc;border:1px solid #507091;border-radius:8px;cursor:pointer}nav button[aria-pressed="true"]{background:#2463a2}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border-bottom:1px solid #33465f;padding:8px;text-align:center}th:first-child{width:180px}tbody th{text-align:left}tbody th a{display:block;font-weight:normal;font-size:13px;margin-top:14px}td button{padding:0;border:0;background:none;cursor:zoom-in;width:100%}td img{width:100%;max-width:320px;display:block;margin:auto;border-radius:8px}.animations{display:flex;flex-wrap:wrap;gap:12px}.animations figure{margin:0;flex:1;min-width:180px;max-width:260px}.animations img{width:100%;border-radius:8px}figcaption{font-size:13px;padding:7px 0}dialog{background:#16253a;color:white;border:1px solid #527498;border-radius:12px;max-width:95vw}dialog::backdrop{background:#000b}dialog img{display:block;width:min(80vw,800px)}dialog button{float:right;margin-bottom:8px}@media(max-width:600px){body{padding:12px}th:first-child{width:110px}th{font-size:12px}}
</style></head><body><main><h1>Face seam refinement</h1><p>The same five characters, references and original 3D meshes, rebuilt with connected head boundaries and a matched appearance at the join. These are the exported VRMs in the app’s three-vrm renderer, with identical framing before and after.</p><p>The join is fixed to the same head bone on both sides and stays connected during expressions. The original overlapping strip is replaced with a bridge to the actual cut edge. Skin tone and boundary texture are matched while the interior speech, blink and emotion controls remain available.</p><p><strong>Still experimental:</strong> this improves the face boundary; single-view texture fitting, hair, ears and neck shading can still show artefacts, particularly from the side. Teeth and tongue remain future work. Existing saved avatars are not rewritten.</p><nav aria-label="Comparison view"><button data-view="neutral" aria-pressed="true">Front</button><button data-view="happy" aria-pressed="false">Smile</button><button data-view="quarter-left" aria-pressed="false">Three-quarter</button><button data-view="head-turn-left" aria-pressed="false">Head turn + speech</button></nav><table><thead><tr><th>Character</th><th>Before</th><th>After</th></tr></thead><tbody>'''+''.join(rows)+'''</tbody></table><h2>Speech, blink and smile</h2><div class="animations">'''+''.join(animations)+'''</div><p><a href="before-after.png">Comparison image</a> · <a href="comparison.html">Full six-emotion table</a> · <a href="comparison-proof.json">Input and seam measurements</a></p></main><dialog><button autofocus>Close</button><img alt="Expanded comparison"></dialog><script>const modal=document.querySelector('dialog');let view='neutral';document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;document.querySelectorAll('[data-view]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));document.querySelectorAll('[data-version]').forEach(cell=>cell.querySelector('img').src=(cell.dataset.version==='before'?'before/':'')+cell.dataset.id+'/runtime/'+view+'.png')});document.querySelectorAll('[data-version]').forEach(b=>b.onclick=()=>{modal.querySelector('img').src=b.querySelector('img').src;modal.showModal()});modal.querySelector('button').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal)modal.close()});</script></body></html>'''
(root/'seam-comparison.html').write_text(html,encoding='utf-8')
print('Saved fixed-framing before/after comparison for all five characters.')
