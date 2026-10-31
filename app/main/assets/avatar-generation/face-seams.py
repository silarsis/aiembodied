"""Stitch a fitted face to the actual head cut and bake a shared boundary colour.

Blender-only helpers. Facial controls remain on the small fitted surface rather
than adding morph targets to the entire generated body.
"""
from collections import defaultdict, deque
import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import barycentric_transform

OVAL=[10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]


class SurfaceAppearance:
    """Keep the original surface/UVs available after its front face is removed."""
    def __init__(self,body):
        mesh=body.data;mesh.calc_loop_triangles()
        self.points=[v.co.copy() for v in mesh.vertices]
        self.triangles=[tuple(t.vertices) for t in mesh.loop_triangles]
        self.bvh=BVHTree.FromPolygons(self.points,self.triangles,all_triangles=True)
        self.images={};self.textures=[]
        self.uv=[[Vector((*mesh.uv_layers.active.data[i].uv,0)) for i in tri.loops] for tri in mesh.loop_triangles]
        self.materials=[tri.material_index for tri in mesh.loop_triangles]
        for mat in mesh.materials:
            shader=mat.node_tree.nodes.get('Principled BSDF') if mat and mat.use_nodes else None
            color=shader.inputs['Base Color'] if shader else None
            texture=color.links[0].from_node if color and color.is_linked else None
            image=texture.image if texture and texture.type=='TEX_IMAGE' else None
            self.textures.append(image.name if image else None)
            if image and image.name not in self.images:
                self.images[image.name]=np.array(image.pixels[:],dtype=np.float32).reshape(image.size[1],image.size[0],4)

    def sample(self,point):
        hit,_,index,_=self.bvh.find_nearest(Vector(point))
        material=self.materials[index];texture=self.textures[material]
        if texture is None:raise RuntimeError('The generated head needs a base-colour texture.')
        a,b,c=[self.points[i] for i in self.triangles[index]]
        uv=barycentric_transform(hit,a,b,c,*self.uv[index])
        pixels=self.images[texture];h,w=pixels.shape[:2]
        x=np.clip(uv.x*w-.5,0,w-1);y=np.clip(uv.y*h-.5,0,h-1)
        ix,iy=int(x),int(y);jx,jy=min(ix+1,w-1),min(iy+1,h-1);sx,sy=x-ix,y-iy
        return (1-sy)*((1-sx)*pixels[iy,ix,:3]+sx*pixels[iy,jx,:3])+sy*((1-sx)*pixels[jy,ix,:3]+sx*pixels[jy,jx,:3])

    def skin_weight(self,rgb):
        chroma=rgb/np.maximum(rgb.sum(axis=-1,keepdims=True),.001)
        distance=np.linalg.norm(chroma-self.skin_chroma,axis=-1)
        brightness=np.clip((rgb.sum(axis=-1)-self.skin_sum*.2)/(self.skin_sum*.4),0,1)
        return np.exp(-.5*(distance/.065)**2)*brightness

    def corrected(self,rgb):
        return np.clip(rgb+self.offset*self.skin_weight(rgb)[...,None],0,1)

    def reference_color(self,points):
        x=np.clip(points[...,0]/self.scale+self.center_x-.5,0,self.ref.shape[1]-1)
        y=np.clip(self.image_height-self.bottom+points[...,2]/self.scale-.5,0,self.ref.shape[0]-1)
        ix=x.astype(int);iy=y.astype(int);jx=np.minimum(ix+1,self.ref.shape[1]-1);jy=np.minimum(iy+1,self.ref.shape[0]-1)
        sx=(x-ix)[...,None];sy=(y-iy)[...,None]
        return (1-sy)*((1-sx)*self.ref[iy,ix,:3]+sx*self.ref[iy,jx,:3])+sy*((1-sx)*self.ref[jy,ix,:3]+sx*self.ref[jy,jx,:3])

    def seam_color(self,point):
        base=self.sample(point);co=np.asarray(point);target=self.reference_color(co)
        hit,_,_,_=self.bvh.ray_cast(Vector((co[0],-2,co[2])),Vector((0,1,0)),4)
        visibility=1 if hit and abs(hit.y-co[1])<.004 else 0
        band=self.band_weight(co)
        weight=band*visibility
        if min(target)>.92:weight=0
        return self.corrected(base)*(1-weight)+target*weight

    def band_weight(self,points):
        x,z=points[...,0],points[...,2]
        return np.minimum.reduce([np.clip((z-self.border_lo[2]+.05)/.05,0,1),np.clip((self.border_hi[2]+.003-z)/.003,0,1),np.clip((x-self.border_lo[0]+.005)/.005,0,1),np.clip((self.border_hi[0]+.005-x)/.005,0,1)])

    def match_head(self,body,source,p,landmarks,scale,center_x,bottom,image_height,boundary_ids):
        # Fit a skin-tone correction from matching forehead, nose and cheek
        # samples. Keep the generated hair/ear/neck detail; projecting an entire
        # single-view photograph here would paint backdrop gaps onto that detail.
        pixels=np.array(source.pixels[:],dtype=np.float32).reshape(source.size[1],source.size[0],4)
        self.ref=pixels;self.scale=scale;self.center_x=center_x;self.bottom=bottom;self.image_height=image_height
        anchors=[4,6,9,50,101,118,205,280,330,347,425,151]
        original=np.array([self.sample(p[i]) for i in anchors])
        target=np.array([pixels[int(np.clip((1-landmarks[i,1])*source.size[1],0,source.size[1]-1)),int(np.clip(landmarks[i,0]*source.size[0],0,source.size[0]-1)),:3] for i in anchors])
        skin=np.median(original,axis=0);reference=np.median(target,axis=0)
        self.skin_chroma=skin/max(float(skin.sum()),.001);self.skin_sum=float(skin.sum())
        self.offset=np.clip(reference-skin,-.30,.30)
        mesh=body.data;mesh.calc_loop_triangles();layer=mesh.uv_layers.active
        points=np.array([v.co[:] for v in mesh.vertices])
        self.border_lo=points[boundary_ids].min(axis=0);self.border_hi=points[boundary_ids].max(axis=0)
        # Correct only head/neck skin. The shirt, arms and back-facing hair retain
        # their own colours; there is no front-photo silhouette to introduce halos.
        weights=np.clip((points[:,2]-1.6*.73)/(1.6*.07),0,1)
        visible=np.zeros(len(points))
        for i,point in enumerate(points):
            if weights[i]==0:continue
            hit,_,_,_=self.bvh.ray_cast(Vector((point[0],-2,point[2])),Vector((0,1,0)),4)
            if hit and abs(hit.y-point[1])<.004:visible[i]=1
        atlases={name:pix.copy() for name,pix in self.images.items()}
        painted={name:np.zeros(pix.shape[:2],dtype=bool) for name,pix in atlases.items()}
        occupied={name:np.zeros(pix.shape[:2],dtype=bool) for name,pix in atlases.items()}
        for tri in mesh.loop_triangles:
            texture=self.textures[tri.material_index]
            if texture is None:continue
            output=atlases[texture];h,w=output.shape[:2]
            uv=np.array([layer.data[i].uv[:] for i in tri.loops])*[w,h]-.5
            raster=raster_triangle(uv,w,h)
            if raster is None:continue
            lo,hi,wa,wb,wc,mask=raster;ids=list(tri.vertices)
            occupied[texture][lo[1]:hi[1]+1,lo[0]:hi[0]+1] |= mask
            if max(weights[ids])==0:continue
            weight=wa*weights[ids[0]]+wb*weights[ids[1]]+wc*weights[ids[2]]
            region=output[lo[1]:hi[1]+1,lo[0]:hi[0]+1,:3]
            base=self.images[texture][lo[1]:hi[1]+1,lo[0]:hi[0]+1,:3]
            correction=self.offset*self.skin_weight(base)[...,None]*weight[...,None]
            calibrated=np.clip(base+correction,0,1)
            co=wa[...,None]*points[ids[0]]+wb[...,None]*points[ids[1]]+wc[...,None]*points[ids[2]]
            reference_color=self.reference_color(co)
            projection=self.band_weight(co)*(wa*visible[ids[0]]+wb*visible[ids[1]]+wc*visible[ids[2]])
            projection[np.min(reference_color,axis=2)>.92]=0
            region[mask]=(calibrated*(1-projection[...,None])+reference_color*projection[...,None])[mask]
            painted[texture][lo[1]:hi[1]+1,lo[0]:hi[0]+1] |= mask&(weight>.95)
        baked={}
        for name,pixels in atlases.items():
            # Filter footprints cross atlas chart borders. Extend the new colour
            # into unused gutters, never over another chart's actual geometry.
            pixels,_=extend_colors(pixels,painted[name],2,blocked=occupied[name])
            image=bpy.data.images[name].copy();image.name='MatchedHeadSkinAtlas'
            image.pixels.foreach_set(pixels.ravel());image.update();image.pack();baked[name]=image
        for mat in mesh.materials:
            if mat and mat.use_nodes:
                shader=mat.node_tree.nodes.get('Principled BSDF');color=shader.inputs['Base Color'] if shader else None
                texture=color.links[0].from_node if color and color.is_linked else None
                if texture and texture.type=='TEX_IMAGE' and texture.image.name in baked:texture.image=baked[texture.image.name]
        return int(sum(mask.sum() for mask in painted.values()))


