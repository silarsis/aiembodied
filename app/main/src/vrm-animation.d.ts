declare module '@pixiv/three-vrm-animation' {
    import { GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
    import { KeyframeTrack, Vector3 } from 'three';

    export class VRMAnimationLoaderPlugin {
        constructor(parser: GLTFParser);
    }

    export class VRMAnimation {
        duration: number;
        restHipsPosition: Vector3;
        humanoidTracks: {
            rotation: {
                set(bone: string, track: KeyframeTrack): void;
            };
            translation: {
                set(bone: string, track: KeyframeTrack): void;
            };
        };
        expressionTracks: {
            preset: {
                set(name: string, track: KeyframeTrack): void;
            };
            custom: {
                set(name: string, track: KeyframeTrack): void;
            };
        };
    }
}
