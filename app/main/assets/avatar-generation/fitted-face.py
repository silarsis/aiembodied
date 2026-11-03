"""Landmark-fitted open-boundary face topology, local appearance and authored expressions.

Executed inside Blender by rig-character.py. Coordinates: +Z up, -Y face forward.
"""
import json
from pathlib import Path
import bpy
import bmesh
import runpy
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


def expression_targets(p, face_width, oval):
    """Each preset's landmark positions. Radial feature displacement acts on the fitted
    topology, so the expressions inherit the detected individual's eye/lip spacing rather
    than fixed body ratios."""
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
    targets={}
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
        # Keep the perimeter fixed. The interior expression controls and
        # eyelid/lip boundaries retain their approved deformations.
        q[oval]=p[oval]
        targets[name]=q
    return targets,eye_data,mouth_center,mouth_width


def inside(points,polygon):
    """Which 2D points lie inside a closed polygon (even-odd rule)."""
    x,z=points[:,0],points[:,1];result=np.zeros(len(points),dtype=bool)
    for (ax,az),(bx,bz) in zip(polygon,np.roll(polygon,-1,axis=0)):
        if az==bz:continue
        result^=((az>z)!=(bz>z))&(x<(bx-ax)*(z-az)/(bz-az)+ax)
    return result


def nearest_on_polyline(points,line):
    """For each 2D point: the nearest segment of an open polyline, the position along it and the distance."""
    a,b=line[:-1],line[1:];ab=b-a
    t=np.clip(np.einsum('nsk,sk->ns',points[:,None]-a[None],ab)/np.maximum((ab*ab).sum(axis=1),1e-12),0,1)
    distance=np.linalg.norm(a[None]+t[...,None]*ab[None]-points[:,None],axis=2)
    segment=distance.argmin(axis=1);rows=np.arange(len(points))
    return segment,t[rows,segment],distance[rows,segment]


def project_front_face(body,seams,source,p,oval,face_width,to_image):
    """Repaint the face from the front drawing, placed exactly where the landmarks put it.

    The painted head comes from paint-views' own fit of the front drawing, which can sit a
    few pixels off the landmark mapping, so the cut eye openings landed below the painted
    eyes. Inside the face the drawing is re-projected with the landmark mapping, feathered out
    towards the face's edge and wherever the surface turns away from the front.
    """
    reference=np.array(source.pixels[:],dtype=np.float32).reshape(source.size[1],source.size[0],4)[...,:3]
    appearance=seams['SurfaceAppearance'](body)
    anchors=[4,6,9,50,101,118,205,280,330,347,425,151]
    skin=np.median(np.array([sample_image(reference,*to_image(p[i])) for i in anchors]),axis=0)
    mesh=body.data;mesh.calc_loop_triangles();layer=mesh.uv_layers.active
    points=np.array([v.co[:] for v in mesh.vertices])
    normals=np.array([v.normal[:] for v in mesh.vertices])
    ring=p[oval][:,[0,2]]
    inner=inside(points[:,[0,2]],ring)
    _,_,edge=nearest_on_polyline(points[:,[0,2]],np.vstack([ring,ring[:1]]))
    centre_y=float(p[:,1].mean())+face_width*.3
    weights=np.where(inner&(points[:,1]<centre_y),np.clip(edge/(face_width*.05),0,1),0)*np.clip((-normals[:,1]+.05)/.35,0,1)
    atlases={name:pixels.copy() for name,pixels in appearance.images.items()}
    covered={name:np.zeros(pixels.shape[:2],dtype=bool) for name,pixels in atlases.items()}
    for tri in mesh.loop_triangles:
        ids=list(tri.vertices)
        if weights[ids].max()==0:continue
        texture=appearance.textures[tri.material_index]
        if texture is None:continue
        output=atlases[texture];h,w=output.shape[:2]
        raster=seams['raster_triangle'](np.array([layer.data[i].uv[:] for i in tri.loops])*[w,h]-.5,w,h)
        if raster is None:continue
        lo,hi,wa,wb,wc,mask=raster
        co=wa[...,None]*points[ids[0]]+wb[...,None]*points[ids[1]]+wc[...,None]*points[ids[2]]
        colour=sample_image(reference,*to_image(co))
        weight=wa*weights[ids[0]]+wb*weights[ids[1]]+wc*weights[ids[2]]
        # The backdrop and the pale anti-aliased edge around the drawn face stay as painted.
        weight=weight*np.clip((skin.min()+.2-colour.min(axis=-1))/.08,0,1)
        region=output[lo[1]:hi[1]+1,lo[0]:hi[0]+1,:3]
        blended=region*(1-weight[...,None])+colour*weight[...,None]
        region[mask]=blended[mask]
        covered[texture][lo[1]:hi[1]+1,lo[0]:hi[0]+1]|=mask
    changed=0
    for name,pixels in atlases.items():
        image=bpy.data.images[name].copy();image.name='FrontFaceAtlas'
        image.pixels.foreach_set(pixels.ravel());image.update();image.pack()
        changed+=int(covered[name].sum())
        for mat in mesh.materials:
            if mat and mat.use_nodes:
                for node in mat.node_tree.nodes:
                    if node.type=='TEX_IMAGE' and node.image and node.image.name==name:node.image=image
    return changed