def extend_colors(pixels,covered,iterations,blocked=None):
    pixels=pixels.copy();covered=covered.copy()
    for _ in range(iterations):
        totals=np.zeros_like(pixels);count=np.zeros(covered.shape,dtype=np.float32)
        for dy,dx in ((0,1),(0,-1),(1,0),(-1,0)):
            sy=slice(max(0,-dy),covered.shape[0]-max(0,dy));sx=slice(max(0,-dx),covered.shape[1]-max(0,dx))
            ty=slice(max(0,dy),covered.shape[0]-max(0,-dy));tx=slice(max(0,dx),covered.shape[1]-max(0,-dx))
            mask=covered[sy,sx]
            totals[ty,tx]+=pixels[sy,sx]*mask[...,None];count[ty,tx]+=mask
        added=(~covered)&(count>0)
        if blocked is not None:added &= ~blocked
        pixels[added]=totals[added]/count[added,None];covered[added]=True
    return pixels,covered


def raster_triangle(coords,width,height):
    lo=np.maximum(np.floor(coords.min(axis=0)).astype(int),0);hi=np.minimum(np.ceil(coords.max(axis=0)).astype(int),[width-1,height-1])
    if np.any(hi<lo):return None
    xx,yy=np.meshgrid(np.arange(lo[0],hi[0]+1),np.arange(lo[1],hi[1]+1));grid=np.stack([xx,yy],axis=-1)
    a,b,c=coords;v0=b-a;v1=c-a;den=v0[0]*v1[1]-v1[0]*v0[1]
    if abs(den)<1e-8:return None
    rel=grid-a;wb=(rel[...,0]*v1[1]-v1[0]*rel[...,1])/den;wc=(v0[0]*rel[...,1]-rel[...,0]*v0[1])/den;wa=1-wb-wc
    return lo,hi,wa,wb,wc,(wa>=-1e-5)&(wb>=-1e-5)&(wc>=-1e-5)


