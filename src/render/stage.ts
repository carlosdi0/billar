import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export type Quality = 'low' | 'high';

export function detectQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.screen.width, window.screen.height) < 700;
  return coarse || small ? 'low' : 'high';
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private renderPass: RenderPass | null = null;
  private onResize: ((width: number, height: number) => void)[] = [];

  constructor(
    container: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    readonly quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x070504);
    this.scene.fog = new THREE.FogExp2(0x0a0705, 0.075);

    if (quality === 'high') {
      const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
      this.composer = new EffectComposer(this.renderer, target);
      this.renderPass = new RenderPass(this.scene, camera);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.2, 0.4, 1.05);
      this.composer.addPass(this.renderPass);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }

    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  addResizeListener(listener: (width: number, height: number) => void): void {
    this.onResize.push(listener);
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height);
    this.composer?.setSize(width, height);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    for (const listener of this.onResize) listener(width, height);
  }

  render(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
