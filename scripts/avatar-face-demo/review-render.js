import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
const presets = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fear',
  'disgust',
  'surprised',
  'blink',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'lookLeft',
  'lookRight',
];
async function review() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(320, 320);
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
    const face = vrm.scene.getObjectByName('FittedFace');
    if (!face) throw new Error('No fitted face: ' + id);
    const box = new THREE.Box3().setFromObject(face);
    const center = box.getCenter(new THREE.Vector3());
    const scale = box.getSize(new THREE.Vector3()).y * 1.65;
    const camera = new THREE.OrthographicCamera(
      -scale / 2,
      scale / 2,
      scale / 2,
      -scale / 2,
      0.01,
      20,
    );
    camera.position.set(center.x, center.y, center.z + 3);
    camera.lookAt(center);
    const metrics = {};
    const sample = () => {
      const positions = face.geometry.attributes.position;
      const vertex = new THREE.Vector3();
      const values = [];
      for (let i = 0; i < positions.count; i++) {
        face.getVertexPosition(i, vertex);
        values.push(...vertex.toArray());
      }
      return values;
    };
    let baseline;
    let irisBaseline;
    const diagnostic = {};
    for (const name of presets) {
      vrm.expressionManager.resetValues();
      if (name !== 'neutral') {
        if (!vrm.expressionManager.getExpression(name))
          throw new Error('Missing expression ' + id + '/' + name);
        vrm.expressionManager.setValue(name, 1);
      }
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
      const positions = sample();
      if (name === 'neutral') {
        diagnostic.influences = [...face.morphTargetInfluences];
        if (diagnostic.influences.some((weight) => Math.abs(weight) > 1e-8))
          throw new Error('Non-neutral runtime defaults: ' + id);
        diagnostic.targets = face.morphTargetDictionary;
        diagnostic.meshes = [];
        scene.traverse((obj) => {
          if (obj.isMesh && /FittedFace|Eyeball|Iris|Pupil/.test(obj.name)) {
            const bounds = new THREE.Box3().setFromObject(obj);
            diagnostic.meshes.push({
              name: obj.name,
              min: bounds.min.toArray(),
              max: bounds.max.toArray(),
            });
          }
        });
      }
      if (!baseline) baseline = positions;
      metrics[name] = Math.max(...positions.map((v, i) => Math.abs(v - baseline[i])));
      const iris = vrm.scene.getObjectByName('Iris0');
      const irisVertex = new THREE.Vector3();
      iris.getVertexPosition(0, irisVertex);
      if (!irisBaseline) irisBaseline = irisVertex.clone();
      if (name === 'lookLeft' || name === 'lookRight') {
        metrics[name] = irisVertex.distanceTo(irisBaseline);
        if (metrics[name] < 0.00001) throw new Error('Static gaze ' + id + '/' + name);
      }
      if (!['neutral', 'lookLeft', 'lookRight'].includes(name) && metrics[name] < 0.00001)
        throw new Error('Static expression ' + id + '/' + name);
      await window.faceReview.save({
        id,
        name: name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        png: renderer.domElement.toDataURL('image/png'),
      });
    }
    // Intermediate frames demonstrate actual interpolation on the exported VRM.
    for (let frame = 0; frame < 48; frame++) {
      vrm.expressionManager.resetValues();
      const cycle = frame % 16;
      const weight = Math.sin((cycle / 15) * Math.PI);
      vrm.expressionManager.setValue(frame < 16 ? 'aa' : frame < 32 ? 'blink' : 'happy', weight);
      vrm.update(0);
      renderer.render(scene, camera);
      // Alphabetic output names keep the review IPC whitelist deliberately narrow.
      const frameName =
        'frame-' +
        String.fromCharCode(97 + Math.floor(frame / 26)) +
        String.fromCharCode(97 + (frame % 26));
      await window.faceReview.save({
        id,
        name: frameName,
        png: renderer.domElement.toDataURL('image/png'),
      });
    }
    await window.faceReview.save({
      id,
      name: 'verification',
      meta: {
        expressions: vrm.expressionManager.expressions.map((e) => e.expressionName),
        maxVertexDisplacementMeters: metrics,
        frameCount: 48,
        renderer: 'three-vrm actual exported VRM; no user configuration changed',
        diagnostic,
      },
    });
    console.log('VERIFIED', id);
    scene.traverse((obj) => {
      if (obj.isMesh) obj.geometry.dispose();
    });
  }
}
review()
  .catch(async (error) => {
    console.error(error.stack);
    await window.faceReview.save({ id: 'error', name: 'runtime', meta: { error: error.stack } });
  })
  .finally(() => window.faceReview.done());
