import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import initJolt from 'jolt-physics';
import type JoltNS from 'jolt-physics';
import confetti from 'canvas-confetti';
import {
  ArrowRight,
  ArrowUp,
  Volume2,
  VolumeX,
  Sparkles,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Camera,
  PackagePlus,
  RotateCcw,
  Activity,
  Trophy,
} from 'lucide-react';
import {
  PRIZE_SPECS,
  STAGE_PHYSICS,
  PhysicsTuning,
  PrizeSpec,
  getRestingPosition,
} from '../constants/prizes';

type CameraView = 'front' | 'top' | 'right';

export type CranePhase =
  | 'idle'
  | 'ready_right'
  | 'moving_right'
  | 'ready_up'
  | 'moving_up'
  | 'descending'
  | 'closing'
  | 'lifting'
  | 'releasing'
  | 'settling';

export interface MachineSnapshot {
  hasStock: boolean;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  isInitialState: boolean;
  plays: number;
  wins: number;
}

export interface TelemetryData {
  headY: number;
  leftDeg: number;
  rightDeg: number;
  prizeY: number;
  prizeTiltDeg: number;
  prizeSpeed: number;
  isInitialState: boolean;
}

interface JoltUfoMachine3DProps {
  machineIndex: number;
  snapshots: MachineSnapshot[];
  tuning: PhysicsTuning;
  onSelectMachine: (idx: number) => void;
  onUpdateSnapshot: (idx: number, next: MachineSnapshot) => void;
  onPrizeWon: (spec: PrizeSpec) => void;
}

interface PlushGeoJson {
  w: number;
  h: number;
  d: number;
  positions: number[];
  uvs: number[];
  indices: number[];
}

let joltModulePromise: Promise<typeof JoltNS> | null = null;
function getJoltModule(): Promise<typeof JoltNS> {
  if (!joltModulePromise) {
    joltModulePromise = initJolt();
  }
  return joltModulePromise;
}

let cachedSandroneGeoData: PlushGeoJson | null = null;
let sandroneGeoPromise: Promise<PlushGeoJson | null> | null = null;

function loadSandronePlushGeoData(): Promise<PlushGeoJson | null> {
  if (cachedSandroneGeoData) return Promise.resolve(cachedSandroneGeoData);
  if (!sandroneGeoPromise) {
    sandroneGeoPromise = fetch('/assets/sandrone_plush_geo.json')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PlushGeoJson | null) => {
        if (data && Array.isArray(data.positions) && Array.isArray(data.indices)) {
          cachedSandroneGeoData = data;
          return data;
        }
        return null;
      })
      .catch(() => null);
  }
  return sandroneGeoPromise;
}

