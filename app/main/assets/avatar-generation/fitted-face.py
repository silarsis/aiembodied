"""Landmark-fitted open-boundary face topology, local appearance and authored expressions.

Executed inside Blender by rig-character.py. Coordinates: +Z up, -Y face forward.
"""
import json
from pathlib import Path
import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

EYES = [
    ([33,246,161,160,159,158,157,173,133], [33,7,163,144,145,153,154,155,133]),
    ([362,398,384,385,386,387,388,466,263], [362,382,381,380,374,373,390,249,263]),
]
MOUTH_UPPER = [78,191,80,81,82,13,312,311,310,415,308]
MOUTH_LOWER = [78,95,88,178,87,14,317,402,318,324,308]
OPENINGS = [
    {33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246},
    {263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466},
    set(MOUTH_UPPER+MOUTH_LOWER),
]
PRESETS = ['aa','ih','ou','ee','oh','blink','blinkLeft','blinkRight',
           'happy','sad','angry','relaxed','surprised','fear','disgust',
           'lookLeft','lookRight','lookUp','lookDown']


def build_fitted_face(body, rig, height, landmarks_path, reference_path):
    data = json.loads(Path(landmarks_path).read_text())
    lm = np.asarray(data['landmarks'], dtype=float)
    if lm.shape != (478,3) or not np.isfinite(lm).all():
        raise RuntimeError('Invalid face landmarks. Run local face detection again.')
    width, image_height = data['imageSize']
    left, top, right, bottom = data['bodyBounds']
    scale = height/(bottom-top)
    p = np.zeros((468,3))
    p[:,0] = (lm[:468,0]*width-(left+right)/2)*scale
    p[:,2] = (bottom-lm[:468,1]*image_height)*scale
    bpy.context.view_layer.update()
    surface = BVHTree.FromObject(body,bpy.context.evaluated_depsgraph_get())
    hits = []
    for x,_,z in p:
        hit,_,_,_ = surface.ray_cast(Vector((x,-height,z)),Vector((0,1,0)),2*height)
        hits.append(None if hit is None else hit.y)
    if sum(y is not None for y in hits) < .92*len(p):
        raise RuntimeError('Reference face does not align with the generated head. Regenerate a straight front view.')
    fallback = float(np.median([y for y in hits if y is not None]))
    p[:,1] = [fallback if y is None else y for y in hits]
    # Smooth noisy generated eye/lip relief while retaining each character's depth.
    faces=[]
    for line in (Path(__file__).parent/'face-template'/'canonical-face.obj').read_text().splitlines():
        if line.startswith('f '):
            faces.append(tuple(int(item.split('/')[0])-1 for item in line.split()[1:]))
    capped_faces=faces
    # Google's canonical surface caps the eyes and mouth. Remove those triangles
    # to create real apertures; otherwise morphing merely stretches a painted face.
    faces=[tri for tri in faces if not any(set(tri).issubset(ring) for ring in OPENINGS)]
    neighbors=[set() for _ in p]
    for tri in faces:
        for i in tri: neighbors[i].update(set(tri)-{i})
    for _ in range(3):
        p[:,1] = [.65*p[i,1]+.35*np.mean(p[list(ns),1]) for i,ns in enumerate(neighbors)]
    p[:,1] -= .0008*height
    face_width = float(np.ptp(p[:,0]))
    if not .06*height < face_width < .22*height:
        raise RuntimeError('Face proportions are outside the supported adult range.')
    mesh=bpy.data.meshes.new('FittedFaceTopology')
    mesh.from_pydata(p.tolist(),[],faces)
    mesh.update()
    face=bpy.data.objects.new('FittedFace',mesh)
    bpy.context.scene.collection.objects.link(face)
    uv=mesh.uv_layers.new(name='ReferenceProjection')
    for poly in mesh.polygons:
        poly.use_smooth=True
        for index in poly.loop_indices:
            vertex=mesh.loops[index].vertex_index
            uv.data[index].uv=(lm[vertex,0],1-lm[vertex,1])
    material=bpy.data.materials.new('ReferenceFaceAppearance')
    material.use_nodes=True
    nodes=material.node_tree.nodes
    image=nodes.new('ShaderNodeTexImage')
    image.image=bpy.data.images.load(str(reference_path),check_existing=True)
    image.image.pack()
    shader=nodes.get('Principled BSDF')
    material.node_tree.links.new(image.outputs['Color'],shader.inputs['Base Color'])
    shader.inputs['Roughness'].default_value=.8
    face.data.materials.append(material)
    # Cut away only the front face underneath the replacement; retain back, ears and hair.
    patch_bvh=BVHTree.FromPolygons([Vector(v) for v in p],capped_faces)
    bm=bmesh.new();bm.from_mesh(body.data)
    remove=[]
    for polygon in bm.faces:
        c=polygon.calc_center_median()
        hit,_,_,_=patch_bvh.ray_cast(Vector((c.x,-height,c.z)),Vector((0,1,0)),2*height)
        if hit and abs(c.y-hit.y) < face_width*.28:
            remove.append(polygon)
    bmesh.ops.delete(bm,geom=remove,context='FACES')
    bm.to_mesh(body.data);bm.free();body.data.update()
    if len(remove)<10:
        raise RuntimeError('Could not replace the original front head surface safely.')
    parts=[face]
    def bind(obj):
        group=obj.vertex_groups.new(name='head')
        group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
        obj.parent=rig
        modifier=obj.modifiers.new('FaceRig','ARMATURE');modifier.object=rig
    bind(face)
    face.shape_key_add(name='Basis')
    # Radial feature displacement acts on this fitted topology, so the expressions
    # inherit the detected individual's eye/lip spacing rather than fixed body ratios.
    eye_data=[]
    for upper,lower in EYES:
        ids=upper+lower
        center=np.mean(p[ids],axis=0)
        ew=abs(p[upper[-1],0]-p[upper[0],0])
        eye_data.append((center,ew,upper,lower))
    mouth_center=(p[13]+p[14])/2
    mouth_width=abs(p[291,0]-p[61,0])
    def gaussian(center,sx,sz):
        return np.exp(-.5*((p[:,0]-center[0])/sx)**2-.5*((p[:,2]-center[2])/sz)**2)
    for name in PRESETS:
        q=p.copy()
        blink=name.startswith('blink')
        for eye_index,(center,ew,upper,lower) in enumerate(eye_data):
            weight=gaussian(center,ew*.6,ew*.45)
            side=-1 if center[0]<0 else 1
            if blink and (name=='blink' or (name=='blinkLeft' and side>0) or (name=='blinkRight' and side<0)):
                q[:,2] += (center[2]-p[:,2])*weight*.78
                for a,b in zip(upper,lower):
                    mid=(p[a,2]+p[b,2])/2
                    q[a,2]=q[b,2]=mid
                    q[a,0]=q[b,0]=(p[a,0]+p[b,0])/2
                    t=abs(q[a,0]-center[0])/(ew*.5)
                    forward=max(0,1-t*t)
                    q[a,1]=q[b,1]=min(p[a,1],p[b,1])-ew*.18*forward
            openness={'surprised':.16,'fear':.10,'angry':-.13,'happy':-.09,'disgust':-.10}.get(name,0)
            q[:,2]+=(p[:,2]-center[2])*weight*openness*3
            brow_center=center+np.array([0,0,ew*.7])
            brow=gaussian(brow_center,ew*.65,ew*.25)
            lift={'sad':.10,'angry':-.16,'surprised':.22,'fear':.18,'happy':.05,'relaxed':-.03,'disgust':-.10}.get(name,0)
            inner=1-np.clip((p[:,0]-center[0])*side/ew,-.5,.5)
            q[:,2]+=brow*ew*lift*inner
        if blink:
            # The other eye's smooth influence has a small nonzero tail. Close
            # the paired boundaries after both fields have been applied.
            for center,ew,upper,lower in eye_data:
                side=-1 if center[0]<0 else 1
                if name=='blink' or (name=='blinkLeft' and side>0) or (name=='blinkRight' and side<0):
                    for a,b in zip(upper,lower):q[a]=q[b]=(q[a]+q[b])/2
        mw=gaussian(mouth_center,mouth_width*.8,mouth_width*.65)
        if name in ['aa','ih','ou','ee','oh','happy','sad','angry','surprised','fear','disgust','relaxed']:
            opening={'aa':.34,'ih':.12,'ou':.22,'ee':.09,'oh':.29,'happy':.12,'surprised':.36,'fear':.20,'angry':.06,'disgust':.04}.get(name,0)
            widen={'ih':1.12,'ee':1.22,'ou':.65,'oh':.75,'surprised':.7,'happy':1.12,'fear':1.12}.get(name,1)
            q[:,0]+=(p[:,0]-mouth_center[0])*(widen-1)*mw
            below=np.clip((mouth_center[2]-p[:,2])/(mouth_width*.5),0,1)
            q[:,2]-=below*mw*mouth_width*opening*.65
            corner=np.clip(abs(p[:,0]-mouth_center[0])/(mouth_width*.5),0,1)**2
            curve={'happy':.16,'sad':-.15,'angry':-.07,'relaxed':.03,'disgust':.08}.get(name,0)
            q[:,2]+=mw*mouth_width*curve*corner
            for upper,lower in zip(MOUTH_UPPER,MOUTH_LOWER):
                t=np.clip(abs(p[upper,0]-mouth_center[0])/(mouth_width*.5),0,1)
                gap=mouth_width*opening*(1-t*t)
                q[upper,2]+=gap*.25
                q[lower,2]-=gap*.75
            if name=='disgust':
                nose=gaussian(p[1],face_width*.14,face_width*.15)
                q[:,2]+=nose*face_width*.035
                q[:,2]+=mw*mouth_width*.04*np.clip((p[:,0]-mouth_center[0])/mouth_width,0,1)
        key=face.shape_key_add(name=name,from_mix=False)
        for vertex,co in zip(key.data,q): vertex.co=co
    def solid(name,center,radii,color):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=16,location=center)
        obj=bpy.context.object;obj.name=name
        for v in obj.data.vertices:
            for axis in range(3):v.co[axis]*=radii[axis]
        for poly in obj.data.polygons:poly.use_smooth=True
        mat=bpy.data.materials.new(name+'Material');mat.diffuse_color=(*color,1)
        mat.use_nodes=True
        mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(*color,1)
        obj.data.materials.append(mat);bind(obj);parts.append(obj)
        return obj
    source=image.image
    pixels=np.array(source.pixels[:]).reshape(source.size[1],source.size[0],4)
    eye_colors=[]
    for index,(center,ew,upper,lower) in enumerate(eye_data):
        # Actual eyeballs sit behind the eyelid opening. Iris colour is sampled
        # from the source image; the eyelids themselves belong to the fitted skin.
        ec=center.copy();ec[1]+=ew*.75
        solid('Eyeball'+str(index),ec,(ew*.58,ew*.45,ew*.49),(.92,.94,.93))
        iris_id=468 if index==0 else 473
        # Sample the iris annulus, not its dark central pupil.
        samples=[]
        for rim in lm[iris_id+1:iris_id+5,:2]:
            point=lm[iris_id,:2]+.72*(rim-lm[iris_id,:2])
            ix=int(np.clip(point[0]*source.size[0],0,source.size[0]-1))
            iy=int(np.clip((1-point[1])*source.size[1],0,source.size[1]-1))
            samples.append(pixels[iy,ix,:3])
        color=np.median(samples,axis=0).clip(.025,.7)
        eye_colors.append(color.tolist())
        ic=center.copy();ic[1]+=ew*.29
        iris=solid('Iris'+str(index),ic,(ew*.21,ew*.022,ew*.23),color)
        pupil_center=ic.copy();pupil_center[1]-=ew*.02
        pupil=solid('Pupil'+str(index),pupil_center,(ew*.085,ew*.01,ew*.12),(.008,.009,.012))
        for obj in (iris,pupil):
            obj.shape_key_add(name='Basis')
            for name,dx,dz in [('lookLeft',.18,0),('lookRight',-.18,0),('lookUp',0,.14),('lookDown',0,-.14)]:
                key=obj.shape_key_add(name=name,from_mix=False)
                for v in key.data:v.co.x+=dx*ew;v.co.z+=dz*ew
    # A recessed fan follows the inner lip boundary in every expression. A fixed
    # sphere would intersect the chin whenever the generated face slopes backwards.
    outline=MOUTH_UPPER+list(reversed(MOUTH_LOWER[1:-1]))
    def cavity_coords(q):
        ring=q[outline].copy();ring[:,1]+=mouth_width*.025
        center=ring.mean(axis=0);center[1]+=mouth_width*.12
        return np.vstack([ring,center])
    cp=cavity_coords(p)
    cm=bpy.data.meshes.new('MouthCavityTopology')
    cm.from_pydata(cp.tolist(),[],[(i,(i+1)%len(outline),len(outline)) for i in range(len(outline))]);cm.update()
    cavity=bpy.data.objects.new('MouthInterior',cm);bpy.context.scene.collection.objects.link(cavity)
    mat=bpy.data.materials.new('MouthInteriorMaterial');mat.use_nodes=True
    mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.045,.009,.015,1)
    cavity.data.materials.append(mat);bind(cavity);parts.append(cavity)
    cavity.shape_key_add(name='Basis')
    for name in PRESETS:
        q=np.array([v.co[:] for v in face.data.shape_keys.key_blocks[name].data])
        key=cavity.shape_key_add(name=name,from_mix=False)
        for v,co in zip(key.data,cavity_coords(q)):v.co=co
    # Cover the sub-triangle mismatch between TRELLIS's irregular cut boundary
    # and the known oval. The outer ring follows the unchanged original head.
    oval=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
    inner=p[oval].copy();outer=inner.copy();center=inner.mean(axis=0)
    outer[:,[0,2]]=center[[0,2]]+(outer[:,[0,2]]-center[[0,2]])*1.04
    for v in outer:
        hit,_,_,_=surface.ray_cast(Vector((v[0],-height,v[2])),Vector((0,1,0)),2*height)
        if hit:v[1]=hit.y-.0005*height
    count=len(oval);seam_mesh=bpy.data.meshes.new('FaceBoundaryBlend')
    seam_mesh.from_pydata(np.vstack([inner,outer]).tolist(),[],[(i,(i+1)%count,(i+1)%count+count,i+count) for i in range(count)])
    seam_mesh.update();seam=bpy.data.objects.new('FaceBoundaryBlend',seam_mesh);bpy.context.scene.collection.objects.link(seam)
    seam.data.materials.append(material);bind(seam);parts.append(seam)
    uv=seam_mesh.uv_layers.new(name='ReferenceProjection')
    for poly in seam_mesh.polygons:
        poly.use_smooth=True
        for li in poly.loop_indices:
            vi=oval[seam_mesh.loops[li].vertex_index % count]
            # Outside the face oval the reference may be pure white background.
            # Extend the boundary's skin/hair colour instead of projecting that white.
            face_uv=lm[:468,:2].mean(axis=0)
            point=face_uv+(lm[vi,:2]-face_uv)*.975
            uv.data[li].uv=(point[0],1-point[1])
    seam.shape_key_add(name='Basis')
    for name in PRESETS:
        key=seam.shape_key_add(name=name,from_mix=False)
        target=face.data.shape_keys.key_blocks[name]
        for i,vi in enumerate(oval):key.data[i].co=target.data[vi].co
    # Gaze is separate from emotion and lip-sync; no rigid eye squashing for blink.
    report={'pipeline':'landmark-fitted-face-v1','landmarkCount':len(lm),
        'surfaceHitRatio':sum(y is not None for y in hits)/len(p),'replacedTriangles':len(remove),
        'faceWidthMeters':face_width,'topologyVertices':len(p),'expressions':PRESETS,
        'irisColorsLinearRGB':eye_colors,
        'openingTrianglesRemoved':len(capped_faces)-len(faces),
        'neutralEyeApertureMeters':[float(np.max(p[upper,2]-p[lower,2])) for upper,lower in EYES],
        'blinkClosureGapMeters':[max(float((face.data.shape_keys.key_blocks['blink'].data[a].co-face.data.shape_keys.key_blocks['blink'].data[b].co).length) for a,b in zip(upper,lower)) for upper,lower in EYES],
        'limits':['Single frontal adult humanoid on white background','Source-projected appearance; no unseen detail reconstruction','No teeth or tongue yet','Stylised detection/fitting requires visual review']}
    if any(gap > .00001 for gap in report['blinkClosureGapMeters']):
        raise RuntimeError('Fitted eyelids do not close: '+str(report['blinkClosureGapMeters']))
    if any(gap < .001 for gap in report['neutralEyeApertureMeters']):
        raise RuntimeError('Reference eyes must be open for fitting.')
    return parts,report