def largest_component(faces):
    remaining=set(faces);largest=set()
    while remaining:
        start=remaining.pop();component={start};todo=[start]
        while todo:
            face=todo.pop()
            for edge in face.edges:
                for other in edge.link_faces:
                    if other in remaining:remaining.remove(other);component.add(other);todo.append(other)
        if len(component)>len(largest):largest=component
    return largest


def cut_head(body,patch,face_width,minimum_height=1.1):
    """Create one simple boundary; don't leave pinholes or floating cut fragments."""
    bm=bmesh.new();bm.from_mesh(body.data)
    marker=bm.verts.layers.int.new('face_cut_boundary')
    all_faces=set(bm.faces);candidates=set()
    for face in bm.faces:
        c=face.calc_center_median()
        hit,_,_,_=patch.ray_cast(Vector((c.x,-2,c.z)),Vector((0,1,0)),4)
        if hit and abs(c.y-hit.y)<face_width*.28:candidates.add(face)
    removed=largest_component(candidates)
    if len(removed)<10:raise RuntimeError('Cannot find a connected front head surface to replace.')
    # Only discard fragments disconnected by this cut. Existing independent
    # clothing/hair components elsewhere in the input must remain untouched.
    affected=set(removed);todo=list(removed)
    while todo:
        face=todo.pop()
        for edge in face.edges:
            for other in edge.link_faces:
                if other not in affected:affected.add(other);todo.append(other)
    protected=all_faces-affected
    for _ in range(16):
        kept=largest_component(affected-removed)|protected
        removed=all_faces-kept
        edges=[e for e in bm.edges if len(e.link_faces)==2 and sum(f in removed for f in e.link_faces)==1]
        degree=defaultdict(int)
        for edge in edges:
            for vertex in edge.verts:degree[vertex]+=1
        bad=[v for v,n in degree.items() if n!=2]
        if not bad:break
        for vertex in bad:removed.update(vertex.link_faces)
    else:raise RuntimeError('The generated head cut has a branched boundary. Try another reference.')
    # Save the boundary in order before deleting, while BMesh indices/weights are valid.
    adjacency=defaultdict(list)
    for edge in edges:
        a,b=edge.verts;adjacency[a].append(b);adjacency[b].append(a)
    start=next(iter(adjacency));loop=[start];previous=None;current=start
    while True:
        following=next(v for v in adjacency[current] if v!=previous)
        if following==start:break
        if following in loop:raise RuntimeError('Head boundary is not a simple loop.')
        loop.append(following);previous,current=current,following
    if len(loop)!=len(adjacency):raise RuntimeError('Head cut produced more than one boundary.')
    if any(v.co.z<minimum_height for v in loop):raise RuntimeError('Head cut extends below the detected head region.')
    # The bridge and face use the head bone exclusively. Give the matching body
    # edge the same weights so a neck/head turn cannot pull the surfaces apart.
    deform=bm.verts.layers.deform.active
    head=body.vertex_groups['head'].index
    for vertex in loop:
        weights=vertex[deform];weights.clear();weights[head]=1
    for index,vertex in enumerate(bm.verts):vertex.index=index
    loop_ids=[v.index for v in loop]
    for i,vertex in enumerate(loop):vertex[marker]=i+1
    count=len(removed)
    bmesh.ops.delete(bm,geom=list(removed),context='FACES')
    bm.to_mesh(body.data);bm.free();body.data.update()
    markers=body.data.attributes.get('face_cut_boundary')
    ordered=sorted(((item.value-1,i) for i,item in enumerate(markers.data) if item.value),key=lambda item:item[0])
    if len(ordered)!=len(loop_ids):raise RuntimeError('Lost a head boundary vertex during cutting.')
    ids=[i for _,i in ordered]
    return ids,count