def sample_image(pixels,x,y):
    """Bilinear colour at image coordinates (x right, y down from the top, pixel centres at .5)."""
    h,w=pixels.shape[:2]
    x=np.clip(np.asarray(x,dtype=float)-.5,0,w-1);y=np.clip(h-np.asarray(y,dtype=float)-.5,0,h-1)
    ix=x.astype(int);iy=y.astype(int);jx=np.minimum(ix+1,w-1);jy=np.minimum(iy+1,h-1)
    sx=(x-ix)[...,None];sy=(y-iy)[...,None]
    return (1-sy)*((1-sx)*pixels[iy,ix]+sx*pixels[iy,jx])+sy*((1-sx)*pixels[jy,ix]+sx*pixels[jy,jx])


def wrap_head(body,p,faces,face_width,height,seams,source,to_image):
    """Give the generated head its own expressions instead of covering it with a separate face.

    Hunyuan3D 2mv shapes the face itself (nose, lips, brow) and its views paint it from the
    front and the side, so a front-projected face laid over it reads as a mask from the side.
    Instead, the head's front vertices follow the landmark surface: in every expression each
    one moves as the landmark triangle in front of it moves, and the perimeter stays still.
    Only the eye and mouth openings are cut, with their edges snapped onto the detected lid
    and lip lines, so blinks and closed lips seal exactly as on the fitted face.
    Raises RuntimeError when the head can't be wrapped, so the caller can fit a separate face.
    """
    oval=seams['OVAL']
    targets,eye_data,mouth_center,mouth_width=expression_targets(p,face_width,oval)
    mesh=body.data
    co=np.array([v.co[:] for v in mesh.vertices])
    ring=p[oval][:,[0,2]]
    in_oval=inside(co[:,[0,2]],ring)
    if in_oval.sum()<200:raise RuntimeError('Too little head surface behind the detected face.')
    centre_y=float((co[in_oval,1].min()+co[in_oval,1].max())/2)
    front=in_oval&(co[:,1]<centre_y)
    bm=bmesh.new();bm.from_mesh(mesh)
    # The generated face is coarse (a few hundred vertices), too coarse for lids and lips to
    # follow their lines. Split its edges once; UVs and skin weights are interpolated.
    region=[f for f in bm.faces if all(front[v.index] for v in f.verts)]
    bmesh.ops.subdivide_edges(bm,edges=list({e for f in region for e in f.edges}),cuts=1,use_grid_fill=True)
    bmesh.ops.triangulate(bm,faces=[f for f in bm.faces if len(f.verts)>4])
    bm.verts.index_update();bm.faces.index_update();bm.verts.ensure_lookup_table();bm.faces.ensure_lookup_table()
    co=np.array([v.co[:] for v in bm.verts])
    front=inside(co[:,[0,2]],ring)&(co[:,1]<centre_y)
    centres=np.array([f.calc_center_median()[:] for f in bm.faces])
    face_front=np.array([all(front[v.index] for v in f.verts) for f in bm.faces])
    # Closed lips leave almost no gap between the lip lines, so the mouth cut also takes
    # the faces right along them.
    openings=[(upper,lower,0.) for upper,lower in EYES]+[(MOUTH_UPPER,MOUTH_LOWER,mouth_width*.06)]
    removed=set();holes=[]
    for upper,lower,grow in openings:
        outline=p[upper+list(reversed(lower[1:-1]))][:,[0,2]]
        chosen=face_front&inside(centres[:,[0,2]],outline)
        if grow:
            for line in (upper,lower):
                chosen|=face_front&(nearest_on_polyline(centres[:,[0,2]],p[line][:,[0,2]])[2]<grow)
        picked=seams['largest_component']({bm.faces[i] for i in np.flatnonzero(chosen)})
        if not picked:raise RuntimeError('The head has no surface where an eye or the mouth opens.')
        # One simple hole: grow it wherever its rim pinches or branches.
        for _ in range(8):
            degree={}
            for f in picked:
                for e in f.edges:
                    if sum(other in picked for other in e.link_faces)==1:
                        for v in e.verts:degree[v]=degree.get(v,0)+1
            bad=[v for v,n in degree.items() if n!=2]
            if not bad:break
            for v in bad:picked.update(f for f in v.link_faces if face_front[f.index])
        picked=list(picked)
        holes.append((upper,lower,{v for f in picked for v in f.verts}))
        removed.update(picked)
    removed_count=len(removed)
    bmesh.ops.delete(bm,geom=list(removed),context='FACES')
    # Snap each opening's rim onto the nearer of its two lid (or lip) lines.
    snapped={}
    for upper,lower,verts in holes:
        rim=[v for v in verts if v.is_valid and v.link_faces]
        for v in rim:
            if sum(1 for e in v.link_edges if len(e.link_faces)==1)!=2:
                raise RuntimeError('An eye or mouth opening on the head is not a simple hole.')
        if len(rim)<6:raise RuntimeError('An eye or mouth opening on the head is too small.')
        xz=np.array([v.co[:] for v in rim])[:,[0,2]]
        fits=[(ids,*nearest_on_polyline(xz,p[ids][:,[0,2]])) for ids in (upper,lower)]
        # The drawings have closed lips: a rim alternating between two nearly touching lip
        # lines showed as a dashed slit, so at rest the mouth closes on the line between them.
        line=(p[upper]+p[lower])/2 if upper is MOUTH_UPPER else None
        for n,v in enumerate(rim):
            ids,segment,t,_=min(fits,key=lambda fit:fit[3][n])
            s,u=int(segment[n]),float(t[n])
            rest=p[ids] if line is None else line
            v.co=Vector(rest[s]*(1-u)+rest[s+1]*u)
            snapped[v]=(ids,s,u)
    bm.verts.index_update()
    snapped={v.index:place for v,place in snapped.items()}
    bm.to_mesh(mesh);bm.free();mesh.update()
    co=np.array([v.co[:] for v in mesh.vertices])
    front=inside(co[:,[0,2]],ring)&(co[:,1]<centre_y)
    delta={name:targets[name]-p for name in PRESETS}
    shift={name:np.zeros_like(co) for name in PRESETS}
    for i,(ids,s,u) in snapped.items():
        for name in PRESETS:shift[name][i]=delta[name][ids[s]]*(1-u)+delta[name][ids[s+1]]*u
    # Everything else follows the landmark triangle in front of it (barycentric, seen from the front).
    others=np.array([i for i in np.flatnonzero(front) if i not in snapped],dtype=int)
    tri=np.array(faces);a=p[tri[:,0]][:,[0,2]];e0=p[tri[:,1]][:,[0,2]]-a;e1=p[tri[:,2]][:,[0,2]]-a
    d00=(e0*e0).sum(1);d01=(e0*e1).sum(1);d11=(e1*e1).sum(1);den=np.where(abs(d00*d11-d01*d01)<1e-14,1e-14,d00*d11-d01*d01)
    for chunk in np.array_split(others,max(1,len(others)//500)):
        r=co[chunk][:,None,[0,2]]-a[None]
        d20=(r*e0[None]).sum(2);d21=(r*e1[None]).sum(2)
        v=(d11*d20-d01*d21)/den;w=(d00*d21-d01*d20)/den;bary=np.stack([1-v-w,v,w],axis=2)
        best=bary.min(axis=2).argmax(axis=1);rows=np.arange(len(chunk))
        weights=np.clip(bary[rows,best],0,None);weights/=weights.sum(axis=1,keepdims=True)
        for name in PRESETS:
            shift[name][chunk]=np.einsum('nk,nkd->nd',weights,delta[name][tri[best]])
    face_pixels=project_front_face(body,seams,source,p,oval,face_width,to_image)
    body.shape_key_add(name='Basis',from_mix=False)
    for name in PRESETS:
        key=body.shape_key_add(name=name,from_mix=False)
        key.data.foreach_set('co',(co+shift[name]).ravel())
    # Each closed eye's rim must lie on the closed lid line: both lids move onto the same line.
    gaps=[]
    for upper,lower in EYES:
        line=targets['blink'][upper][:,[0,2]]
        rim=[i for i,(ids,_,_) in snapped.items() if ids is upper or ids is lower]
        closed=(co+shift['blink'])[rim]
        _,_,distance=nearest_on_polyline(closed[:,[0,2]],line)
        gaps.append(float(distance.max()))
    report={'mode':'wrapped-head','boundVertices':int(front.sum()),'openingRimVertices':len(snapped),
            'removedFaces':removed_count,'frontFacePixels':face_pixels,'blinkClosureGapMeters':gaps}
    return targets,eye_data,mouth_center,mouth_width,report


def build_fitted_face(body, rig, height, landmarks_path, reference_path, allow_template_warnings=False, wrap=True):
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
    faces=[]
    for line in (Path(__file__).parent/'face-template'/'canonical-face.obj').read_text().splitlines():
        if line.startswith('f '):
            faces.append(tuple(int(item.split('/')[0])-1 for item in line.split()[1:]))
    capped_faces=faces
    # Google's canonical surface caps the eyes and mouth. Remove those triangles
    # to create real apertures; otherwise morphing merely stretches a painted face.
    faces=[tri for tri in faces if not any(set(tri).issubset(ring) for ring in OPENINGS)]
    face_width = float(np.ptp(p[:,0]))
    policy=json.loads(Path(__file__).with_name('template-policy.json').read_text(encoding='utf-8'))
    template_warnings=[]
    if not policy['faceWidthMin']*height < face_width < policy['faceWidthMax']*height:
        template_warnings.append(f"Detected face width is {face_width / height:.1%} of character height; tested range is {policy['faceWidthMin']:.0%}-{policy['faceWidthMax']:.0%}.")
    face_height=float(np.ptp(p[:,2]))/height
    if face_height>policy['faceHeightMax']:
        template_warnings.append(f"Detected face height is {face_height:.1%} of character height; tested maximum is {policy['faceHeightMax']:.0%}.")
    if float(p[:,2].min())/height<policy['faceBaseMinHeight']:
        template_warnings.append('The face sits lower on the body than the tested template expects. Neck and shoulder joints may be misplaced.')
    if template_warnings and not allow_template_warnings:
        raise RuntimeError(' '.join(template_warnings)+' Review and explicitly accept template warnings to try this character anyway.')
    seams=runpy.run_path(str(Path(__file__).with_name('face-seams.py')))
    oval=seams['OVAL']
    parts=[]
    def bind(obj):
        group=obj.vertex_groups.new(name='head')
        group.add(list(range(len(obj.data.vertices))),1,'REPLACE')
        obj.parent=rig
        modifier=obj.modifiers.new('FaceRig','ARMATURE');modifier.object=rig
    wrapped=None
    if wrap:
        # The landmarks sit exactly on the generated head here (no smoothing, no lift), so
        # the head's own vertices can follow them.
        try:
            source=bpy.data.images.load(str(reference_path),check_existing=True)
            def to_image(co):
                co=np.asarray(co,dtype=float)
                return co[...,0]/scale+(left+right)/2,bottom-co[...,2]/scale
            wrapped=wrap_head(body,p.copy(),faces,face_width,height,seams,source,to_image)
        except RuntimeError as error:
            print('FACE_WRAP_FALLBACK '+str(error),flush=True)
    if wrapped:
        targets,eye_data,mouth_center,mouth_width,wrap_report=wrapped
    else:
        # Smooth noisy generated eye/lip relief while retaining each character's depth.
        neighbors=[set() for _ in p]
        for tri in faces:
            for i in tri: neighbors[i].update(set(tri)-{i})
        for _ in range(1):
            p[:,1] = [.75*p[i,1]+.25*np.mean(p[list(ns),1]) for i,ns in enumerate(neighbors)]
        p[:,1] -= .0008*height
        appearance=seams['SurfaceAppearance'](body)
        distances=seams['boundary_distance'](faces,len(p))
        cut_positions=p.copy()
        # Leave a real annular space for the stitch. The old cut follows the detected
        # oval; placing the replacement on that same jagged outline folds the bridge
        # back over itself and causes a serrated, mask-like overlap.
        center=p[oval].mean(axis=0)
        inset=np.interp(distances,[0,1,2,3],[.90,.96,.99,1])
        p[:,[0,2]]=center[[0,2]]+(p[:,[0,2]]-center[[0,2]])*inset[:,None]
        for i in np.flatnonzero(distances<3):
            hit,_,_,_=surface.ray_cast(Vector((p[i,0],-height,p[i,2])),Vector((0,1,0)),2*height)
            if hit:p[i,1]=hit.y-.0008*height
        fitted_uv=np.array([[(co[0]/scale+(left+right)/2)/width,1-(bottom-co[2]/scale)/image_height] for co in p])
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
                uv.data[index].uv=fitted_uv[vertex]
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
        patch_bvh=BVHTree.FromPolygons([Vector(v) for v in cut_positions],capped_faces)
        minimum_cut_height=float(cut_positions[:,2].min())-.05*height if allow_template_warnings else policy['minimumCutHeight']*height
        body_loop_ids,removed_count=seams['cut_head'](body,patch_bvh,face_width,minimum_cut_height)
        parts.append(face)
        bind(face)
        face.shape_key_add(name='Basis')
        targets,eye_data,mouth_center,mouth_width=expression_targets(p,face_width,oval)
        for name in PRESETS:
            key=face.shape_key_add(name=name,from_mix=False)
            for vertex,co in zip(key.data,targets[name]): vertex.co=co
        source=image.image
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
    pixels=np.array(source.pixels[:]).reshape(source.size[1],source.size[0],4)
    eye_colors=[]
    for index,(center,ew,upper,lower) in enumerate(eye_data):
        # Actual eyeballs sit behind the eyelid opening. Iris colour is sampled
        # from the source image; the eyelids themselves belong to the fitted skin.
        # On the head's own face the opening is a real hole in a thick surface: a wider eyeball
        # sits just behind the lids, so a three-quarter view doesn't look past it into the head.
        depth,radii=((.62,(.7,.52,.55)) if wrapped else (.75,(.58,.45,.49)))
        forward=(.75-.45)-(depth-radii[1])
        ec=center.copy();ec[1]+=ew*depth
        solid('Eyeball'+str(index),ec,tuple(ew*r for r in radii),(.92,.94,.93))
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
        ic=center.copy();ic[1]+=ew*(.29-forward)
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
        key=cavity.shape_key_add(name=name,from_mix=False)
        for v,co in zip(key.data,cavity_coords(targets[name])):v.co=co
    common={'landmarkCount':len(lm),
        'templatePolicyVersion':policy['version'],'templateWarnings':template_warnings,'templateWarningsAccepted':bool(template_warnings and allow_template_warnings),
        'surfaceHitRatio':sum(y is not None for y in hits)/len(p),
        'faceWidthMeters':face_width,'topologyVertices':len(p),'expressions':PRESETS,
        'irisColorsLinearRGB':eye_colors,
        'openingTrianglesRemoved':len(capped_faces)-len(faces),
        'neutralEyeApertureMeters':[float(np.max(p[upper,2]-p[lower,2])) for upper,lower in EYES]}
    if wrapped:
        report={'pipeline':'landmark-wrapped-head-v1',**common,'wrap':wrap_report,
            'blinkClosureGapMeters':wrap_report['blinkClosureGapMeters'],
            'limits':['Single frontal adult humanoid on white background','Expressions move the generated head itself; its shape and painted appearance are kept','No teeth or tongue yet','Stylised detection/fitting requires visual review']}
    else:
        # Stitch to the actual cut loop, not to a guessed enlarged oval floating
        # over the generated head. Both edges use matching positions and head weights.
        inner=p[oval].copy()
        original_outer=np.array([body.data.vertices[i].co[:] for i in body_loop_ids])
        outer,order,bridge_triangles=seams['stitch_faces'](inner,original_outer)
        outer_ids=[body_loop_ids[i] for i in order]
        count=len(inner);bridge_points=np.vstack([inner,outer])
        seam_mesh=bpy.data.meshes.new('StitchedHeadBoundary')
        seam_mesh.from_pydata(bridge_points.tolist(),[],bridge_triangles);seam_mesh.update()
        seam=bpy.data.objects.new('FaceBoundaryBlend',seam_mesh);bpy.context.scene.collection.objects.link(seam)
        seam.data.materials.append(material);bind(seam);parts.append(seam)
        bridge_uv=np.array([[(co[0]/scale+(left+right)/2)/width,1-(bottom-co[2]/scale)/image_height] for co in bridge_points])
        # Inner UVs match the fitted face exactly, including sub-pixel landmark position.
        bridge_uv[:count]=fitted_uv[oval]
        uv=seam_mesh.uv_layers.new(name='ReferenceProjection')
        for poly in seam_mesh.polygons:
            poly.use_smooth=True
            for li in poly.loop_indices:uv.data[li].uv=bridge_uv[seam_mesh.loops[li].vertex_index]
        # Matching edge coordinates stay fixed for every shape, including combined
        # speech and emotion, so the bridge needs no independent expression weights.
        painted_pixels=appearance.match_head(body,source,cut_positions,lm,scale,(left+right)/2,bottom,image_height,body_loop_ids)
        colors=np.array([appearance.seam_color(co) for co in p])
        fade=np.interp(distances,[0,1,2,3],[1,.65,.2,0])
        all_uv=np.vstack([fitted_uv,bridge_uv])
        all_colors=np.vstack([colors,np.array([appearance.seam_color(co) for co in bridge_points])])
        all_fade=np.concatenate([fade,np.ones(len(bridge_points))])
        bake_triangles=list(faces)+[tuple(i+len(p) for i in tri) for tri in bridge_triangles]
        image.image=seams['bake_boundary'](source,all_uv,bake_triangles,all_colors,all_fade,len(faces),appearance.not_backdrop)
        sideways_bridge=seams['texture_sideways_bridge'](seam,count,all_colors[len(p):],material)
        boundary_gaps=[float(np.linalg.norm(np.array(face.data.vertices[vi].co)-bridge_points[i])) for i,vi in enumerate(oval)]
        boundary_gaps += [float(np.linalg.norm(np.array(body.data.vertices[vi].co)-bridge_points[count+i])) for i,vi in enumerate(outer_ids)]
        max_boundary_gap=max(boundary_gaps)
        if max_boundary_gap>1e-6:raise RuntimeError('The fitted face boundary is not sealed.')
        # Gaze is separate from emotion and lip-sync; no rigid eye squashing for blink.
        report={'pipeline':'landmark-fitted-face-sealed-v2',**common,'replacedTriangles':removed_count,
            'seam':{'bodyBoundaryVertices':len(outer_ids),'bridgeTriangles':len(bridge_triangles),'sidewaysBridgeTriangles':int(sideways_bridge),'maxJoinGapMeters':max_boundary_gap,'fixedExpressionBoundary':True,'matchedHeadSkin':True,'skinColorOffset':appearance.offset.tolist(),'matchedSkinPixels':painted_pixels,'appearance':'skin calibration and shared boundary texture'},
            'blinkClosureGapMeters':[max(float((face.data.shape_keys.key_blocks['blink'].data[a].co-face.data.shape_keys.key_blocks['blink'].data[b].co).length) for a,b in zip(upper,lower)) for upper,lower in EYES],
            'limits':['Single frontal adult humanoid on white background','Source-projected appearance; no unseen detail reconstruction','No teeth or tongue yet','Stylised detection/fitting requires visual review']}
    if any(gap > .00001 for gap in report['blinkClosureGapMeters']):
        raise RuntimeError('Fitted eyelids do not close: '+str(report['blinkClosureGapMeters']))
    if any(gap < .001 for gap in report['neutralEyeApertureMeters']):
        raise RuntimeError('Reference eyes must be open for fitting.')
    return parts,report
