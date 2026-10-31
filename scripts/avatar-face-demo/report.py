"""Assemble the actual three-vrm renders into a local comparison table and GIFs."""
import json
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(os.environ.get('FACE_DEMO_OUTPUT','artifacts/local-face-mvp-2026-10-31'))
characters=json.loads((root/'characters.json').read_text(encoding='utf-8'))
emotions=[('happy','Happiness'),('sad','Sadness'),('angry','Anger'),('fear','Fear'),('disgust','Disgust'),('surprised','Surprise')]
try:font=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',18);small=ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf',14)
except OSError:font=ImageFont.load_default(size=18);small=ImageFont.load_default(size=14)
cell=208;label=140;header=76
sheet=Image.new('RGB',(label+cell*8,header+cell*5+50),'#101a29')
draw=ImageDraw.Draw(sheet)
draw.text((20,12),'Local face-fitting MVP — actual exported 3D avatars',fill='#e5eefc',font=font)
columns=[('source','Reference'),('neutral','Neutral')]+emotions
for i,(_,name) in enumerate(columns):draw.text((label+i*cell+10,46),name,fill='#b9d6f8',font=font)
rows=[];summary=[]
for row,(id,name,description) in enumerate(characters):
    directory=root/id
    info=json.loads((directory/'face-landmarks.json').read_text(encoding='utf-8'))
    reference=Image.open(directory/'concept.png').convert('RGB')
    lm=info['landmarks'][:468]
    xs=[v[0]*reference.width for v in lm];ys=[v[1]*reference.height for v in lm]
    side=(max(ys)-min(ys))*1.65;cx=(min(xs)+max(xs))/2;cy=(min(ys)+max(ys))/2
    reference=reference.crop((round(cx-side/2),round(cy-side/2),round(cx+side/2),round(cy+side/2)))
    reference.save(directory/'reference-face.png')
    label_parts=name.replace('—','-').split(' - ')
    draw.text((12,header+row*cell+65),label_parts[0],fill='#e5eefc',font=font)
    draw.text((12,header+row*cell+92),label_parts[-1],fill='#a0b4cf',font=small)
    cells=[]
    for col,(key,title) in enumerate(columns):
        file=directory/('reference-face.png' if key=='source' else 'runtime/'+key+'.png')
        img=Image.open(file).convert('RGB').resize((cell-6,cell-6),Image.Resampling.LANCZOS)
        sheet.paste(img,(label+col*cell+3,header+row*cell+3))
        relative=file.relative_to(root).as_posix()
        cells.append(f'<td><button class="preview" data-image="{relative}" aria-label="Expand {name}: {title}"><img src="{relative}" alt="{name}: {title}" loading="lazy"></button></td>')
    frames=[Image.open(file).convert('RGB') for file in sorted((directory/'runtime').glob('frame-*.png'))]
    if len(frames)!=48:raise RuntimeError(f'{id}: expected 48 actual runtime frames')
    frames[0].save(directory/'animation.gif',save_all=True,append_images=frames[1:],duration=85,loop=0)
    verification=json.loads((directory/'runtime/verification.json').read_text(encoding='utf-8'))
    fit=json.loads((directory/'avatar.report.json').read_text(encoding='utf-8'))['faceFit']
    summary.append({'id':id,'name':name,'faceFit':fit,'runtime':verification})
    rows.append(f'<tr><th scope="row">{name}<a href="{id}/avatar.vrm" download>Download avatar</a><a href="{id}/concept.png">Full reference</a><a href="{id}/face-landmarks.png">Detected landmarks</a></th>'+''.join(cells)+'</tr>')
draw.text((14,header+cell*5+12),'Experimental: face/hair seams remain visible; lips are approximate; teeth and tongue are not implemented.',fill='#c8d5e9',font=small)
sheet.save(root/'emotion-table.png')
(root/'verification.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
heads=''.join('<th scope="col">'+name+'</th>' for _,name in columns)
animations=''.join(f'<figure><img src="{id}/animation.gif" alt="{name}: interpolated speech, blink and smile"><figcaption>{name}</figcaption></figure>' for id,name,_ in characters)
html='''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local face fitting — five-character review</title><style>
*{box-sizing:border-box}body{margin:0;padding:28px;background:#101a29;color:#e5eefc;font:16px system-ui,sans-serif}main{max-width:1840px;margin:auto}h1{font-size:30px;margin:0 0 12px}p{max-width:1000px;line-height:1.6;color:#becde2}a{color:#8bcfff}.scroll{overflow:auto;border:1px solid #34455e;border-radius:12px;margin:28px 0}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{padding:7px;border-bottom:1px solid #34455e;text-align:center}thead th{background:#1d2b40;font-size:14px}tbody th{font-size:14px;text-align:left;width:160px}tbody th a{display:block;font-weight:normal;font-size:12px;margin-top:10px}.preview{border:0;padding:0;background:none;cursor:zoom-in;width:100%}.preview img{display:block;width:100%;max-width:200px;border-radius:6px}.animations{display:flex;flex-wrap:wrap;gap:16px}.animations figure{margin:0;flex:1;min-width:190px;max-width:320px}.animations img{width:100%;border-radius:10px}figcaption{padding:8px 0}dialog{background:#142136;color:white;border:1px solid #47668d;border-radius:12px;max-width:95vw}dialog::backdrop{background:#000b}dialog img{display:block;width:min(80vw,800px);height:auto;image-rendering:auto}dialog button{float:right;padding:10px;margin-bottom:8px}small{color:#a8bdd7}
</style></head><body><main><h1>Local face fitting: five-character MVP</h1><p>Five characters generated locally with ComfyUI, reconstructed with TRELLIS.2, then fitted with local MediaPipe landmarks and a shared face topology. Every expression below is rendered from the exported VRM using the app’s three-vrm library. Click an image to enlarge it.</p><p>All five support six emotions, five speech mouth shapes, eyelid closure and iris gaze. The animations below show interpolated speech, blinking and smiling. <strong>This remains an experimental fit:</strong> visible face/hair and jaw seams, approximate lips and lighting differences remain. Teeth, tongue and unseen facial details are not reconstructed.</p><div class="scroll"><table><thead><tr><th>Character</th>'''+heads+'''</tr></thead><tbody>'''+''.join(rows)+'''</tbody></table></div><h2>Animation from the exported avatars</h2><div class="animations">'''+animations+'''</div><p><a href="emotion-table.png">Full comparison image</a> · <a href="verification.json">Fitting and animation verification</a></p><small>The review uses separate local files and never changes the active avatar or your saved configuration.</small></main><dialog><button autofocus>Close</button><img alt="Expanded comparison"></dialog><script>const modal=document.querySelector('dialog');document.querySelectorAll('[data-image]').forEach(b=>b.addEventListener('click',()=>{modal.querySelector('img').src=b.dataset.image;modal.querySelector('img').alt=b.getAttribute('aria-label');modal.showModal()}));modal.querySelector('button').onclick=()=>modal.close();modal.addEventListener('click',e=>{if(e.target===modal)modal.close()});</script></body></html>'''
(root/'comparison.html').write_text(html,encoding='utf-8')
print('Wrote five-character emotion table, comparison page and five animation GIFs.')