def boundary_distance(faces,count):
    adjacency=[set() for _ in range(count)]
    for tri in faces:
        for i in tri:adjacency[i].update(set(tri)-{i})
    distances=np.full(count,100,dtype=int);distances[OVAL]=0;todo=deque(OVAL)
    while todo:
        i=todo.popleft()
        for j in adjacency[i]:
            if distances[j]>distances[i]+1:distances[j]=distances[i]+1;todo.append(j)
    return distances


def stitch_faces(inner,outer):
    """Zipper two ordered loops by perimeter progress, with no extra open edges."""
    def progress(points):
        lengths=np.linalg.norm(np.roll(points,-1,axis=0)-points,axis=1)
        return np.concatenate([[0],np.cumsum(lengths)])/lengths.sum()
    # Choose the closest outer point to the first inner point, then match winding.
    index=int(np.argmin(np.linalg.norm(outer-inner[0],axis=1)))
    order=np.roll(np.arange(len(outer)),-index)
    def area(points):return np.sum(points[:,0]*np.roll(points[:,2],-1)-np.roll(points[:,0],-1)*points[:,2])
    if area(inner)*area(outer[order])<0:order=np.concatenate([order[:1],order[:0:-1]])
    outer=outer[order];a,b=progress(inner),progress(outer);n,m=len(inner),len(outer)
    faces=[];i=j=0
    while i<n or j<m:
        if i<n and (j==m or a[i+1]<=b[j+1]):
            faces.append((i%n,(i+1)%n,n+j%m));i+=1
        else:
            faces.append((i%n,n+(j+1)%m,n+j%m));j+=1
    return outer,order,faces



def bake_boundary(source,uvs,triangles,colors,fade,face_triangle_count):
    pixels=np.array(source.pixels[:],dtype=np.float32).reshape(source.size[1],source.size[0],4)
    base=pixels.copy();h,w=pixels.shape[:2];weighted=np.asarray(colors)*fade[:,None]
    coords=np.asarray(uvs)*[w,h]-.5
    x=np.clip(coords[:,0],0,w-1);y=np.clip(coords[:,1],0,h-1)
    ix=x.astype(int);iy=y.astype(int);jx=np.minimum(ix+1,w-1);jy=np.minimum(iy+1,h-1)
    sx=(x-ix)[:,None];sy=(y-iy)[:,None]
    reference=(1-sy)*((1-sx)*base[iy,ix,:3]+sx*base[iy,jx,:3])+sy*((1-sx)*base[jy,ix,:3]+sx*base[jy,jx,:3])
    correction=(np.asarray(colors)-reference)*fade[:,None]
    occupied=np.zeros((h,w),dtype=bool)
    for triangle_index,tri in enumerate(triangles):
        ids=np.array(tri);raster=raster_triangle(np.asarray(uvs)[ids]*[w,h]-.5,w,h)
        if raster is None:continue
        lo,hi,a,b,c,mask=raster
        weight=a*fade[ids[0]]+b*fade[ids[1]]+c*fade[ids[2]]
        color=a[...,None]*weighted[ids[0]]+b[...,None]*weighted[ids[1]]+c[...,None]*weighted[ids[2]]
        region=pixels[lo[1]:hi[1]+1,lo[0]:hi[0]+1,:3]
        original=base[lo[1]:hi[1]+1,lo[0]:hi[0]+1,:3]
        delta=a[...,None]*correction[ids[0]]+b[...,None]*correction[ids[1]]+c[...,None]*correction[ids[2]]
        result=original+delta
        if triangle_index>=face_triangle_count:
            outside=np.min(original,axis=2)>.92
            result[outside]=(original*(1-weight[...,None])+color)[outside]
        region[mask]=np.clip(result,0,1)[mask]
        occupied[lo[1]:hi[1]+1,lo[0]:hi[0]+1] |= mask
    pixels,_=extend_colors(pixels,occupied,2)
    image=source.copy();image.name='SealedFaceReference'
    image.pixels.foreach_set(pixels.ravel());image.update();image.pack()
    return image
