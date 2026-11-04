import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';

const presets = ['neutral', 'blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'relaxed', 'sad', 'angry', 'surprised', 'fear', 'disgust', 'lookLeft', 'lookRight'];

/** The face box from stylised-face-landmarks.json, in three.js (glTF) coordinates. */
function faceFrame(data) {
  const [width, height] = data.imageSize;
  const toModel = (x, y) => {
    if (data.modelFrame) {
      const { center, size } = data.modelFrame;
      return [center[0] + (x / width - 0.5) * size, center[1] + (0.5 - y / height) * size];
    }
    const [left, top, right, bottom] = data.bodyBounds;
    const scale = 1.6 / (bottom - top);
    return [(x - (left + right) / 2) * scale, (bottom - y) * scale];
  };
  const [x0, y1] = toModel(data.face[0], data.face[1]);
  const [x1, y0] = toModel(data.face[2], data.face[3]);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, size: Math.max(x1 - x0, y1 - y0) * 1.7 };
}

async function review() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x243044);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.append(renderer.domElement);
  for (const [id] of await window.faceReview.characters()) {
    const bytes = await window.faceReview.model(id);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(bytes.buffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('No VRM: ' + id);
    const scene = new THREE.Scene();
    scene.add(vrm.scene);
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    vrm.scene.updateMatrixWorld(true);
    const frame = faceFrame(await window.faceReview.frame(id));
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const centre = new THREE.Vector3(frame.x, frame.y, head.getWorldPosition(new THREE.Vector3()).z);
    const camera = new THREE.OrthographicCamera(-frame.size / 2, frame.size / 2, frame.size / 2, -frame.size / 2, 0.01, 20);
    const shoot = async (name, size = [384, 384]) => {
      renderer.setSize(...size);
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
      await window.faceReview.save({ id, name, png: renderer.domElement.toDataURL('image/png') });
    };
    const front = () => {
      camera.position.set(centre.x, centre.y, centre.z + 3);
      camera.lookAt(centre);
    };
    const meshes = [];
    vrm.scene.traverse((obj) => {
      if (obj.isMesh && obj.morphTargetInfluences?.length) meshes.push(obj);
    });
    const sample = () => {
      const out = [];
      const v = new THREE.Vector3();
      for (const mesh of meshes) {
        const positions = mesh.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) out.push(...mesh.getVertexPosition(i, v).toArray());
      }
      return out;
    };
    const moved = {};
    let baseline;
    front();
    for (const name of presets) {
      vrm.expressionManager.resetValues();
      if (name !== 'neutral') {
        if (!vrm.expressionManager.getExpression(name)) throw new Error(`Missing expression ${id}/${name}`);
        vrm.expressionManager.setValue(name, 1);
      }
      await shoot('x-' + name);
      if (name === 'neutral' && meshes.some((m) => m.morphTargetInfluences.some((w) => Math.abs(w) > 1e-8)))
        throw new Error('Non-neutral runtime defaults: ' + id);
      const positions = sample();
      baseline ??= positions;
      moved[name] = positions.reduce((most, value, i) => Math.max(most, Math.abs(value - baseline[i])), 0);
      if (name !== 'neutral' && moved[name] < 1e-5) throw new Error(`Static expression ${id}/${name}`);
    }
    // Three-quarter views, at rest and talking with a smile.
    for (const [name, angle, talk] of [['quarter-left', -0.5, false], ['quarter-right', 0.5, false], ['quarter-talk', 0.5, true]]) {
      vrm.expressionManager.resetValues();
      if (talk) {
        vrm.expressionManager.setValue('happy', 0.6);
        vrm.expressionManager.setValue('aa', 0.6);
      }
      camera.position.copy(centre).add(new THREE.Vector3(3 * Math.sin(angle), 0, 3 * Math.cos(angle)));
      camera.lookAt(centre);
      await shoot(name);
    }
    // The whole character, from the front.
    vrm.expressionManager.resetValues();
    const body = new THREE.Box3().setFromObject(vrm.scene);
    const bodyCentre = body.getCenter(new THREE.Vector3());
    const tall = body.max.y - body.min.y;
    const full = new THREE.OrthographicCamera(-tall * 0.35, tall * 0.35, tall * 0.56, -tall * 0.56, 0.01, 20);
    full.position.set(bodyCentre.x, bodyCentre.y, bodyCentre.z + 3);
    full.lookAt(bodyCentre);
    renderer.setSize(300, 480);
    vrm.update(0);
    renderer.render(scene, full);
    await window.faceReview.save({ id, name: 'full-body', png: renderer.domElement.toDataURL('image/png') });
    // Speaking, blinking and smiling, frame by frame, for the animations.
    front();
    for (let i = 0; i < 48; i++) {
      vrm.expressionManager.resetValues();
      const weight = Math.sin(((i % 16) / 15) * Math.PI);
      vrm.expressionManager.setValue(i < 16 ? 'aa' : i < 32 ? 'blink' : 'happy', weight);
      await shoot('frame-' + String(i).padStart(2, '0'), [256, 256]);
    }
    await window.faceReview.save({
      id,
      name: 'verification',
      meta: {
        expressions: vrm.expressionManager.expressions.map((e) => e.expressionName),
        maxVertexDisplacementMeters: moved,
        renderer: 'three-vrm, loading the exported VRM',
      },
    });
    console.log('VERIFIED', id);
  }
}

review()
  .catch(async (error) => {
    console.error(error.stack);
    await window.faceReview.save({ id: 'error', name: 'runtime', meta: { error: error.stack } });
  })
  .finally(() => window.faceReview.done());