function buildBufferGeometryFromPlushData(data: PlushGeoJson): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
  geo.setIndex(data.indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function createSidePanelTexture(title: string, accent: string, bg: string, rewardSol: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 256, 128);
    grad.addColorStop(0, bg);
    grad.addColorStop(1, '#090d16');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 128);

    ctx.strokeStyle = accent;
    ctx.lineWidth = 8;
    ctx.strokeRect(6, 6, 244, 116);

    ctx.fillStyle = accent;
    ctx.font = '900 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, 128, 52);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`JOLT 3D · ${rewardSol} SOL`, 128, 88);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createFigureFrontTexture(spec: PrizeSpec): THREE.CanvasTexture {
  const cw = spec.isSquare ? 384 : 256;
  const ch = spec.isSquare ? 440 : 512;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const drawArtwork = (loadedImg?: HTMLImageElement) => {
    if (!ctx) return;
    ctx.fillStyle = spec.frontBg;
    ctx.fillRect(0, 0, cw, ch);

    if (loadedImg && loadedImg.width > 0 && loadedImg.height > 0) {
      const drawW = cw - 16;
      const drawH = spec.isSquare ? ch - 84 : ch - 16;
      const targetAspect = drawW / drawH;
      const srcAspect = loadedImg.width / loadedImg.height;
      let sx = 0;
      let sy = 0;
      let sw = loadedImg.width;
      let sh = loadedImg.height;
      if (srcAspect > targetAspect) {
        sw = loadedImg.height * targetAspect;
        sx = (loadedImg.width - sw) / 2;
      } else {
        sh = loadedImg.width / targetAspect;
        sy = (loadedImg.height - sh) * 0.2;
      }
      ctx.drawImage(loadedImg, sx, sy, sw, sh, 8, 8, drawW, drawH);
    }

    const bannerH = 70;
    const bannerY = ch - bannerH - 8;
    ctx.fillStyle = 'rgba(7, 11, 24, 0.84)';
    ctx.fillRect(8, bannerY, cw - 16, bannerH);

    ctx.fillStyle = spec.frontAccent;
    ctx.font = `900 ${spec.isSquare ? 28 : 24}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(spec.title, cw / 2, bannerY + 24);

    ctx.fillStyle = '#fde047';
    ctx.font = `bold ${spec.isSquare ? 17 : 15}px monospace`;
    ctx.fillText(`${spec.label} · ${spec.rewardSol} SOL`, cw / 2, bannerY + 52);

    ctx.strokeStyle = spec.frontAccent;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, cw - 10, ch - 10);

    tex.needsUpdate = true;
  };

  drawArtwork();

  const img = new window.Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => drawArtwork(img);
  img.src = spec.imgSrc;

  return tex;
}

function createFigureBoxMaterials(spec: PrizeSpec): THREE.MeshStandardMaterial[] {
  const frontTex = createFigureFrontTexture(spec);
  const sideTex = createSidePanelTexture(spec.title, spec.sideAccent, spec.sideBg, spec.rewardSol);
  const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.24, metalness: 0.12 });
  const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.30, metalness: 0.20 });
  return [sideMat, sideMat, frontMat, frontMat, sideMat, sideMat];
}

function createPlushMaterial(imgSrc: string): THREE.MeshStandardMaterial {
  const loader = new THREE.TextureLoader();
  const tex = loader.load(imgSrc);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.72,
    metalness: 0.04,
    alphaTest: 0.08,
  });
}

// 좌/우 실제 Jolt 복합 충돌체와 1:1 일치하는 집게 3-세그먼트 치수
const ARM_SEGMENTS = [
  { pos: [0.08, -0.19, 0] as const, rotZ: 0.35, half: [0.03, 0.20, 0.045] as const, isTip: false },
  { pos: [0.095, -0.52, 0] as const, rotZ: -0.32, half: [0.028, 0.17, 0.055] as const, isTip: false },
  { pos: [-0.015, -0.685, 0] as const, rotZ: 0.22, half: [0.068, 0.026, 0.075] as const, isTip: true },
];

const CLAW_OPEN_ANGLE = 0.64; // 양쪽 합산 개방폭 ~1.18m (0.96m 산드로네 인형까지 여유롭게 포용)
const CLAW_CLOSE_TARGET = -0.06; // 닫힘 목표 각도 (실제 물리 벽면에서 토크 평형으로 정지)

export const JoltUfoMachine3D: React.FC<JoltUfoMachine3DProps> = ({
  machineIndex,
  snapshots,
  tuning,
  onSelectMachine,
  onUpdateSnapshot,
  onPrizeWon,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [phase, setPhase] = useState<CranePhase>('idle');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [cameraView, setCameraView] = useState<CameraView>('front');
  const [frontTiptoeDeg, setFrontTiptoeDeg] = useState(0);
  const [showExtremeDrr, setShowExtremeDrr] = useState(false);
  const [showBalanceCatch, setShowBalanceCatch] = useState(false);
  const [droppedThisTurn, setDroppedThisTurn] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    headY: STAGE_PHYSICS.CLAW_HOME_Y,
    leftDeg: Math.round((CLAW_OPEN_ANGLE * 180) / Math.PI),
    rightDeg: Math.round((CLAW_OPEN_ANGLE * 180) / Math.PI),
    prizeY: 1.08,
    prizeTiltDeg: 0,
    prizeSpeed: 0,
    isInitialState: true,
  });

  const phaseRef = useRef<CranePhase>('idle');
  const soundEnabledRef = useRef(true);
  const cameraViewRef = useRef<CameraView>('front');
  const frontTiptoeDegRef = useRef(0);
  const tuningRef = useRef<PhysicsTuning>(tuning);
  const machineIndexRef = useRef(machineIndex);
  const snapshotsRef = useRef(snapshots);
  const onUpdateSnapshotRef = useRef(onUpdateSnapshot);
  const onPrizeWonRef = useRef(onPrizeWon);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const drrAudioRef = useRef<HTMLAudioElement | null>(null);
  const bcAudioRef = useRef<HTMLAudioElement | null>(null);
  const drrTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bcTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);
  useEffect(() => {
    cameraViewRef.current = cameraView;
  }, [cameraView]);
  useEffect(() => {
    frontTiptoeDegRef.current = frontTiptoeDeg;
  }, [frontTiptoeDeg]);
  useEffect(() => {
    tuningRef.current = tuning;
  }, [tuning]);
  useEffect(() => {
    machineIndexRef.current = machineIndex;
  }, [machineIndex]);
  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);
  useEffect(() => {
    onUpdateSnapshotRef.current = onUpdateSnapshot;
  }, [onUpdateSnapshot]);
  useEffect(() => {
    onPrizeWonRef.current = onPrizeWon;
  }, [onPrizeWon]);

  useEffect(() => {
    const drr = new Audio('/assets/drr.mp3');
    drr.preload = 'auto';
    drr.volume = 0.85;
    drrAudioRef.current = drr;

    const bc = new Audio('/assets/bc.mp3');
    bc.preload = 'auto';
    bc.volume = 0.9;
    bcAudioRef.current = bc;

    return () => {
      if (drrTimeoutRef.current) clearTimeout(drrTimeoutRef.current);
      if (bcTimeoutRef.current) clearTimeout(bcTimeoutRef.current);
    };
  }, []);

  const setCranePhase = useCallback((next: CranePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const playTone = useCallback((freq: number, duration = 0.08, type: OscillatorType = 'triangle', gainVal = 0.08) => {
    if (!soundEnabledRef.current) return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtx();
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {}
  }, []);

  const triggerExtremeDrr = useCallback(() => {
    setShowExtremeDrr(true);
    if (drrTimeoutRef.current) clearTimeout(drrTimeoutRef.current);
    drrTimeoutRef.current = setTimeout(() => setShowExtremeDrr(false), 1000);
    if (soundEnabledRef.current && drrAudioRef.current) {
      try {
        drrAudioRef.current.currentTime = 0;
        drrAudioRef.current.play().catch(() => {});
      } catch {}
    }
  }, []);

  const triggerBalanceCatch = useCallback(() => {
    setShowBalanceCatch(true);
    if (bcTimeoutRef.current) clearTimeout(bcTimeoutRef.current);
    bcTimeoutRef.current = setTimeout(() => setShowBalanceCatch(false), 1500);
    if (soundEnabledRef.current && bcAudioRef.current) {
      try {
        bcAudioRef.current.currentTime = 0;
        bcAudioRef.current.play().catch(() => {});
      } catch {}
    }
  }, []);

  const fireWinConfetti = useCallback(() => {
    confetti({
      particleCount: 90,
      spread: 80,
      origin: { y: 0.6 },
      colors: ['#f59e0b', '#fbbf24', '#22d3ee', '#10b981', '#a855f7', '#fb7185'],
    });
  }, []);

  // 시뮬레이션 외부 제어 브릿지
  const simBridgeRef = useRef<{
    loadMachine: (idx: number, snap: MachineSnapshot) => void;
    resetClawHome: () => void;
    applyLiveTuning: (t: PhysicsTuning) => void;
    rebuildCurrentPrizeForTuning: () => void;
    startTurn: () => void;
    startDescending: () => void;
  } | null>(null);

  // Jolt + Three.js 메인 씬 초기화
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    let animId = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let handleResize: (() => void) | null = null;

    getJoltModule()
      .then((Jolt) => {
        if (disposed || !container) return;

        // ============================================================
        // 1. THREE.JS 씬 · 카메라 · 조명 · 아케이드 캐비닛
        // ============================================================
        const width = container.clientWidth || 720;
        const height = container.clientHeight || 460;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color('#060a16');
        scene.fog = new THREE.FogExp2('#060a16', 0.042);

        const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
        let viewportW = width;
        let viewportH = height;

        const getCameraPose = (view: CameraView, w: number, h: number, tiptoeDeg = 0) => {
          const aspect = Math.max(0.55, w / Math.max(1, h));
          const scale = aspect < 1.48 ? Math.min(1.95, 1.52 / aspect) : 1.0;
          const fov = aspect < 1.15 ? 48 : 42;
          if (view === 'top') {
            return {
              fov,
              pos: new THREE.Vector3(0, 5.45 * Math.max(1, scale * 0.88), 0.52),
              look: new THREE.Vector3(0, 0.72, 0),
            };
          }
          if (view === 'right') {
            return {
              fov,
              pos: new THREE.Vector3(4.55 * Math.max(1, scale * 0.85), 2.15 * (1 + (scale - 1) * 0.3), 0),
              look: new THREE.Vector3(0, 0.82, 0),
            };
          }
          const lookY = 0.76;
          const baseY = 3.25 * (1 + (scale - 1) * 0.62);
          const baseZ = 4.65 * scale;
          const clampedTiptoe = Math.max(0, Math.min(45, tiptoeDeg));
          if (clampedTiptoe <= 0) {
            return {
              fov,
              pos: new THREE.Vector3(0, baseY, baseZ),
              look: new THREE.Vector3(0, lookY, 0),
            };
          }
          const dy = baseY - lookY;
          const radius = Math.hypot(dy, baseZ);
          const baseElevRad = Math.atan2(dy, baseZ);
          const maxElevRad = (56.2 * Math.PI) / 180;
          const elevRad = baseElevRad + (clampedTiptoe / 45) * (maxElevRad - baseElevRad);
          return {
            fov,
            pos: new THREE.Vector3(0, lookY + radius * Math.sin(elevRad), radius * Math.cos(elevRad)),
            look: new THREE.Vector3(0, lookY, 0),
          };
        };

        const currentLookAt = new THREE.Vector3(0, 0.78, 0);
        const applyResponsiveCamera = (w: number, h: number, snap = false) => {
          viewportW = w;
          viewportH = h;
          const pose = getCameraPose(cameraViewRef.current, w, h, frontTiptoeDegRef.current);
          camera.aspect = Math.max(0.55, w / Math.max(1, h));
          camera.fov = pose.fov;
          if (snap) {
            camera.position.copy(pose.pos);
            currentLookAt.copy(pose.look);
            camera.lookAt(currentLookAt);
          }
          camera.updateProjectionMatrix();
        };
        applyResponsiveCamera(width, height, true);

        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.innerHTML = '';
        container.appendChild(renderer.domElement);

        // Lights
        scene.add(new THREE.AmbientLight('#cbd5e1', 0.9));
        const mainSpot = new THREE.SpotLight('#fffbeb', 45, 22, Math.PI / 3.1, 0.45, 1.2);
        mainSpot.position.set(0, 6.5, 2.2);
        mainSpot.castShadow = true;
        mainSpot.shadow.mapSize.set(1024, 1024);
        scene.add(mainSpot);

        const cyanLight = new THREE.PointLight('#22d3ee', 11, 12);
        cyanLight.position.set(-2.1, 2.5, 1.2);
        scene.add(cyanLight);

        const amberLight = new THREE.PointLight('#f59e0b', 11, 12);
        amberLight.position.set(2.1, 2.5, 1.2);
        scene.add(amberLight);

        const chuteLight = new THREE.PointLight('#10b981', 9, 9);
        chuteLight.position.set(0, -0.7, 0);
        scene.add(chuteLight);

        // Cabinet Visuals
        const cabinetGroup = new THREE.Group();
        scene.add(cabinetGroup);

        const chuteFloor = new THREE.Mesh(
          new THREE.BoxGeometry(4.0, 0.15, 3.2),
          new THREE.MeshStandardMaterial({
            color: '#064e3b',
            emissive: '#059669',
            emissiveIntensity: 0.35,
            roughness: 0.3,
            metalness: 0.4,
          })
        );
        chuteFloor.position.set(0, -1.55, 0);
        chuteFloor.receiveShadow = true;
        cabinetGroup.add(chuteFloor);

        const gridHelper = new THREE.GridHelper(3.8, 10, '#10b981', '#065f46');
        gridHelper.position.set(0, -1.46, 0);
        cabinetGroup.add(gridHelper);

        const pillarGeo = new THREE.CylinderGeometry(0.07, 0.07, 4.9, 16);
        const pillarMat = new THREE.MeshStandardMaterial({
          color: '#1e293b',
          emissive: '#38bdf8',
          emissiveIntensity: 0.35,
          metalness: 0.7,
          roughness: 0.2,
        });
        const pillarX = STAGE_PHYSICS.CABINET_HALF_X + 0.1;
        [
          [-pillarX, 0.9, -1.48],
          [pillarX, 0.9, -1.48],
          [-pillarX, 0.9, 1.48],
          [pillarX, 0.9, 1.48],
        ].forEach(([px, py, pz]) => {
          const p = new THREE.Mesh(pillarGeo, pillarMat);
          p.position.set(px, py, pz);
          cabinetGroup.add(p);
        });

        const frameBarMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.8, roughness: 0.25 });
        const railSideGeo = new THREE.BoxGeometry(0.12, 0.12, 3.1);
        [-pillarX, pillarX].forEach((rx) => {
          const r = new THREE.Mesh(railSideGeo, frameBarMat);
          r.position.set(rx, 3.25, 0);
          cabinetGroup.add(r);
        });

        const gantryBeam = new THREE.Mesh(
          new THREE.BoxGeometry(STAGE_PHYSICS.BAR_LENGTH + 0.2, 0.1, 0.14),
          new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.85, roughness: 0.2 })
        );
        gantryBeam.position.set(0, 3.25, STAGE_PHYSICS.CLAW_HOME_Z);
        scene.add(gantryBeam);

        const trolleyMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.16, 0.24),
          new THREE.MeshStandardMaterial({ color: '#38bdf8', metalness: 0.75, roughness: 0.2 })
        );
        trolleyMesh.position.set(STAGE_PHYSICS.CLAW_HOME_X, 3.25, STAGE_PHYSICS.CLAW_HOME_Z);
        scene.add(trolleyMesh);

        const acrylicMat = new THREE.MeshPhysicalMaterial({
          color: '#94a3b8',
          transparent: true,
          opacity: 0.11,
          roughness: 0.1,
          metalness: 0.1,
          side: THREE.DoubleSide,
        });
        const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(STAGE_PHYSICS.BAR_LENGTH + 0.16, 3.4), acrylicMat);
        backGlass.position.set(0, 0.8, -1.46);
        cabinetGroup.add(backGlass);

        [-(STAGE_PHYSICS.CABINET_HALF_X + 0.06), STAGE_PHYSICS.CABINET_HALF_X + 0.06].forEach((sx) => {
          const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.94, 3.4), acrylicMat);
          sideGlass.rotation.y = Math.PI / 2;
          sideGlass.position.set(sx, 0.8, 0);
          cabinetGroup.add(sideGlass);
        });

        const rampVisualGeo = new THREE.BoxGeometry(STAGE_PHYSICS.BAR_LENGTH, 0.05, 0.84);
        const rampVisualMat = new THREE.MeshPhysicalMaterial({
          color: '#38bdf8',
          transparent: true,
          opacity: 0.16,
          roughness: 0.2,
        });
        const frontRampMesh = new THREE.Mesh(rampVisualGeo, rampVisualMat);
        frontRampMesh.position.set(0, 1.24, 1.38);
        frontRampMesh.rotation.x = -0.72;
        cabinetGroup.add(frontRampMesh);

        const backRampMesh = new THREE.Mesh(rampVisualGeo, rampVisualMat);
        backRampMesh.position.set(0, 1.24, -1.38);
        backRampMesh.rotation.x = 0.72;
        cabinetGroup.add(backRampMesh);

        // 4 Parallel Bars + Physical Silicone Rings
        const barGeo = new THREE.CylinderGeometry(
          STAGE_PHYSICS.BAR_RADIUS,
          STAGE_PHYSICS.BAR_RADIUS,
          STAGE_PHYSICS.BAR_LENGTH,
          24
        );
        barGeo.rotateZ(Math.PI / 2);
        const barMatVisual = new THREE.MeshStandardMaterial({
          color: '#e2e8f0',
          metalness: 0.92,
          roughness: 0.14,
        });
        const ringGeo = new THREE.TorusGeometry(STAGE_PHYSICS.BAR_RADIUS + 0.009, 0.016, 10, 24);
        ringGeo.rotateY(Math.PI / 2);
        const redRingMat = new THREE.MeshStandardMaterial({
          color: '#f43f5e',
          emissive: '#e11d48',
          emissiveIntensity: 0.4,
          roughness: 0.55,
        });
        const blueRingMat = new THREE.MeshStandardMaterial({
          color: '#38bdf8',
          emissive: '#0284c7',
          emissiveIntensity: 0.35,
          roughness: 0.55,
        });

        const allBarSpecs = [
          { y: STAGE_PHYSICS.BAR_Y, z: -STAGE_PHYSICS.BAR_HALF_Z, isOuter: false },
          { y: STAGE_PHYSICS.BAR_Y, z: STAGE_PHYSICS.BAR_HALF_Z, isOuter: false },
          { y: STAGE_PHYSICS.OUTER_BAR_Y, z: -STAGE_PHYSICS.OUTER_BAR_HALF_Z, isOuter: true },
          { y: STAGE_PHYSICS.OUTER_BAR_Y, z: STAGE_PHYSICS.OUTER_BAR_HALF_Z, isOuter: true },
        ];
        const ringXPositions = [-1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5];

        allBarSpecs.forEach(({ y: by, z: bz, isOuter }) => {
          const barMesh = new THREE.Mesh(barGeo, barMatVisual);
          barMesh.position.set(0, by, bz);
          barMesh.castShadow = true;
          barMesh.receiveShadow = true;
          cabinetGroup.add(barMesh);

          for (const rx of ringXPositions) {
            const ring = new THREE.Mesh(ringGeo, isOuter ? blueRingMat : redRingMat);
            ring.position.set(rx, by, bz);
            cabinetGroup.add(ring);
          }
        });

        // UFO Head Visual Group (1:1 synced to Jolt Dynamic Head Body)
        const ufoHeadGroup = new THREE.Group();
        scene.add(ufoHeadGroup);

        const ufoTop = new THREE.Mesh(
          new THREE.CylinderGeometry(0.19, 0.30, 0.16, 24),
          new THREE.MeshStandardMaterial({
            color: '#0ea5e9',
            emissive: '#0284c7',
            emissiveIntensity: 0.5,
            metalness: 0.65,
            roughness: 0.22,
          })
        );
        ufoTop.position.set(0, 0.06, 0);
        ufoTop.castShadow = true;
        ufoHeadGroup.add(ufoTop);

        const ufoRing = new THREE.Mesh(
          new THREE.TorusGeometry(0.28, 0.03, 12, 24),
          new THREE.MeshStandardMaterial({
            color: '#fbbf24',
            emissive: '#f59e0b',
            emissiveIntensity: 0.65,
          })
        );
        ufoRing.rotation.x = Math.PI / 2;
        ufoRing.position.set(0, -0.01, 0);
        ufoHeadGroup.add(ufoRing);

        // Hinged Left & Right Claw Arm Visual Groups (1:1 synced to Jolt Dynamic Arm Bodies!)
        const debugWireMat = new THREE.MeshBasicMaterial({
          color: '#22c55e',
          wireframe: true,
          transparent: true,
          opacity: 0.75,
        });
        const debugMeshes: THREE.Object3D[] = [];

        const armMetalMat = new THREE.MeshStandardMaterial({
          color: '#e2e8f0',
          metalness: 0.88,
          roughness: 0.18,
        });
        const armTipMat = new THREE.MeshStandardMaterial({
          color: '#f97316',
          emissive: '#ea580c',
          emissiveIntensity: 0.3,
          roughness: 0.65,
        });
        const hingePinMat = new THREE.MeshStandardMaterial({
          color: '#fbbf24',
          metalness: 0.9,
          roughness: 0.2,
        });

        const buildArmVisual = (side: -1 | 1) => {
          const group = new THREE.Group();
          const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.12, 12), hingePinMat);
          pin.rotation.x = Math.PI / 2;
          group.add(pin);

          for (const seg of ARM_SEGMENTS) {
            const geo = new THREE.BoxGeometry(seg.half[0] * 2, seg.half[1] * 2, seg.half[2] * 2);
            const mesh = new THREE.Mesh(geo, seg.isTip ? armTipMat : armMetalMat);
            mesh.position.set(side * seg.pos[0], seg.pos[1], seg.pos[2]);
            mesh.rotation.z = side * seg.rotZ;
            mesh.castShadow = true;
            group.add(mesh);

            const wf = new THREE.Mesh(geo, debugWireMat);
            wf.position.copy(mesh.position);
            wf.rotation.copy(mesh.rotation);
            wf.visible = tuningRef.current.showColliders;
            group.add(wf);
            debugMeshes.push(wf);
          }
          scene.add(group);
          return group;
        };

        const leftArmVisual = buildArmVisual(-1);
        const rightArmVisual = buildArmVisual(1);

        // Dynamic steel wire cable connecting gantry trolley to UFO head
        const cableMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.02, 1, 8),
          new THREE.MeshStandardMaterial({ color: '#94a3b8', metalness: 0.85 })
        );
        scene.add(cableMesh);

        // Aiming laser ring & beam
        const aimRing = new THREE.Mesh(
          new THREE.RingGeometry(0.14, 0.21, 24),
          new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.8, side: THREE.DoubleSide })
        );
        aimRing.rotation.x = -Math.PI / 2;
        scene.add(aimRing);

        const aimBeam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.01, 0.01, 1.7, 8),
          new THREE.MeshBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.28 })
        );
        scene.add(aimBeam);

        // ============================================================
        // 2. JOLT PHYSICS 1.1.2 WASM WORLD SETUP (5 LAYERS, 120Hz)
        // ============================================================
        const LAYER_ENV = 0; // 벽, 경사 가이드, 슈트 바닥
        const LAYER_BAR = 1; // 4개 브릿지 바 + 실리콘 링
        const LAYER_PRIZE = 2; // 상품 박스 / 쿠션 인형
        const LAYER_HEAD = 3; // 갠트리 + UFO 헤드
        const LAYER_ARM = 4; // 좌/우 관절 집게 암

        const objFilter = new Jolt.ObjectLayerPairFilterTable(5);
        objFilter.EnableCollision(LAYER_PRIZE, LAYER_ENV);
        objFilter.EnableCollision(LAYER_PRIZE, LAYER_BAR);
        objFilter.EnableCollision(LAYER_PRIZE, LAYER_PRIZE);
        objFilter.EnableCollision(LAYER_PRIZE, LAYER_HEAD);
        objFilter.EnableCollision(LAYER_PRIZE, LAYER_ARM);

        const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(5, 2);
        const bpStatic = new Jolt.BroadPhaseLayer(0);
        const bpMoving = new Jolt.BroadPhaseLayer(1);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_ENV, bpStatic);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_BAR, bpStatic);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_PRIZE, bpMoving);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_HEAD, bpMoving);
        bpInterface.MapObjectToBroadPhaseLayer(LAYER_ARM, bpMoving);

        const objVsBp = new Jolt.ObjectVsBroadPhaseLayerFilterTable(bpInterface, 2, objFilter, 5);
        const joltSettings = new Jolt.JoltSettings();
        joltSettings.mObjectLayerPairFilter = objFilter;
        joltSettings.mBroadPhaseLayerInterface = bpInterface;
        joltSettings.mObjectVsBroadPhaseLayerFilter = objVsBp;

        const jolt = new Jolt.JoltInterface(joltSettings);
        const ps = jolt.GetPhysicsSystem();
        ps.SetGravity(new Jolt.Vec3(0, -9.81, 0));
        const bi = ps.GetBodyInterface();

        // 정적 물리 바디: 4개 평행 금속 Bar + 물리 실리콘 링 (금속 0.26 vs 실리콘 링 0.76 마찰 분리!)
        const qBar = Jolt.Quat.prototype.sRotation(new Jolt.Vec3(0, 0, 1), Math.PI / 2);
        const ringBodyIds: JoltNS.BodyID[] = [];
        allBarSpecs.forEach(({ y: by, z: bz, isOuter }) => {
          const barShape = new Jolt.CylinderShape(STAGE_PHYSICS.BAR_LENGTH / 2, STAGE_PHYSICS.BAR_RADIUS, 0.02);
          const bcs = new Jolt.BodyCreationSettings(
            barShape,
            new Jolt.RVec3(0, by, bz),
            qBar,
            Jolt.EMotionType_Static,
            LAYER_BAR
          );
          bcs.mFriction = isOuter ? 0.34 : 0.28; // 매끄러운 크롬 금속 바 구간
          bcs.mRestitution = 0.0;
          const barBody = bi.CreateBody(bcs);
          bi.AddBody(barBody.GetID(), Jolt.EActivation_DontActivate);

          // 실제 고마찰 실리콘 링 콜라이더 (미세하게 돌출된 실리콘 링으로 실제 오락실 걸림 감각 구현)
          for (const rx of ringXPositions) {
            const ringShape = new Jolt.CylinderShape(0.022, STAGE_PHYSICS.BAR_RADIUS + 0.006, 0.008);
            const rbcs = new Jolt.BodyCreationSettings(
              ringShape,
              new Jolt.RVec3(rx, by, bz),
              qBar,
              Jolt.EMotionType_Static,
              LAYER_BAR
            );
            rbcs.mFriction = isOuter ? 0.55 : tuningRef.current.barRingFriction;
            rbcs.mRestitution = 0.0;
            const rb = bi.CreateBody(rbcs);
            bi.AddBody(rb.GetID(), Jolt.EActivation_DontActivate);
            if (!isOuter) ringBodyIds.push(rb.GetID());
          }
        });

        // 좌우 아크릴 벽
        [-STAGE_PHYSICS.CABINET_HALF_X - 0.1, STAGE_PHYSICS.CABINET_HALF_X + 0.1].forEach((wx) => {
          const wallBCS = new Jolt.BodyCreationSettings(
            new Jolt.BoxShape(new Jolt.Vec3(0.1, 2.2, 2.0), 0.02),
            new Jolt.RVec3(wx, 1.0, 0),
            Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Static,
            LAYER_ENV
          );
          wallBCS.mFriction = 0.25;
          wallBCS.mRestitution = 0.0;
          bi.AddBody(bi.CreateBody(wallBCS).GetID(), Jolt.EActivation_DontActivate);
        });

        // 앞/뒤 경사 가이드 (박스가 외곽으로 이탈하지 않고 중앙 Bar 쪽으로 미끄러지도록 유도)
        const frontRampBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(STAGE_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
          new Jolt.RVec3(0, 1.24, 1.38),
          Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), -0.72),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        frontRampBCS.mFriction = 0.22;
        frontRampBCS.mRestitution = 0.0;
        bi.AddBody(bi.CreateBody(frontRampBCS).GetID(), Jolt.EActivation_DontActivate);

        const backRampBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(STAGE_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
          new Jolt.RVec3(0, 1.24, -1.38),
          Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), 0.72),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        backRampBCS.mFriction = 0.22;
        backRampBCS.mRestitution = 0.0;
        bi.AddBody(bi.CreateBody(backRampBCS).GetID(), Jolt.EActivation_DontActivate);

        // 하단 WIN 슈트 바닥
        const floorBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(2.2, 0.1, 2.0), 0.02),
          new Jolt.RVec3(0, -1.55, 0),
          Jolt.Quat.prototype.sIdentity(),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        floorBCS.mFriction = 0.55;
        floorBCS.mRestitution = 0.05;
        bi.AddBody(bi.CreateBody(floorBCS).GetID(), Jolt.EActivation_DontActivate);

        // ============================================================
        // 3. 진짜 관절 물리 UFO 크레인 (Gantry ↔ SixDOF ↔ Head ↔ 2× Hinge ↔ 2× Claw Arm)
        // ============================================================
        const homeX = STAGE_PHYSICS.CLAW_HOME_X;
        const homeY = STAGE_PHYSICS.CLAW_HOME_Y;
        const homeZ = STAGE_PHYSICS.CLAW_HOME_Z;

        const gantryBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(0.1, 0.05, 0.1), 0.01),
          new Jolt.RVec3(homeX, homeY, homeZ),
          Jolt.Quat.prototype.sIdentity(),
          Jolt.EMotionType_Kinematic,
          LAYER_HEAD
        );
        const gantryBody = bi.CreateBody(gantryBCS);
        bi.AddBody(gantryBody.GetID(), Jolt.EActivation_Activate);

        const headBCS = new Jolt.BodyCreationSettings(
          new Jolt.CylinderShape(0.08, 0.23, 0.02),
          new Jolt.RVec3(homeX, homeY, homeZ),
          Jolt.Quat.prototype.sIdentity(),
          Jolt.EMotionType_Dynamic,
          LAYER_HEAD
        );
        headBCS.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
        headBCS.mMassPropertiesOverride.mMass = 1.25;
        headBCS.mFriction = 0.55;
        headBCS.mRestitution = 0.0;
        headBCS.mLinearDamping = 0.45;
        headBCS.mAngularDamping = 0.72;
        headBCS.mMotionQuality = Jolt.EMotionQuality_LinearCast;
        headBCS.mAllowSleeping = false;
        const headBody = bi.CreateBody(headBCS);
        bi.AddBody(headBody.GetID(), Jolt.EActivation_Activate);

        // SixDOF 케이블 서스펜션 + 하강/승강 모터
        const sixSettings = new Jolt.SixDOFConstraintSettings();
        sixSettings.mSpace = Jolt.EConstraintSpace_WorldSpace;
        sixSettings.mPosition1 = new Jolt.RVec3(homeX, homeY, homeZ);
        sixSettings.mPosition2 = new Jolt.RVec3(homeX, homeY, homeZ);
        sixSettings.SetLimitedAxis(Jolt.SixDOFConstraintSettings_EAxis_TranslationX, -0.22, 0.22);
        sixSettings.SetLimitedAxis(Jolt.SixDOFConstraintSettings_EAxis_TranslationY, -1.95, 0.18);
        sixSettings.SetLimitedAxis(Jolt.SixDOFConstraintSettings_EAxis_TranslationZ, -0.22, 0.22);
        sixSettings.SetLimitedAxis(Jolt.SixDOFConstraintSettings_EAxis_RotationX, -0.26, 0.26);
        sixSettings.MakeFixedAxis(Jolt.SixDOFConstraintSettings_EAxis_RotationY);
        sixSettings.SetLimitedAxis(Jolt.SixDOFConstraintSettings_EAxis_RotationZ, -0.34, 0.34);
        const sixConstraint = Jolt.castObject(sixSettings.Create(gantryBody, headBody), Jolt.SixDOFConstraint);
        ps.AddConstraint(sixConstraint);

        for (const ax of [
          Jolt.SixDOFConstraintSettings_EAxis_TranslationX,
          Jolt.SixDOFConstraintSettings_EAxis_TranslationZ,
        ]) {
          const m = sixConstraint.GetMotorSettings(ax);
          m.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
          m.mSpringSettings.mFrequency = 9.5;
          m.mSpringSettings.mDamping = 0.84;
          m.mMinForceLimit = -120;
          m.mMaxForceLimit = 120;
          sixConstraint.SetMotorState(ax, Jolt.EMotorState_Position);
        }
        const motorY = sixConstraint.GetMotorSettings(Jolt.SixDOFConstraintSettings_EAxis_TranslationY);
        motorY.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
        motorY.mSpringSettings.mFrequency = 16;
        motorY.mSpringSettings.mDamping = 0.98;
        motorY.mMinForceLimit = -tuningRef.current.downPressForce;
        motorY.mMaxForceLimit = 210;
        sixConstraint.SetMotorState(Jolt.SixDOFConstraintSettings_EAxis_TranslationY, Jolt.EMotorState_Position);

        for (const ax of [
          Jolt.SixDOFConstraintSettings_EAxis_RotationX,
          Jolt.SixDOFConstraintSettings_EAxis_RotationZ,
        ]) {
          const m = sixConstraint.GetMotorSettings(ax);
          m.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
          m.mSpringSettings.mFrequency = 5.5;
          m.mSpringSettings.mDamping = 0.82;
          m.mMinTorqueLimit = -18;
          m.mMaxTorqueLimit = 18;
          sixConstraint.SetMotorState(ax, Jolt.EMotorState_Position);
        }

        // 좌/우 동적 집게 암 + HingeConstraint 토크 제한 모터
        const createClawArm = (side: -1 | 1) => {
          const comp = new Jolt.StaticCompoundShapeSettings();
          for (const seg of ARM_SEGMENTS) {
            comp.AddShape(
              new Jolt.Vec3(side * seg.pos[0], seg.pos[1], seg.pos[2]),
              Jolt.Quat.prototype.sRotation(new Jolt.Vec3(0, 0, 1), side * seg.rotZ),
              new Jolt.BoxShapeSettings(new Jolt.Vec3(seg.half[0], seg.half[1], seg.half[2]), 0.008),
              0
            );
          }
          const shapeRes = comp.Create();
          const pivotX = homeX + side * 0.22;
          const pivotY = homeY - 0.02;
          const abcs = new Jolt.BodyCreationSettings(
            shapeRes.Get(),
            new Jolt.RVec3(pivotX, pivotY, homeZ),
            Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Dynamic,
            LAYER_ARM
          );
          abcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
          abcs.mMassPropertiesOverride.mMass = 0.30;
          abcs.mFriction = tuningRef.current.clawTipFriction;
          abcs.mRestitution = 0.0;
          abcs.mLinearDamping = 0.22;
          abcs.mAngularDamping = 0.35;
          abcs.mMotionQuality = Jolt.EMotionQuality_LinearCast;
          abcs.mAllowSleeping = false;
          const armBody = bi.CreateBody(abcs);
          bi.AddBody(armBody.GetID(), Jolt.EActivation_Activate);

          const hs = new Jolt.HingeConstraintSettings();
          hs.mSpace = Jolt.EConstraintSpace_WorldSpace;
          hs.mPoint1 = new Jolt.RVec3(pivotX, pivotY, homeZ);
          hs.mPoint2 = new Jolt.RVec3(pivotX, pivotY, homeZ);
          hs.mHingeAxis1 = new Jolt.Vec3(0, 0, 1);
          hs.mHingeAxis2 = new Jolt.Vec3(0, 0, 1);
          hs.mNormalAxis1 = new Jolt.Vec3(1, 0, 0);
          hs.mNormalAxis2 = new Jolt.Vec3(1, 0, 0);
          hs.mLimitsMin = side > 0 ? -0.10 : -1.18;
          hs.mLimitsMax = side > 0 ? 1.18 : 0.10;
          const hc = Jolt.castObject(hs.Create(headBody, armBody), Jolt.HingeConstraint);
          ps.AddConstraint(hc);

          const hm = hc.GetMotorSettings();
          hm.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
          hm.mSpringSettings.mFrequency = 11;
          hm.mSpringSettings.mDamping = 0.92;
          hm.mMinTorqueLimit = -tuningRef.current.closeTorque;
          hm.mMaxTorqueLimit = tuningRef.current.closeTorque;
          hc.SetMotorState(Jolt.EMotorState_Position);
          hc.SetTargetAngle(side * CLAW_OPEN_ANGLE);

          return { body: armBody, hinge: hc };
        };

        const leftArm = createClawArm(-1);
        const rightArm = createClawArm(1);

        // ============================================================
        // 4. 동적 상품(박스 5종 + 산드로네 3D 쿠션 인형) 생성/교체 관리
        // ============================================================
        let activePrizeBody: JoltNS.Body | null = null;
        let activePrizeMesh: THREE.Mesh | null = null;
        let activePrizeDebugGroup: THREE.Group | null = null;
        let activePrizeSpec: PrizeSpec = PRIZE_SPECS[machineIndexRef.current];
        let activePrizeIsInitial = true;

        const destroyCurrentPrize = () => {
          if (activePrizeBody) {
            bi.RemoveBody(activePrizeBody.GetID());
            bi.DestroyBody(activePrizeBody.GetID());
            activePrizeBody = null;
          }
          if (activePrizeMesh) {
            scene.remove(activePrizeMesh);
            activePrizeMesh.geometry.dispose();
            if (Array.isArray(activePrizeMesh.material)) {
              activePrizeMesh.material.forEach((m) => m.dispose());
            } else {
              activePrizeMesh.material.dispose();
            }
            activePrizeMesh = null;
          }
          if (activePrizeDebugGroup) {
            scene.remove(activePrizeDebugGroup);
            activePrizeDebugGroup = null;
          }
        };

        const spawnPrizeFromSnapshot = (idx: number, snap: MachineSnapshot) => {
          destroyCurrentPrize();
          const spec = PRIZE_SPECS[idx] || PRIZE_SPECS[0];
          activePrizeSpec = spec;
          activePrizeIsInitial = snap.isInitialState;
          if (!snap.hasStock) return;

          const t = tuningRef.current;
          const debugGrp = new THREE.Group();
          debugGrp.visible = t.showColliders;
          scene.add(debugGrp);
          activePrizeDebugGroup = debugGrp;

          let shapeRef: JoltNS.Shape;

          if (spec.isPlush) {
            const plushMat = createPlushMaterial(spec.imgSrc);
            const initGeo = cachedSandroneGeoData
              ? buildBufferGeometryFromPlushData(cachedSandroneGeoData)
              : new THREE.BoxGeometry(spec.w * 0.7, spec.h, spec.d * 0.85);
            const mesh = new THREE.Mesh(initGeo, plushMat);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
            activePrizeMesh = mesh;

            if (!cachedSandroneGeoData) {
              loadSandronePlushGeoData().then((geoData) => {
                if (!geoData || disposed || activePrizeMesh !== mesh) return;
                const nextGeo = buildBufferGeometryFromPlushData(geoData);
                mesh.geometry.dispose();
                mesh.geometry = nextGeo;
              });
            }

            // 산드로네 다이컷 쿠션 인형 4파츠 복합 Jolt 콜라이더
            const parts = [
              { half: [0.28, 0.21, 0.50], pos: [0.05, 0, 0.02] },
              { half: [0.19, 0.18, 0.20], pos: [0.04, 0, -0.44] },
              { half: [0.15, 0.16, 0.30], pos: [-0.30, 0, 0.24] },
              { half: [0.14, 0.17, 0.28], pos: [0.30, 0, 0.22] },
            ];
            const comp = new Jolt.StaticCompoundShapeSettings();
            for (const p of parts) {
              comp.AddShape(
                new Jolt.Vec3(p.pos[0], p.pos[1], p.pos[2]),
                Jolt.Quat.prototype.sIdentity(),
                new Jolt.BoxShapeSettings(new Jolt.Vec3(p.half[0], p.half[1], p.half[2]), 0.02),
                0
              );
              const wf = new THREE.Mesh(
                new THREE.BoxGeometry(p.half[0] * 2, p.half[1] * 2, p.half[2] * 2),
                debugWireMat
              );
              wf.position.set(p.pos[0], p.pos[1], p.pos[2]);
              debugGrp.add(wf);
            }
            if (t.useComOffset) {
              const comWrap = new Jolt.OffsetCenterOfMassShapeSettings(
                new Jolt.Vec3(spec.comOffset[0], spec.comOffset[1], spec.comOffset[2]),
                comp
              );
              shapeRef = comWrap.Create().Get();
            } else {
              shapeRef = comp.Create().Get();
            }
          } else {
            const mats = createFigureBoxMaterials(spec);
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.h, spec.d), mats);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            scene.add(mesh);
            activePrizeMesh = mesh;

            const wf = new THREE.Mesh(new THREE.BoxGeometry(spec.w, spec.h, spec.d), debugWireMat);
            debugGrp.add(wf);

            const boxShapeSettings = new Jolt.BoxShapeSettings(
              new Jolt.Vec3(spec.w / 2, spec.h / 2, spec.d / 2),
              0.015
            );
            if (t.useComOffset) {
              const comWrap = new Jolt.OffsetCenterOfMassShapeSettings(
                new Jolt.Vec3(spec.comOffset[0], spec.comOffset[1], spec.comOffset[2]),
                boxShapeSettings
              );
              shapeRef = comWrap.Create().Get();
            } else {
              shapeRef = boxShapeSettings.Create().Get();
            }
          }

          const bcs = new Jolt.BodyCreationSettings(
            shapeRef,
            new Jolt.RVec3(snap.position[0], snap.position[1], snap.position[2]),
            new Jolt.Quat(snap.quaternion[0], snap.quaternion[1], snap.quaternion[2], snap.quaternion[3]),
            Jolt.EMotionType_Dynamic,
            LAYER_PRIZE
          );
          bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
          bcs.mMassPropertiesOverride.mMass = Math.max(0.4, spec.mass * t.massScale);
          bcs.mFriction = spec.friction;
          bcs.mRestitution = 0.0;
          bcs.mLinearDamping = 0.18;
          bcs.mAngularDamping = 0.28;
          bcs.mMotionQuality = Jolt.EMotionQuality_LinearCast;
          bcs.mAllowSleeping = true;
          const body = bi.CreateBody(bcs);
          bi.AddBody(body.GetID(), Jolt.EActivation_Activate);
          activePrizeBody = body;

          if (activePrizeMesh) {
            activePrizeMesh.position.set(snap.position[0], snap.position[1], snap.position[2]);
            activePrizeMesh.quaternion.set(
              snap.quaternion[0],
              snap.quaternion[1],
              snap.quaternion[2],
              snap.quaternion[3]
            );
          }
          debugGrp.position.set(snap.position[0], snap.position[1], snap.position[2]);
          debugGrp.quaternion.set(
            snap.quaternion[0],
            snap.quaternion[1],
            snap.quaternion[2],
            snap.quaternion[3]
          );
        };

        // 재사용 Scratch 벡터/쿼터니언 (GC/WASM 힙 누수 방지)
        const tmpRVec = new Jolt.RVec3(0, 0, 0);
        const tmpVec = new Jolt.Vec3(0, 0, 0);
        const tmpZeroVec = new Jolt.Vec3(0, 0, 0);
        const tmpIdQuat = Jolt.Quat.prototype.sIdentity();
        const tmpThreePosA = new THREE.Vector3();
        const tmpThreePosB = new THREE.Vector3();
        const tmpThreeDir = new THREE.Vector3();
        const tmpThreeUp = new THREE.Vector3(0, 1, 0);
        const tmpThreeQuat = new THREE.Quaternion();

        // 시뮬레이션 상태 머신
        const sim = {
          gantryX: homeX,
          gantryZ: homeZ,
          targetHeadY: homeY,
          phaseTimer: 0,
          settleQuietTime: 0,
          wonThisTurn: false,
          turnStartedInitial: true,
          turnStartPrizePos: [0, 1.1, 0] as [number, number, number],
          turnStartPrizeQuat: [0, 0, 0, 1] as [number, number, number, number],
          liftStartPrizeY: 1.1,
          effectTriggeredThisTurn: false,
          lastHeadYForStall: homeY,
          descendStallTimer: 0,
          telemetryAccum: 0,
        };

        const setArmTorques = (maxTorque: number) => {
          const lm = leftArm.hinge.GetMotorSettings();
          lm.mMinTorqueLimit = -maxTorque;
          lm.mMaxTorqueLimit = maxTorque;
          const rm = rightArm.hinge.GetMotorSettings();
          rm.mMinTorqueLimit = -maxTorque;
          rm.mMaxTorqueLimit = maxTorque;
        };

        const setArmTargets = (openRad: number) => {
          leftArm.hinge.SetTargetAngle(-openRad);
          rightArm.hinge.SetTargetAngle(openRad);
        };

        const resetClawHome = () => {
          sim.gantryX = homeX;
          sim.gantryZ = homeZ;
          sim.targetHeadY = homeY;
          sim.phaseTimer = 0;
          sim.settleQuietTime = 0;
          sim.wonThisTurn = false;
          sim.effectTriggeredThisTurn = false;
          sim.descendStallTimer = 0;

          tmpRVec.Set(homeX, homeY, homeZ);
          bi.SetPositionAndRotation(gantryBody.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetPositionAndRotation(headBody.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(headBody.GetID(), tmpZeroVec, tmpZeroVec);

          tmpRVec.Set(homeX - 0.22, homeY - 0.02, homeZ);
          bi.SetPositionAndRotation(leftArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(leftArm.body.GetID(), tmpZeroVec, tmpZeroVec);

          tmpRVec.Set(homeX + 0.22, homeY - 0.02, homeZ);
          bi.SetPositionAndRotation(rightArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(rightArm.body.GetID(), tmpZeroVec, tmpZeroVec);

          tmpVec.Set(0, 0, 0);
          sixConstraint.SetTargetPositionCS(tmpVec);
          setArmTorques(tuningRef.current.closeTorque);
          setArmTargets(CLAW_OPEN_ANGLE);
        };

        const applyLiveTuning = (t: PhysicsTuning) => {
          motorY.mMinForceLimit = -t.downPressForce;
          bi.SetFriction(leftArm.body.GetID(), t.clawTipFriction);
          bi.SetFriction(rightArm.body.GetID(), t.clawTipFriction);
          for (const rid of ringBodyIds) {
            bi.SetFriction(rid, t.barRingFriction);
          }
          for (const dm of debugMeshes) {
            dm.visible = t.showColliders;
          }
          if (activePrizeDebugGroup) {
            activePrizeDebugGroup.visible = t.showColliders;
          }
        };

        const finishTurn = () => {
          const idx = machineIndexRef.current;
          const prevSnap = snapshotsRef.current[idx];
          let nextSnap: MachineSnapshot;

          if (sim.wonThisTurn || !activePrizeBody) {
            destroyCurrentPrize();
            nextSnap = {
              hasStock: false,
              position: getRestingPosition(activePrizeSpec),
              quaternion: [0, 0, 0, 1],
              isInitialState: false,
              plays: (prevSnap?.plays || 0) + 1,
              wins: (prevSnap?.wins || 0) + (sim.wonThisTurn ? 1 : 0),
            };
          } else {
            const bp = activePrizeBody.GetPosition();
            const bq = activePrizeBody.GetRotation();
            const px = bp.GetX();
            const py = bp.GetY();
            const pz = bp.GetZ();
            const qx = bq.GetX();
            const qy = bq.GetY();
            const qz = bq.GetZ();
            const qw = bq.GetW();

            const movedHoriz =
              Math.hypot(px - sim.turnStartPrizePos[0], pz - sim.turnStartPrizePos[2]) > 0.025 ||
              Math.abs(py - sim.turnStartPrizePos[1]) > 0.035;
            const quatDot = Math.abs(
              qx * sim.turnStartPrizeQuat[0] +
                qy * sim.turnStartPrizeQuat[1] +
                qz * sim.turnStartPrizeQuat[2] +
                qw * sim.turnStartPrizeQuat[3]
            );
            const stillInitial = sim.turnStartedInitial && !movedHoriz && quatDot >= 0.999;
            activePrizeIsInitial = stillInitial;

            nextSnap = {
              hasStock: true,
              position: [px, py, pz],
              quaternion: [qx, qy, qz, qw],
              isInitialState: stillInitial,
              plays: (prevSnap?.plays || 0) + 1,
              wins: prevSnap?.wins || 0,
            };
          }

          setCranePhase('idle');
          onUpdateSnapshotRef.current(idx, nextSnap);
        };

        const startTurn = () => {
          if (phaseRef.current !== 'idle' || !activePrizeBody) return;
          setCameraView('front');
          cameraViewRef.current = 'front';
          setDroppedThisTurn(false);
          resetClawHome();

          const bp = activePrizeBody.GetPosition();
          const bq = activePrizeBody.GetRotation();
          sim.turnStartedInitial = activePrizeIsInitial;
          sim.turnStartPrizePos = [bp.GetX(), bp.GetY(), bp.GetZ()];
          sim.turnStartPrizeQuat = [bq.GetX(), bq.GetY(), bq.GetZ(), bq.GetW()];

          setCranePhase('ready_right');
          playTone(523.25, 0.12, 'sine', 0.1);
        };

        const startDescending = () => {
          sim.phaseTimer = 0;
          sim.descendStallTimer = 0;
          sim.lastHeadYForStall = headBody.GetPosition().GetY();
          // 하강 중에는 집게 힌지 토크를 유연하게 낮춰, 한쪽이 상자에 걸려도 부드럽게 휘어지며 크레인이 끝까지 하강!
          setArmTorques(tuningRef.current.descendFlexTorque);
          setArmTargets(CLAW_OPEN_ANGLE);
          motorY.mMinForceLimit = -tuningRef.current.downPressForce;
          setCranePhase('descending');
          playTone(640, 0.12);
        };

        simBridgeRef.current = {
          loadMachine: (idx, snap) => {
            resetClawHome();
            spawnPrizeFromSnapshot(idx, snap);
            setDroppedThisTurn(false);
            setCranePhase('idle');
          },
          resetClawHome,
          applyLiveTuning,
          rebuildCurrentPrizeForTuning: () => {
            if (!activePrizeBody || phaseRef.current !== 'idle') return;
            const bp = activePrizeBody.GetPosition();
            const bq = activePrizeBody.GetRotation();
            spawnPrizeFromSnapshot(machineIndexRef.current, {
              hasStock: true,
              position: [bp.GetX(), bp.GetY(), bp.GetZ()],
              quaternion: [bq.GetX(), bq.GetY(), bq.GetZ(), bq.GetW()],
              isInitialState: activePrizeIsInitial,
              plays: snapshotsRef.current[machineIndexRef.current]?.plays || 0,
              wins: snapshotsRef.current[machineIndexRef.current]?.wins || 0,
            });
          },
          startTurn,
          startDescending,
        };

        // 초기 상품 스폰
        spawnPrizeFromSnapshot(
          machineIndexRef.current,
          snapshotsRef.current[machineIndexRef.current]
        );
        setEngineReady(true);

        // ============================================================
        // 5. MAIN 60FPS RENDER + 120Hz JOLT PHYSICS LOOP
        // ============================================================
        let lastTime = performance.now();

        const animate = (now: number) => {
          if (disposed) return;
          animId = requestAnimationFrame(animate);
          const rawDt = Math.min((now - lastTime) / 1000, 0.04);
          lastTime = now;
          const dt = rawDt * Math.max(0.25, Math.min(1.5, tuningRef.current.timeScale));

          const curPhase = phaseRef.current;

          if (curPhase === 'moving_right') {
            sim.gantryX = Math.min(STAGE_PHYSICS.CLAW_MAX_X, sim.gantryX + STAGE_PHYSICS.MOVE_SPEED_X * dt);
            if (sim.gantryX >= STAGE_PHYSICS.CLAW_MAX_X) {
              setCranePhase('ready_up');
              playTone(620, 0.08);
            }
          } else if (curPhase === 'moving_up') {
            sim.gantryZ = Math.max(STAGE_PHYSICS.CLAW_MIN_Z, sim.gantryZ - STAGE_PHYSICS.MOVE_SPEED_Z * dt);
            if (sim.gantryZ <= STAGE_PHYSICS.CLAW_MIN_Z) {
              startDescending();
            }
          } else if (curPhase === 'descending') {
            sim.phaseTimer += dt;
            sim.targetHeadY = Math.max(
              STAGE_PHYSICS.CLAW_DROP_Y,
              sim.targetHeadY - STAGE_PHYSICS.CLAW_DESCEND_SPEED * dt
            );

            // UFO 본체 자체가 상자 위에 닿아 물리적으로 더 이상 못 내려가는 경우(0.45초 정체) 자연스럽게 닫힘 전환
            const actualHeadY = headBody.GetPosition().GetY();
            if (actualHeadY - sim.targetHeadY > 0.14 && Math.abs(actualHeadY - sim.lastHeadYForStall) < 0.015) {
              sim.descendStallTimer += dt;
            } else {
              sim.descendStallTimer = 0;
              sim.lastHeadYForStall = actualHeadY;
            }

            if (sim.targetHeadY <= STAGE_PHYSICS.CLAW_DROP_Y || sim.descendStallTimer >= 0.45) {
              sim.phaseTimer = 0;
              // 닫힘 단계: 실제 집게 닫힘 토크 가동!
              setArmTorques(tuningRef.current.closeTorque);
              setCranePhase('closing');
              playTone(330, 0.1, 'square', 0.05);
            }
          } else if (curPhase === 'closing') {
            sim.phaseTimer += dt;
            const prog = Math.min(1, sim.phaseTimer / 0.52);
            const targetAng = CLAW_OPEN_ANGLE * (1 - prog) + CLAW_CLOSE_TARGET * prog;
            setArmTargets(targetAng);

            if (sim.phaseTimer >= 0.62) {
              sim.phaseTimer = 0;
              sim.effectTriggeredThisTurn = false;
              sim.liftStartPrizeY = activePrizeBody ? activePrizeBody.GetPosition().GetY() : 1.0;
              // 들어올림 단계: 실제 아케이드 2단계 파워(리프트 토크) 적용!
              setArmTorques(tuningRef.current.liftTorque);
              setArmTargets(CLAW_CLOSE_TARGET);
              setCranePhase('lifting');
              playTone(587.33, 0.12);
            }
          } else if (curPhase === 'lifting') {
            sim.phaseTimer += dt;
            sim.targetHeadY = Math.min(
              STAGE_PHYSICS.CLAW_LIFT_Y,
              sim.targetHeadY + STAGE_PHYSICS.CLAW_LIFT_SPEED * dt
            );

            // 실제 물리적으로 상품이 들어올려졌을 때 특수 연출 판정 (Balance Catch! / 극한 드르륵!)
            if (activePrizeBody && !sim.effectTriggeredThisTurn && !sim.wonThisTurn && sim.phaseTimer >= 0.12) {
              const curPrizeY = activePrizeBody.GetPosition().GetY();
              const curPrizeVelY = activePrizeBody.GetLinearVelocity().GetY();
              const liftedDelta = curPrizeY - sim.liftStartPrizeY;
              const isPhysicallyLifting = liftedDelta >= 0.065 && curPrizeVelY > 0.05;

              if (isPhysicallyLifting) {
                const headPos = headBody.GetPosition();
                if (sim.turnStartedInitial) {
                  // 1) 초기 재정렬 원위치 상태: 상품 정중앙 근처 리프트 -> Balance Catch! (극한 드르륵 미발동!)
                  const centerDx = Math.abs(headPos.GetX() - sim.turnStartPrizePos[0]);
                  const centerDz = Math.abs(headPos.GetZ() - sim.turnStartPrizePos[2]);
                  const maxCenterDx = Math.max(0.20, activePrizeSpec.w * 0.30);
                  const maxCenterDz = Math.min(0.24, Math.max(0.20, activePrizeSpec.d * 0.16));
                  if (centerDx <= maxCenterDx && centerDz <= maxCenterDz) {
                    sim.effectTriggeredThisTurn = true;
                    triggerBalanceCatch();
                  }
                } else {
                  // 2) 초기 상태 이후: 중앙 빨간 Bar(z = ±0.455, 위/아래 포함) 근처 리프트 -> 극한 드르륵!
                  const hz = headPos.GetZ();
                  const nearCentralRedBar =
                    Math.abs(hz - STAGE_PHYSICS.BAR_HALF_Z) <= 0.28 ||
                    Math.abs(hz + STAGE_PHYSICS.BAR_HALF_Z) <= 0.28;
                  if (nearCentralRedBar) {
                    sim.effectTriggeredThisTurn = true;
                    triggerExtremeDrr();
                  }
                }
              }
            }

            if (sim.targetHeadY >= STAGE_PHYSICS.CLAW_LIFT_Y || sim.phaseTimer >= 1.35) {
              sim.phaseTimer = 0;
              setArmTorques(tuningRef.current.closeTorque);
              setArmTargets(CLAW_OPEN_ANGLE);
              setCranePhase('releasing');
              playTone(392, 0.1);
            }
          } else if (curPhase === 'releasing') {
            sim.phaseTimer += dt;
            setArmTargets(CLAW_OPEN_ANGLE);
            sim.gantryX += (homeX - sim.gantryX) * Math.min(1, 3.6 * dt);
            sim.gantryZ += (homeZ - sim.gantryZ) * Math.min(1, 3.6 * dt);
            sim.targetHeadY += (homeY - sim.targetHeadY) * Math.min(1, 4.0 * dt);

            if (sim.phaseTimer >= 0.55) {
              sim.phaseTimer = 0;
              sim.settleQuietTime = 0;
              setCranePhase('settling');
            }
          } else if (curPhase === 'settling') {
            sim.phaseTimer += dt;
            sim.gantryX += (homeX - sim.gantryX) * Math.min(1, 4.5 * dt);
            sim.gantryZ += (homeZ - sim.gantryZ) * Math.min(1, 4.5 * dt);
            sim.targetHeadY += (homeY - sim.targetHeadY) * Math.min(1, 4.5 * dt);

            let quiet = true;
            if (activePrizeBody && !sim.wonThisTurn) {
              const v = activePrizeBody.GetLinearVelocity();
              const av = activePrizeBody.GetAngularVelocity();
              const linSpd = Math.hypot(v.GetX(), v.GetY(), v.GetZ());
              const angSpd = Math.hypot(av.GetX(), av.GetY(), av.GetZ());
              if (linSpd > 0.05 || angSpd > 0.08) quiet = false;
            }
            if (quiet) sim.settleQuietTime += dt;
            else sim.settleQuietTime = 0;

            if (sim.settleQuietTime >= 0.55 || sim.phaseTimer >= 4.2) {
              finishTurn();
            }
          }

          // Kinematic Gantry 이동 + SixDOF Y 타겟 갱신
          tmpRVec.Set(sim.gantryX, homeY, sim.gantryZ);
          bi.MoveKinematic(gantryBody.GetID(), tmpRVec, tmpIdQuat, Math.max(dt, 1 / 120));
          tmpVec.Set(0, sim.targetHeadY - homeY, 0);
          sixConstraint.SetTargetPositionCS(tmpVec);

          // 항상 120Hz 서브스텝으로 Jolt 물리 스텝 진행 (대기 중에도 실시간 흔들림/안착 반응!)
          jolt.Step(dt, 2);

          // Three.js 비주얼 1:1 동기화
          const hp = headBody.GetPosition();
          const hq = headBody.GetRotation();
          ufoHeadGroup.position.set(hp.GetX(), hp.GetY(), hp.GetZ());
          ufoHeadGroup.quaternion.set(hq.GetX(), hq.GetY(), hq.GetZ(), hq.GetW());

          const lp = leftArm.body.GetPosition();
          const lq = leftArm.body.GetRotation();
          leftArmVisual.position.set(lp.GetX(), lp.GetY(), lp.GetZ());
          leftArmVisual.quaternion.set(lq.GetX(), lq.GetY(), lq.GetZ(), lq.GetW());

          const rp = rightArm.body.GetPosition();
          const rq = rightArm.body.GetRotation();
          rightArmVisual.position.set(rp.GetX(), rp.GetY(), rp.GetZ());
          rightArmVisual.quaternion.set(rq.GetX(), rq.GetY(), rq.GetZ(), rq.GetW());

          gantryBeam.position.z = sim.gantryZ;
          trolleyMesh.position.set(sim.gantryX, 3.25, sim.gantryZ);

          // 와이어 케이블: 갠트리 트롤리 → 동적 UFO 헤드 상단 직접 연결
          tmpThreePosA.set(sim.gantryX, 3.22, sim.gantryZ);
          tmpThreePosB.set(hp.GetX(), hp.GetY() + 0.14, hp.GetZ());
          tmpThreeDir.subVectors(tmpThreePosB, tmpThreePosA);
          const cableLen = Math.max(0.08, tmpThreeDir.length());
          cableMesh.scale.set(1, cableLen, 1);
          cableMesh.position.lerpVectors(tmpThreePosA, tmpThreePosB, 0.5);
          tmpThreeDir.normalize();
          tmpThreeQuat.setFromUnitVectors(tmpThreeUp, tmpThreeDir);
          cableMesh.quaternion.copy(tmpThreeQuat);

          if (activePrizeBody && activePrizeMesh) {
            const pp = activePrizeBody.GetPosition();
            const pq = activePrizeBody.GetRotation();
            activePrizeMesh.position.set(pp.GetX(), pp.GetY(), pp.GetZ());
            activePrizeMesh.quaternion.set(pq.GetX(), pq.GetY(), pq.GetZ(), pq.GetW());
            if (activePrizeDebugGroup) {
              activePrizeDebugGroup.position.copy(activePrizeMesh.position);
              activePrizeDebugGroup.quaternion.copy(activePrizeMesh.quaternion);
            }

            if (!sim.wonThisTurn && pp.GetY() < STAGE_PHYSICS.DROP_Y_THRESHOLD) {
              sim.wonThisTurn = true;
              setDroppedThisTurn(true);
              playTone(783.99, 0.14, 'sine', 0.12);
              setTimeout(() => playTone(1046.5, 0.25, 'sine', 0.12), 110);
              fireWinConfetti();
              onPrizeWonRef.current(activePrizeSpec);
            }
          }

          // 레이저 조준 링
          const showAim =
            curPhase === 'ready_right' ||
            curPhase === 'moving_right' ||
            curPhase === 'ready_up' ||
            curPhase === 'moving_up';
          aimRing.visible = showAim;
          aimBeam.visible = showAim;
          if (showAim) {
            aimRing.position.set(hp.GetX(), STAGE_PHYSICS.BAR_Y + 0.12, hp.GetZ());
            const beamH = Math.max(0.2, hp.GetY() - (STAGE_PHYSICS.BAR_Y + 0.12));
            aimBeam.scale.y = beamH / 1.7;
            aimBeam.position.set(hp.GetX(), STAGE_PHYSICS.BAR_Y + 0.12 + beamH / 2, hp.GetZ());
          }

          // 카메라 부드러운 보간
          const desiredPose = getCameraPose(
            cameraViewRef.current,
            viewportW,
            viewportH,
            frontTiptoeDegRef.current
          );
          const lerpAlpha = Math.min(1, rawDt * 8.5);
          camera.position.lerp(desiredPose.pos, lerpAlpha);
          currentLookAt.lerp(desiredPose.look, lerpAlpha);
          camera.lookAt(currentLookAt);

          // 텔레메트리 HUD (약 10Hz 업데이트로 React 리렌더 부하 최소화)
          sim.telemetryAccum += rawDt;
          if (sim.telemetryAccum >= 0.1) {
            sim.telemetryAccum = 0;
            let prizeY = 0;
            let prizeTiltDeg = 0;
            let prizeSpeed = 0;
            if (activePrizeBody) {
              const pp = activePrizeBody.GetPosition();
              const pq = activePrizeBody.GetRotation();
              const pv = activePrizeBody.GetLinearVelocity();
              prizeY = pp.GetY();
              prizeSpeed = Math.hypot(pv.GetX(), pv.GetY(), pv.GetZ());
              tmpThreeQuat.set(pq.GetX(), pq.GetY(), pq.GetZ(), pq.GetW());
              tmpThreeDir.set(0, 1, 0).applyQuaternion(tmpThreeQuat);
              prizeTiltDeg = Math.round((Math.acos(Math.max(-1, Math.min(1, tmpThreeDir.y))) * 180) / Math.PI);
            }
            setTelemetry({
              headY: Number(hp.GetY().toFixed(2)),
              leftDeg: Math.round((Math.abs(leftArm.hinge.GetCurrentAngle()) * 180) / Math.PI),
              rightDeg: Math.round((Math.abs(rightArm.hinge.GetCurrentAngle()) * 180) / Math.PI),
              prizeY: Number(prizeY.toFixed(2)),
              prizeTiltDeg,
              prizeSpeed: Number(prizeSpeed.toFixed(2)),
              isInitialState: activePrizeIsInitial,
            });
          }

          renderer!.render(scene, camera);
        };

        animId = requestAnimationFrame(animate);

        handleResize = () => {
          if (!container || !renderer) return;
          const w = container.clientWidth || 720;
          const h = container.clientHeight || 460;
          applyResponsiveCamera(w, h, false);
          renderer.setSize(w, h);
        };
        window.addEventListener('resize', handleResize);
      })
      .catch((err) => {
        console.error('Jolt Physics init failed:', err);
        if (!disposed) setEngineError(String(err?.message || err));
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(animId);
      if (handleResize) window.removeEventListener('resize', handleResize);
      if (renderer) renderer.dispose();
    };
  }, [playTone, setCranePhase, triggerExtremeDrr, triggerBalanceCatch, fireWinConfetti]);

  // 뽑기판 전환 시 해당 머신 스냅샷 로드
  useEffect(() => {
    if (!engineReady || !simBridgeRef.current) return;
    simBridgeRef.current.loadMachine(machineIndex, snapshotsRef.current[machineIndex]);
  }, [machineIndex, engineReady]);

  // 실시간 물리 튜닝 반영
  useEffect(() => {
    if (!engineReady || !simBridgeRef.current) return;
    simBridgeRef.current.applyLiveTuning(tuning);
  }, [
    engineReady,
    tuning.downPressForce,
    tuning.clawTipFriction,
    tuning.barRingFriction,
    tuning.showColliders,
    tuning,
  ]);

  // 무게 배율 / 무게중심 오프셋 변경 시 대기 상태면 즉시 재생성 반영
  useEffect(() => {
    if (!engineReady || !simBridgeRef.current) return;
    simBridgeRef.current.rebuildCurrentPrizeForTuning();
  }, [engineReady, tuning.massScale, tuning.useComOffset]);

  const currentSpec = PRIZE_SPECS[machineIndex];
  const currentSnap = snapshots[machineIndex];
  const isPlaying = phase !== 'idle';

  // 조작 핸들러
  const handleStartTurn = useCallback(() => {
    if (!engineReady || phaseRef.current !== 'idle' || !currentSnap.hasStock) return;
    simBridgeRef.current?.startTurn();
  }, [engineReady, currentSnap.hasStock]);

  const handleRightPressStart = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (cameraViewRef.current !== 'front') {
      setCameraView('front');
      cameraViewRef.current = 'front';
      return;
    }
    if (phaseRef.current === 'ready_right') {
      setCranePhase('moving_right');
      playTone(350, 0.06);
    }
  };

  const handleRightPressEnd = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (phaseRef.current === 'moving_right') {
      setCranePhase('ready_up');
      playTone(520, 0.08);
    }
  };

  const handleUpPressStart = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (cameraViewRef.current !== 'front') {
      setCameraView('front');
      cameraViewRef.current = 'front';
      return;
    }
    if (phaseRef.current === 'ready_up') {
      setCranePhase('moving_up');
      playTone(420, 0.06);
    }
  };

  const handleUpPressEnd = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (phaseRef.current === 'moving_up') {
      simBridgeRef.current?.startDescending();
    }
  };

  const handleRealign = () => {
    if (isPlaying) return;
    const freshSnap: MachineSnapshot = {
      ...currentSnap,
      hasStock: true,
      position: getRestingPosition(currentSpec),
      quaternion: [0, 0, 0, 1],
      isInitialState: true,
    };
    onUpdateSnapshot(machineIndex, freshSnap);
    simBridgeRef.current?.loadMachine(machineIndex, freshSnap);
    playTone(587.33, 0.09, 'sine', 0.08);
  };

  const handleRefill = () => {
    if (isPlaying || currentSnap.hasStock) return;
    handleRealign();
  };

  // 키보드 지원 (Space 시작, → / D 우측, ↑ / W 안쪽)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Space' && phaseRef.current === 'idle' && snapshotsRef.current[machineIndexRef.current]?.hasStock) {
        e.preventDefault();
        simBridgeRef.current?.startTurn();
        return;
      }
      if ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && phaseRef.current === 'ready_right') {
        e.preventDefault();
        if (cameraViewRef.current !== 'front') {
          setCameraView('front');
          cameraViewRef.current = 'front';
          return;
        }
        setCranePhase('moving_right');
        playTone(350, 0.06);
      } else if ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') && phaseRef.current === 'ready_up') {
        e.preventDefault();
        if (cameraViewRef.current !== 'front') {
          setCameraView('front');
          cameraViewRef.current = 'front';
          return;
        }
        setCranePhase('moving_up');
        playTone(420, 0.06);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && phaseRef.current === 'moving_right') {
        e.preventDefault();
        setCranePhase('ready_up');
        playTone(520, 0.08);
      } else if ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') && phaseRef.current === 'moving_up') {
        e.preventDefault();
        simBridgeRef.current?.startDescending();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [playTone, setCranePhase]);

  const phaseBannerText = (() => {
    if (engineError) return `❌ Jolt 초기화 실패: ${engineError}`;
    if (!engineReady) return '⚙️ Jolt Physics 1.1.2 WASM 엔진 로딩 중...';
    switch (phase) {
      case 'idle':
        return currentSnap.hasStock
          ? '하단 [뽑기 시작] 또는 Space를 눌러 실제 Jolt 물리 크레인을 조작하세요!'
          : '📦 품절 상태입니다. 우측 상단 [뽑기판 리필]을 눌러 상품을 채우세요!';
      case 'ready_right':
        return '1단계: [➡ 우측 이동] 버튼을 꾹 눌렀다가 원하는 X 위치에서 떼세요!';
      case 'moving_right':
        return '➡ 오른쪽으로 이동 중... 손을 떼면 X 좌표가 고정됩니다!';
      case 'ready_up':
        return '2단계: [⬆ 안쪽(위) 이동] 버튼을 꾹 눌렀다가 원하는 Z 위치에서 떼세요!';
      case 'moving_up':
        return '⬆ 안쪽으로 이동 중... 손을 떼면 즉시 하강합니다!';
      case 'descending':
        return '⬇ 6-DOF 케이블 크레인 하강 중 (한쪽 집게가 걸려도 유연하게 끝까지 하강!)';
      case 'closing':
        return '🤏 실제 토크 모터 관절로 집게를 오므리는 중...';
      case 'lifting':
        return '⬆ 순수 물리 마찰·토크로 상품을 들어올리고 있습니다!';
      case 'releasing':
      case 'settling':
        return droppedThisTurn
          ? '🎉 중앙 Bar 사이로 통과 성공!! 상품을 획득했습니다!'
          : '⚖️ 상품이 실리콘 링 Bar 위에서 물리적으로 자리를 잡는 중...';
    }
  })();

  return (
    <div className="w-full rounded-3xl overflow-hidden border border-cyan-500/35 bg-slate-950 shadow-2xl shadow-cyan-950/30">
      {/* 상단 상태 바 */}
      <div className="px-4 py-2.5 bg-slate-900/95 border-b border-slate-800 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-400/45 text-cyan-300 text-[11px] font-black shrink-0">
              <Sparkles className="w-3 h-3" />
              {machineIndex + 1}/6번 판
            </span>
            <span className="text-xs font-black text-amber-300 shrink-0 hidden sm:inline">
              {currentSpec.label}
            </span>
            <span className="text-xs font-bold text-slate-200 truncate">{phaseBannerText}</span>
          </div>

          <button
            type="button"
            onClick={() => setSoundEnabled((v) => !v)}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer shrink-0"
            title={soundEnabled ? '효과음 끄기' : '효과음 켜기'}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4 text-cyan-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
          </button>
        </div>

        {/* 1~6번 개별 뽑기판 탭 + 우측 리필 / 재정렬 버튼 */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
            {PRIZE_SPECS.map((spec) => {
              const isActive = spec.index === machineIndex;
              const snap = snapshots[spec.index];
              return (
                <button
                  key={spec.index}
                  type="button"
                  disabled={isPlaying}
                  onClick={() => onSelectMachine(spec.index)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-bold shrink-0 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    isActive
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-sm'
                      : 'bg-slate-950/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      snap.hasStock ? 'bg-emerald-400' : 'bg-slate-600'
                    }`}
                  />
                  <span>{spec.shortName}</span>
                  {!snap.hasStock && <span className="text-[9px] text-rose-400 font-black">품절</span>}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 shrink-0 ml-auto">
            <button
              type="button"
              onClick={handleRefill}
              disabled={isPlaying || currentSnap.hasStock}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 text-[11px] font-black cursor-pointer disabled:opacity-40 transition-colors"
              title="품절된 현재 뽑기판 리필"
            >
              <PackagePlus className="w-3.5 h-3.5" />
              <span>뽑기판 리필</span>
            </button>

            <button
              type="button"
              onClick={handleRealign}
              disabled={isPlaying}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 text-[11px] font-black cursor-pointer disabled:opacity-40 transition-colors"
              title="현재 뽑기판 상품을 중앙 원위치로 재정렬"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>뽑기판 재정렬</span>
            </button>
          </div>
        </div>
      </div>

      {/* 3D WebGL 캔버스 뷰포트 */}
      <div className="relative w-full h-[320px] sm:h-[470px] bg-[#060a16] select-none">
        <div ref={mountRef} className="w-full h-full" />

        {/* 좌측 상단 카메라 시점 복귀 버튼 */}
        <button
          type="button"
          onClick={() => {
            setCameraView('front');
            setFrontTiptoeDeg(0);
          }}
          className={`absolute top-2.5 left-2.5 z-20 inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] sm:text-[11px] font-bold backdrop-blur-sm transition-all cursor-pointer ${
            cameraView === 'front' && frontTiptoeDeg === 0
              ? 'bg-slate-900/75 border-slate-700/80 text-slate-300'
              : 'bg-cyan-950/85 border-cyan-400/60 text-cyan-200 hover:bg-cyan-900/85'
          }`}
        >
          <Camera className="w-3 h-3 text-cyan-400" />
          <span>
            {cameraView === 'front'
              ? frontTiptoeDeg > 0
                ? `까치발 +${frontTiptoeDeg}°`
                : isPlaying
                ? '정면뷰 (조작 고정)'
                : '정면뷰'
              : cameraView === 'top'
              ? '항공뷰 · 정면복귀'
              : '우측뷰 · 정면복귀'}
          </span>
        </button>

        {/* 상단 중앙 컨트롤: 항공뷰 + 까치발 업/다운 (0°~45°) */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
          {!isPlaying && (
            <button
              type="button"
              onClick={() => setCameraView((prev) => (prev === 'top' ? 'front' : 'top'))}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[10px] sm:text-xs font-black backdrop-blur-sm shadow-md transition-all active:scale-95 cursor-pointer ${
                cameraView === 'top'
                  ? 'bg-cyan-500/90 border-cyan-300 text-slate-950'
                  : 'bg-slate-900/80 hover:bg-slate-800/90 border-slate-600/80 text-slate-200 hover:text-cyan-300'
              }`}
            >
              {cameraView === 'top' ? (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>정면뷰</span>
                </>
              ) : (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  <span>항공뷰</span>
                </>
              )}
            </button>
          )}

          {cameraView === 'front' && (
            <div className="inline-flex items-center rounded-full border border-emerald-500/50 bg-slate-900/85 backdrop-blur-sm shadow-md overflow-hidden">
              <button
                type="button"
                disabled={frontTiptoeDeg >= 45}
                onClick={() => setFrontTiptoeDeg((d) => Math.min(45, d + 15))}
                className="inline-flex items-center gap-0.5 px-2 py-1 text-[10px] sm:text-xs font-black text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-35 cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5" />
                <span>업</span>
              </button>
              <span className="px-1.5 text-[10px] sm:text-[11px] font-mono font-black text-white border-x border-slate-700/80">
                {frontTiptoeDeg}°
              </span>
              <button
                type="button"
                disabled={frontTiptoeDeg <= 0}
                onClick={() => setFrontTiptoeDeg((d) => Math.max(0, d - 15))}
                className="inline-flex items-center gap-0.5 px-2 py-1 text-[10px] sm:text-xs font-black text-amber-300 hover:bg-amber-500/20 disabled:opacity-35 cursor-pointer"
              >
                <span>다운</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* 우측 상단 실시간 Jolt 물리 텔레메트리 HUD */}
        <div className="absolute top-2.5 right-2.5 z-20 hidden sm:flex flex-col items-end gap-0.5 px-2.5 py-1.5 rounded-xl bg-slate-950/80 border border-slate-700/70 backdrop-blur-sm font-mono text-[10px] text-slate-300 pointer-events-none">
          <div className="flex items-center gap-1 text-cyan-300 font-black">
            <Activity className="w-3 h-3" />
            <span>Jolt WASM · 120Hz</span>
          </div>
          <div>
            집게 L <span className="text-amber-300">{telemetry.leftDeg}°</span> · R{' '}
            <span className="text-amber-300">{telemetry.rightDeg}°</span>
          </div>
          <div>
            상자 Y <span className="text-emerald-300">{telemetry.prizeY.toFixed(2)}</span> · 기울기{' '}
            <span className="text-rose-300">{telemetry.prizeTiltDeg}°</span>
          </div>
          <div className="text-[9px] text-slate-400">
            상태: {telemetry.isInitialState ? '초기 원위치 (Balance Catch 가능)' : '이동됨 (극한 드르륵 가능)'}
          </div>
        </div>

        {/* 우측 중앙 우측뷰 전환 버튼 */}
        {!isPlaying && (
          <button
            type="button"
            onClick={() => setCameraView((prev) => (prev === 'right' ? 'front' : 'right'))}
            className={`absolute right-2 top-1/2 -translate-y-1/2 z-20 inline-flex flex-col items-center justify-center px-1.5 py-2 rounded-2xl border text-[10px] font-black backdrop-blur-sm shadow-md transition-all active:scale-95 cursor-pointer gap-0.5 ${
              cameraView === 'right'
                ? 'bg-amber-500/90 border-amber-300 text-slate-950'
                : 'bg-slate-900/80 hover:bg-slate-800/90 border-slate-600/80 text-slate-200 hover:text-amber-300'
            }`}
          >
            {cameraView === 'right' ? (
              <>
                <ChevronLeft className="w-4 h-4" />
                <span className="leading-none">정면</span>
              </>
            ) : (
              <>
                <ChevronRight className="w-4 h-4" />
                <span className="leading-none">우측</span>
              </>
            )}
          </button>
        )}

        {/* 하단 상품 안내 뱃지 */}
        <div className="absolute bottom-2.5 left-2.5 pointer-events-none px-2.5 py-1 rounded-lg bg-emerald-950/85 border border-emerald-500/40 text-[10px] sm:text-xs font-bold text-emerald-300 backdrop-blur-sm">
          🎯 <strong className="text-white">{currentSpec.label}</strong> ({currentSpec.difficultyText}) ·{' '}
          <span className="text-amber-300 font-mono">{currentSpec.rewardSol} SOL</span>
        </div>

        {droppedThisTurn && (
          <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 pointer-events-none px-4 py-1.5 rounded-full bg-amber-500 text-slate-950 font-black text-xs sm:text-sm shadow-lg animate-bounce flex items-center gap-1.5">
            <Trophy className="w-4 h-4" />
            <span>🎊 통과 성공!! {currentSpec.label} 획득!</span>
          </div>
        )}

        {showExtremeDrr && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="px-6 py-3 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-600 border-2 border-yellow-200 text-white font-black text-xl sm:text-3xl tracking-tight shadow-[0_0_40px_rgba(249,115,22,0.85)] animate-bounce">
              ⚡ 극한 드르륵! ⚡
            </div>
          </div>
        )}

        {showBalanceCatch && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="px-6 py-3 rounded-2xl bg-gradient-to-r from-cyan-500 via-emerald-500 to-teal-500 border-2 border-cyan-100 text-white font-black text-xl sm:text-3xl tracking-tight shadow-[0_0_40px_rgba(16,185,129,0.85)] animate-bounce">
              ⚖️ Balance Catch!
            </div>
          </div>
        )}
      </div>

      {/* 하단 아케이드 조작 패널 */}
      <div className="p-4 bg-gradient-to-b from-slate-900 to-slate-950 border-t border-slate-800">
        {phase === 'idle' ? (
          <div className="flex flex-col md:flex-row items-center justify-between gap-3">
            <div className="text-xs text-slate-300 text-center md:text-left space-y-0.5">
              <div>
                엔진: <strong className="text-cyan-300">Jolt Physics 1.1.2 (C++ → WASM)</strong> ·{' '}
                <span className="text-emerald-300 font-bold">무제한 테스트 모드</span>
              </div>
              <div className="text-[11px] text-slate-400">
                현재 판 [{machineIndex + 1}/6]: <strong className="text-white">{currentSpec.label}</strong> · 시도{' '}
                {currentSnap.plays}회 / 획득 {currentSnap.wins}회
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto justify-center">
              <button
                type="button"
                onClick={() => onSelectMachine((machineIndex - 1 + PRIZE_SPECS.length) % PRIZE_SPECS.length)}
                className="inline-flex items-center justify-center gap-1 px-3.5 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-600/80 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-200 font-black text-xs sm:text-sm transition-all active:scale-95 cursor-pointer shrink-0"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>이전 뽑기</span>
              </button>

              <button
                type="button"
                disabled={!engineReady || !currentSnap.hasStock}
                onClick={handleStartTurn}
                className="flex-1 md:flex-none px-6 py-3 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-400 hover:to-rose-400 text-slate-950 font-black text-xs sm:text-sm shadow-lg shadow-orange-500/25 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
              >
                {!engineReady
                  ? '⚙️ Jolt 로딩 중...'
                  : !currentSnap.hasStock
                  ? '📦 품절 (리필 클릭)'
                  : '🕹️ 뽑기 시작! (Space)'}
              </button>

              <button
                type="button"
                onClick={() => onSelectMachine((machineIndex + 1) % PRIZE_SPECS.length)}
                className="inline-flex items-center justify-center gap-1 px-3.5 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-600/80 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-200 font-black text-xs sm:text-sm transition-all active:scale-95 cursor-pointer shrink-0"
              >
                <span>다음 뽑기</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
            <button
              type="button"
              onMouseDown={handleRightPressStart}
              onMouseUp={handleRightPressEnd}
              onMouseLeave={handleRightPressEnd}
              onTouchStart={handleRightPressStart}
              onTouchEnd={handleRightPressEnd}
              onTouchCancel={handleRightPressEnd}
              onContextMenu={(e) => e.preventDefault()}
              disabled={phase !== 'ready_right' && phase !== 'moving_right'}
              style={{ touchAction: 'none' }}
              className={`py-4 px-4 rounded-2xl font-black text-sm sm:text-base flex flex-col items-center justify-center gap-1 border-2 select-none transition-all ${
                phase === 'moving_right'
                  ? 'bg-cyan-400 text-slate-950 border-white scale-95 shadow-lg shadow-cyan-500/40 cursor-pointer'
                  : phase === 'ready_right'
                  ? 'bg-gradient-to-b from-cyan-500 to-blue-600 text-white border-cyan-300 shadow-lg shadow-cyan-500/25 hover:brightness-110 cursor-pointer animate-pulse'
                  : 'bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed'
              }`}
            >
              <ArrowRight className="w-6 h-6 stroke-[3]" />
              <span>1. 우(→) 이동</span>
              <span className="text-[10px] font-medium opacity-85">
                {phase === 'moving_right' ? '손 떼면 정지!' : phase === 'ready_right' ? '꾹 누르고 있기 (→)' : '완료'}
              </span>
            </button>

            <button
              type="button"
              onMouseDown={handleUpPressStart}
              onMouseUp={handleUpPressEnd}
              onMouseLeave={handleUpPressEnd}
              onTouchStart={handleUpPressStart}
              onTouchEnd={handleUpPressEnd}
              onTouchCancel={handleUpPressEnd}
              onContextMenu={(e) => e.preventDefault()}
              disabled={phase !== 'ready_up' && phase !== 'moving_up'}
              style={{ touchAction: 'none' }}
              className={`py-4 px-4 rounded-2xl font-black text-sm sm:text-base flex flex-col items-center justify-center gap-1 border-2 select-none transition-all ${
                phase === 'moving_up'
                  ? 'bg-amber-400 text-slate-950 border-white scale-95 shadow-lg shadow-amber-500/40 cursor-pointer'
                  : phase === 'ready_up'
                  ? 'bg-gradient-to-b from-amber-500 to-orange-600 text-slate-950 border-amber-300 shadow-lg shadow-amber-500/25 hover:brightness-110 cursor-pointer animate-pulse'
                  : 'bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed'
              }`}
            >
              <ArrowUp className="w-6 h-6 stroke-[3]" />
              <span>2. 안쪽(↑) 이동</span>
              <span className="text-[10px] font-medium opacity-85">
                {phase === 'moving_up'
                  ? '손 떼면 하강!'
                  : phase === 'ready_up'
                  ? '꾹 누르고 있기 (↑)'
                  : phase === 'ready_right' || phase === 'moving_right'
                  ? '1단계 먼저'
                  : '작동 중'}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
