import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import initJolt from 'jolt-physics';
import type JoltNS from 'jolt-physics';
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
  Loader2,
  Activity,
} from 'lucide-react';
import { GachaBoxItem } from '@/types/gacha';
import { GACHA_PHYSICS, getBoxDimensions, getBoxRewardAmount, isBoxAtInitialPose, isPlushSlot } from '@/constants/gacha';
import { DEFAULT_PHYSICS_TUNING, PRIZE_SPECS, PrizeSpec } from '@/constants/prizes';

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

export interface TurnFinishPayload {
  wonItemIds: string[];
  updatedItems: {
    id: string;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    isInitialState?: boolean;
  }[];
  actionSummary: string;
}

interface JoltUfoMachine3DProps {
  items: GachaBoxItem[];
  isMyTurn: boolean;
  lockedByOther: string | null;
  turnKey: string | null;
  onTurnFinish: (payload: TurnFinishPayload) => void;
  onStartTurnRequest?: () => void;
  canStartTurn: boolean;
  selectedMember: string;
  selectedMemberTickets: number;
  isStarting: boolean;
  isFinishing?: boolean;
  sessionProgress?: { current: number; total: number; bonusPlays: number } | null;
  otherSessionProgress?: { current: number; total: number } | null;
  machineIndex: number;
  machineCount: number;
  machineLabel: string;
  machineDifficulty: string;
  machineRewardSol: number;
  onPrevMachine: () => void;
  onNextMachine: () => void;
  onSelectMachine?: (idx: number) => void;
  machineSummaries?: Array<{
    index: number;
    shortName: string;
    hasStock: boolean;
    lockedBy: string | null;
  }>;
  isAdmin?: boolean;
  onAdminRefill?: () => void;
  onAdminReset?: () => void;
  isRefilling?: boolean;
  isResetting?: boolean;
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

function getSpecForSlot(slotIndex: number): PrizeSpec {
  const safeIdx = ((slotIndex % PRIZE_SPECS.length) + PRIZE_SPECS.length) % PRIZE_SPECS.length;
  return PRIZE_SPECS[safeIdx];
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
    ctx.fillText(`AIAL PRIZE · ${rewardSol} SOL`, 128, 88);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createFigureFrontTexture(slotIndex: number, label: string): THREE.CanvasTexture {
  const spec = getSpecForSlot(slotIndex);
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
    ctx.fillText(`${label} · ${getBoxRewardAmount(slotIndex)} SOL`, cw / 2, bannerY + 52);

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

function createFigureBoxMaterials(slotIndex: number, label: string): THREE.MeshStandardMaterial[] {
  const spec = getSpecForSlot(slotIndex);
  const rewardSol = getBoxRewardAmount(slotIndex);
  const frontTex = createFigureFrontTexture(slotIndex, label);
  const sideTex = createSidePanelTexture(spec.title, spec.sideAccent, spec.sideBg, rewardSol);
  const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.24, metalness: 0.14 });
  const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.30, metalness: 0.22 });
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

// 좌/우 실제 Jolt 3-세그먼트 곡면 집게 치수 (Three.js 비주얼과 1:1 일치)
const ARM_SEGMENTS = [
  { pos: [0.08, -0.19, 0] as const, rotZ: 0.35, half: [0.03, 0.20, 0.045] as const, isTip: false },
  { pos: [0.095, -0.52, 0] as const, rotZ: -0.32, half: [0.028, 0.17, 0.055] as const, isTip: false },
  { pos: [-0.015, -0.685, 0] as const, rotZ: 0.22, half: [0.068, 0.026, 0.075] as const, isTip: true },
];

const CLAW_OPEN_ANGLE = 0.64;
const CLAW_CLOSE_TARGET = -0.06;

export const JoltUfoMachine3D: React.FC<JoltUfoMachine3DProps> = ({
  items,
  isMyTurn,
  lockedByOther,
  turnKey,
  onTurnFinish,
  onStartTurnRequest,
  canStartTurn,
  selectedMember,
  selectedMemberTickets,
  isStarting,
  isFinishing = false,
  sessionProgress = null,
  otherSessionProgress = null,
  machineIndex,
  machineCount,
  machineLabel,
  machineDifficulty,
  machineRewardSol,
  onPrevMachine,
  onNextMachine,
  onSelectMachine,
  machineSummaries = [],
  isAdmin = false,
  onAdminRefill,
  onAdminReset,
  isRefilling = false,
  isResetting = false,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [phase, setPhase] = useState<CranePhase>('idle');
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [droppedThisTurn, setDroppedThisTurn] = useState(0);
  const [cameraView, setCameraView] = useState<CameraView>('front');
  const [frontTiptoeDeg, setFrontTiptoeDeg] = useState(0);
  const [showExtremeDrr, setShowExtremeDrr] = useState(false);
  const [showBalanceCatch, setShowBalanceCatch] = useState(false);

  const phaseRef = useRef<CranePhase>('idle');
  const soundEnabledRef = useRef(true);
  const cameraViewRef = useRef<CameraView>('front');
  const frontTiptoeDegRef = useRef(0);
  const itemsRef = useRef<GachaBoxItem[]>(items);
  const onTurnFinishRef = useRef(onTurnFinish);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const drrAudioRef = useRef<HTMLAudioElement | null>(null);
  const bcAudioRef = useRef<HTMLAudioElement | null>(null);
  const drrTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bcTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  itemsRef.current = items;

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
    onTurnFinishRef.current = onTurnFinish;
  }, [onTurnFinish]);

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

  const simControlRef = useRef<{
    syncFromItems: (nextItems: GachaBoxItem[]) => void;
    resetClawToHome: () => void;
    prepareTurnStart: (nextItems: GachaBoxItem[]) => void;
    startDescending: () => void;
  } | null>(null);

  // 새 턴 시작 감지 -> 정면뷰 자동 전환 + 최신 서버 좌표 반영 + ready_right
  useEffect(() => {
    if (isMyTurn && turnKey && engineReady) {
      setCameraView('front');
      cameraViewRef.current = 'front';
      setDroppedThisTurn(0);
      simControlRef.current?.prepareTurnStart(itemsRef.current);
      setCranePhase('ready_right');
      playTone(523.25, 0.12, 'sine', 0.1);
    } else if (!isMyTurn && phaseRef.current !== 'idle') {
      setCranePhase('idle');
    }
  }, [isMyTurn, turnKey, engineReady, setCranePhase, playTone]);

  // 대기 상태에서 서버 폴링 또는 뽑기판 전환으로 items 변경 시 동기화
  useEffect(() => {
    if (engineReady && !isMyTurn && !isFinishing && phaseRef.current === 'idle') {
      simControlRef.current?.syncFromItems(items);
    }
  }, [items, engineReady, isMyTurn, isFinishing]);

  // 뽑기판 전환 시 대기 크레인 홈 복귀
  useEffect(() => {
    if (engineReady && !isMyTurn && !isFinishing && phaseRef.current === 'idle') {
      setDroppedThisTurn(0);
      simControlRef.current?.resetClawToHome();
      simControlRef.current?.syncFromItems(itemsRef.current);
    }
  }, [machineIndex, engineReady, isMyTurn, isFinishing]);

  // Jolt Physics 1.1.2 WASM + Three.js 메인 씬 초기화
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

        const tuning = DEFAULT_PHYSICS_TUNING;
        const width = container.clientWidth || 720;
        const height = container.clientHeight || 460;

        // 1. Scene & Camera
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

        // 2. Lights
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

        // 3. Arcade Cabinet Visuals
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
        const pillarX = GACHA_PHYSICS.CABINET_HALF_X + 0.1;
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
          new THREE.BoxGeometry(GACHA_PHYSICS.BAR_LENGTH + 0.2, 0.1, 0.14),
          new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.85, roughness: 0.2 })
        );
        gantryBeam.position.set(0, 3.25, GACHA_PHYSICS.CLAW_HOME_Z);
        scene.add(gantryBeam);

        const trolleyMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.16, 0.24),
          new THREE.MeshStandardMaterial({ color: '#38bdf8', metalness: 0.75, roughness: 0.2 })
        );
        trolleyMesh.position.set(GACHA_PHYSICS.CLAW_HOME_X, 3.25, GACHA_PHYSICS.CLAW_HOME_Z);
        scene.add(trolleyMesh);

        const acrylicMat = new THREE.MeshPhysicalMaterial({
          color: '#94a3b8',
          transparent: true,
          opacity: 0.11,
          roughness: 0.1,
          metalness: 0.1,
          side: THREE.DoubleSide,
        });
        const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(GACHA_PHYSICS.BAR_LENGTH + 0.16, 3.4), acrylicMat);
        backGlass.position.set(0, 0.8, -1.46);
        cabinetGroup.add(backGlass);

        [-(GACHA_PHYSICS.CABINET_HALF_X + 0.06), GACHA_PHYSICS.CABINET_HALF_X + 0.06].forEach((sx) => {
          const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.94, 3.4), acrylicMat);
          sideGlass.rotation.y = Math.PI / 2;
          sideGlass.position.set(sx, 0.8, 0);
          cabinetGroup.add(sideGlass);
        });

        const rampVisualGeo = new THREE.BoxGeometry(GACHA_PHYSICS.BAR_LENGTH, 0.05, 0.84);
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

        const barGeo = new THREE.CylinderGeometry(
          GACHA_PHYSICS.BAR_RADIUS,
          GACHA_PHYSICS.BAR_RADIUS,
          GACHA_PHYSICS.BAR_LENGTH,
          24
        );
        barGeo.rotateZ(Math.PI / 2);
        const barMatVisual = new THREE.MeshStandardMaterial({
          color: '#e2e8f0',
          metalness: 0.92,
          roughness: 0.14,
        });
        const ringGeo = new THREE.TorusGeometry(GACHA_PHYSICS.BAR_RADIUS + 0.009, 0.016, 10, 24);
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
          { y: GACHA_PHYSICS.BAR_Y, z: -GACHA_PHYSICS.BAR_HALF_Z, isOuter: false },
          { y: GACHA_PHYSICS.BAR_Y, z: GACHA_PHYSICS.BAR_HALF_Z, isOuter: false },
          { y: GACHA_PHYSICS.OUTER_BAR_Y, z: -GACHA_PHYSICS.OUTER_BAR_HALF_Z, isOuter: true },
          { y: GACHA_PHYSICS.OUTER_BAR_Y, z: GACHA_PHYSICS.OUTER_BAR_HALF_Z, isOuter: true },
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

        // UFO Head & Hinged Claw Arms Visuals
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
          }
          scene.add(group);
          return group;
        };

        const leftArmVisual = buildArmVisual(-1);
        const rightArmVisual = buildArmVisual(1);

        const cableMesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.02, 1, 8),
          new THREE.MeshStandardMaterial({ color: '#94a3b8', metalness: 0.85 })
        );
        scene.add(cableMesh);

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

        // 4. Jolt Physics 1.1.2 WASM World (5 Layers, 120Hz)
        const LAYER_ENV = 0;
        const LAYER_BAR = 1;
        const LAYER_PRIZE = 2;
        const LAYER_HEAD = 3;
        const LAYER_ARM = 4;

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

        // 4 Parallel Bars + Physical Silicone Rings
        const qBar = Jolt.Quat.prototype.sRotation(new Jolt.Vec3(0, 0, 1), Math.PI / 2);
        allBarSpecs.forEach(({ y: by, z: bz, isOuter }) => {
          const barShape = new Jolt.CylinderShape(GACHA_PHYSICS.BAR_LENGTH / 2, GACHA_PHYSICS.BAR_RADIUS, 0.02);
          const bcs = new Jolt.BodyCreationSettings(
            barShape,
            new Jolt.RVec3(0, by, bz),
            qBar,
            Jolt.EMotionType_Static,
            LAYER_BAR
          );
          bcs.mFriction = isOuter ? 0.34 : 0.28;
          bcs.mRestitution = 0.0;
          bi.AddBody(bi.CreateBody(bcs).GetID(), Jolt.EActivation_DontActivate);

          for (const rx of ringXPositions) {
            const ringShape = new Jolt.CylinderShape(0.022, GACHA_PHYSICS.BAR_RADIUS + 0.006, 0.008);
            const rbcs = new Jolt.BodyCreationSettings(
              ringShape,
              new Jolt.RVec3(rx, by, bz),
              qBar,
              Jolt.EMotionType_Static,
              LAYER_BAR
            );
            rbcs.mFriction = isOuter ? 0.55 : tuning.barRingFriction;
            rbcs.mRestitution = 0.0;
            bi.AddBody(bi.CreateBody(rbcs).GetID(), Jolt.EActivation_DontActivate);
          }
        });

        [-GACHA_PHYSICS.CABINET_HALF_X - 0.1, GACHA_PHYSICS.CABINET_HALF_X + 0.1].forEach((wx) => {
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

        const frontRampBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(GACHA_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
          new Jolt.RVec3(0, 1.24, 1.38),
          Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), -0.72),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        frontRampBCS.mFriction = 0.22;
        frontRampBCS.mRestitution = 0.0;
        bi.AddBody(bi.CreateBody(frontRampBCS).GetID(), Jolt.EActivation_DontActivate);

        const backRampBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(GACHA_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
          new Jolt.RVec3(0, 1.24, -1.38),
          Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), 0.72),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        backRampBCS.mFriction = 0.22;
        backRampBCS.mRestitution = 0.0;
        bi.AddBody(bi.CreateBody(backRampBCS).GetID(), Jolt.EActivation_DontActivate);

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

        // 5. Real Articulated UFO Crane Rig (Gantry ↔ SixDOF ↔ Head ↔ 2× Hinge ↔ 2× Claw Arm)
        const homeX = GACHA_PHYSICS.CLAW_HOME_X;
        const homeY = GACHA_PHYSICS.CLAW_HOME_Y;
        const homeZ = GACHA_PHYSICS.CLAW_HOME_Z;

        const gantryBody = bi.CreateBody(
          new Jolt.BodyCreationSettings(
            new Jolt.BoxShape(new Jolt.Vec3(0.1, 0.05, 0.1), 0.01),
            new Jolt.RVec3(homeX, homeY, homeZ),
            Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Kinematic,
            LAYER_HEAD
          )
        );
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
        motorY.mMinForceLimit = -tuning.downPressForce;
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
          abcs.mFriction = tuning.clawTipFriction;
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
          hm.mMinTorqueLimit = -tuning.closeTorque;
          hm.mMaxTorqueLimit = tuning.closeTorque;
          hc.SetMotorState(Jolt.EMotorState_Position);
          hc.SetTargetAngle(side * CLAW_OPEN_ANGLE);

          return { body: armBody, hinge: hc };
        };

        const leftArm = createClawArm(-1);
        const rightArm = createClawArm(1);

        // 6. 동적 상품 맵 (MongoDB GachaBoxItem[] 1:1 동기화)
        interface PrizeEntity {
          data: GachaBoxItem;
          mesh: THREE.Mesh;
          body: JoltNS.Body;
        }
        const prizeEntities = new Map<string, PrizeEntity>();

        const tmpRVec = new Jolt.RVec3(0, 0, 0);
        const tmpVec = new Jolt.Vec3(0, 0, 0);
        const tmpZeroVec = new Jolt.Vec3(0, 0, 0);
        const tmpQuat = new Jolt.Quat(0, 0, 0, 1);
        const tmpIdQuat = Jolt.Quat.prototype.sIdentity();
        const tmpThreePosA = new THREE.Vector3();
        const tmpThreePosB = new THREE.Vector3();
        const tmpThreeDir = new THREE.Vector3();
        const tmpThreeUp = new THREE.Vector3(0, 1, 0);
        const tmpThreeQuat = new THREE.Quaternion();

        const syncFromItems = (nextItems: GachaBoxItem[]) => {
          const nextIds = new Set(nextItems.map((it) => it.id));

          for (const [id, ent] of prizeEntities.entries()) {
            if (!nextIds.has(id)) {
              bi.RemoveBody(ent.body.GetID());
              bi.DestroyBody(ent.body.GetID());
              scene.remove(ent.mesh);
              ent.mesh.geometry.dispose();
              if (Array.isArray(ent.mesh.material)) {
                ent.mesh.material.forEach((m) => m.dispose());
              } else {
                ent.mesh.material.dispose();
              }
              prizeEntities.delete(id);
            }
          }

          for (const it of nextItems) {
            let ent = prizeEntities.get(it.id);
            if (!ent) {
              const dims = getBoxDimensions(it.slotIndex);
              const spec = getSpecForSlot(it.slotIndex);
              const plushItem = isPlushSlot(it.slotIndex);
              let mesh: THREE.Mesh;
              let shapeRef: JoltNS.Shape;

              if (plushItem) {
                const plushMat = createPlushMaterial(spec.imgSrc);
                const initGeo = cachedSandroneGeoData
                  ? buildBufferGeometryFromPlushData(cachedSandroneGeoData)
                  : new THREE.BoxGeometry(dims.w * 0.7, dims.h, dims.d * 0.85);
                mesh = new THREE.Mesh(initGeo, plushMat);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);

                if (!cachedSandroneGeoData) {
                  const targetId = it.id;
                  loadSandronePlushGeoData().then((geoData) => {
                    if (!geoData || disposed) return;
                    const liveEnt = prizeEntities.get(targetId);
                    if (!liveEnt) return;
                    const nextGeo = buildBufferGeometryFromPlushData(geoData);
                    liveEnt.mesh.geometry.dispose();
                    liveEnt.mesh.geometry = nextGeo;
                  });
                }

                const comp = new Jolt.StaticCompoundShapeSettings();
                comp.AddShape(new Jolt.Vec3(0.05, 0, 0.02), tmpIdQuat, new Jolt.BoxShapeSettings(new Jolt.Vec3(0.28, 0.21, 0.50), 0.02), 0);
                comp.AddShape(new Jolt.Vec3(0.04, 0, -0.44), tmpIdQuat, new Jolt.BoxShapeSettings(new Jolt.Vec3(0.19, 0.18, 0.20), 0.02), 0);
                comp.AddShape(new Jolt.Vec3(-0.30, 0, 0.24), tmpIdQuat, new Jolt.BoxShapeSettings(new Jolt.Vec3(0.15, 0.16, 0.30), 0.02), 0);
                comp.AddShape(new Jolt.Vec3(0.30, 0, 0.22), tmpIdQuat, new Jolt.BoxShapeSettings(new Jolt.Vec3(0.14, 0.17, 0.28), 0.02), 0);
                const comWrap = new Jolt.OffsetCenterOfMassShapeSettings(
                  new Jolt.Vec3(spec.comOffset[0], spec.comOffset[1], spec.comOffset[2]),
                  comp
                );
                shapeRef = comWrap.Create().Get();
              } else {
                const mats = createFigureBoxMaterials(it.slotIndex, it.label);
                mesh = new THREE.Mesh(new THREE.BoxGeometry(dims.w, dims.h, dims.d), mats);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);

                const boxShapeSettings = new Jolt.BoxShapeSettings(
                  new Jolt.Vec3(dims.w / 2, dims.h / 2, dims.d / 2),
                  0.015
                );
                const comWrap = new Jolt.OffsetCenterOfMassShapeSettings(
                  new Jolt.Vec3(spec.comOffset[0], spec.comOffset[1], spec.comOffset[2]),
                  boxShapeSettings
                );
                shapeRef = comWrap.Create().Get();
              }

              const bcs = new Jolt.BodyCreationSettings(
                shapeRef,
                new Jolt.RVec3(it.position[0], it.position[1], it.position[2]),
                new Jolt.Quat(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]),
                Jolt.EMotionType_Dynamic,
                LAYER_PRIZE
              );
              bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
              bcs.mMassPropertiesOverride.mMass = spec.mass;
              bcs.mFriction = spec.friction;
              bcs.mRestitution = 0.0;
              bcs.mLinearDamping = 0.18;
              bcs.mAngularDamping = 0.28;
              bcs.mMotionQuality = Jolt.EMotionQuality_LinearCast;
              bcs.mAllowSleeping = true;
              const body = bi.CreateBody(bcs);
              bi.AddBody(body.GetID(), Jolt.EActivation_DontActivate);

              ent = { data: { ...it }, mesh, body };
              prizeEntities.set(it.id, ent);
            }

            ent.data = { ...it };
            tmpRVec.Set(it.position[0], it.position[1], it.position[2]);
            tmpQuat.Set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
            bi.SetPositionAndRotation(ent.body.GetID(), tmpRVec, tmpQuat, Jolt.EActivation_DontActivate);
            bi.SetLinearAndAngularVelocity(ent.body.GetID(), tmpZeroVec, tmpZeroVec);

            ent.mesh.position.set(it.position[0], it.position[1], it.position[2]);
            ent.mesh.quaternion.set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
          }
        };

        // 7. Turn State Machine
        const sim = {
          gantryX: homeX,
          gantryZ: homeZ,
          targetHeadY: homeY,
          phaseTimer: 0,
          settleQuietTime: 0,
          wonSet: new Set<string>(),
          turnStartPositions: new Map<string, [number, number, number]>(),
          turnStartQuats: new Map<string, [number, number, number, number]>(),
          liftStartY: new Map<string, number>(),
          effectTriggeredThisTurn: false,
          lastHeadYForStall: homeY,
          descendStallTimer: 0,
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

        const resetClawToHome = () => {
          sim.gantryX = homeX;
          sim.gantryZ = homeZ;
          sim.targetHeadY = homeY;
          sim.phaseTimer = 0;
          sim.settleQuietTime = 0;
          sim.wonSet.clear();
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
          setArmTorques(tuning.closeTorque);
          setArmTargets(CLAW_OPEN_ANGLE);
        };

        const prepareTurnStart = (nextItems: GachaBoxItem[]) => {
          resetClawToHome();
          syncFromItems(nextItems);
          sim.turnStartPositions.clear();
          sim.turnStartQuats.clear();
          for (const ent of prizeEntities.values()) {
            sim.turnStartPositions.set(ent.data.id, [...ent.data.position] as [number, number, number]);
            sim.turnStartQuats.set(ent.data.id, [...ent.data.quaternion] as [number, number, number, number]);
          }
        };

        const startDescending = () => {
          sim.phaseTimer = 0;
          sim.descendStallTimer = 0;
          sim.lastHeadYForStall = headBody.GetPosition().GetY();
          // 하강 시작 시 상품 바디 활성화
          for (const ent of prizeEntities.values()) {
            bi.ActivateBody(ent.body.GetID());
          }
          setArmTorques(tuning.descendFlexTorque);
          setArmTargets(CLAW_OPEN_ANGLE);
          motorY.mMinForceLimit = -tuning.downPressForce;
          setCranePhase('descending');
          playTone(640, 0.12);
        };

        const finishTurn = () => {
          const wonItemIds = Array.from(sim.wonSet);
          const updatedItems = Array.from(prizeEntities.values()).map((ent) => {
            const bp = ent.body.GetPosition();
            const bq = ent.body.GetRotation();
            const px = bp.GetX();
            const py = bp.GetY();
            const pz = bp.GetZ();
            const qx = bq.GetX();
            const qy = bq.GetY();
            const qz = bq.GetZ();
            const qw = bq.GetW();

            const startPos = sim.turnStartPositions.get(ent.data.id) || ent.data.position;
            const startQuat = sim.turnStartQuats.get(ent.data.id) || ent.data.quaternion;
            const wasInitial = isBoxAtInitialPose(ent.data);
            const movedHoriz =
              Math.hypot(px - startPos[0], pz - startPos[2]) > 0.025 ||
              Math.abs(py - startPos[1]) > 0.035;
            const quatDot = Math.abs(
              qx * startQuat[0] + qy * startQuat[1] + qz * startQuat[2] + qw * startQuat[3]
            );
            const nextIsInitial = wasInitial && !movedHoriz && quatDot >= 0.999;
            ent.data.isInitialState = nextIsInitial;

            return {
              id: ent.data.id,
              position: [px, py, pz] as [number, number, number],
              quaternion: [qx, qy, qz, qw] as [number, number, number, number],
              isInitialState: nextIsInitial,
            };
          });

          setCranePhase('idle');
          onTurnFinishRef.current({
            wonItemIds,
            updatedItems,
            actionSummary: wonItemIds.length > 0 ? `${wonItemIds.length}개 획득` : '위치 이동',
          });
        };

        simControlRef.current = {
          syncFromItems,
          resetClawToHome,
          prepareTurnStart,
          startDescending,
        };

        syncFromItems(itemsRef.current);
        resetClawToHome();
        setEngineReady(true);

        // 8. Main Animation + Jolt 120Hz Physics Loop
        let lastTime = performance.now();

        const animate = (now: number) => {
          if (disposed) return;
          animId = requestAnimationFrame(animate);
          const dt = Math.min((now - lastTime) / 1000, 0.04);
          lastTime = now;

          const curPhase = phaseRef.current;

          if (curPhase === 'moving_right') {
            sim.gantryX = Math.min(GACHA_PHYSICS.CLAW_MAX_X, sim.gantryX + GACHA_PHYSICS.MOVE_SPEED_X * dt);
            if (sim.gantryX >= GACHA_PHYSICS.CLAW_MAX_X) {
              setCranePhase('ready_up');
              playTone(620, 0.08);
            }
          } else if (curPhase === 'moving_up') {
            sim.gantryZ = Math.max(GACHA_PHYSICS.CLAW_MIN_Z, sim.gantryZ - GACHA_PHYSICS.MOVE_SPEED_Z * dt);
            if (sim.gantryZ <= GACHA_PHYSICS.CLAW_MIN_Z) {
              startDescending();
            }
          } else if (curPhase === 'descending') {
            sim.phaseTimer += dt;
            sim.targetHeadY = Math.max(
              GACHA_PHYSICS.CLAW_DROP_Y,
              sim.targetHeadY - 0.64 * dt
            );

            const actualHeadY = headBody.GetPosition().GetY();
            if (actualHeadY - sim.targetHeadY > 0.14 && Math.abs(actualHeadY - sim.lastHeadYForStall) < 0.015) {
              sim.descendStallTimer += dt;
            } else {
              sim.descendStallTimer = 0;
              sim.lastHeadYForStall = actualHeadY;
            }

            if (sim.targetHeadY <= GACHA_PHYSICS.CLAW_DROP_Y || sim.descendStallTimer >= 0.45) {
              sim.phaseTimer = 0;
              setArmTorques(tuning.closeTorque);
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
              sim.liftStartY.clear();
              for (const ent of prizeEntities.values()) {
                sim.liftStartY.set(ent.data.id, ent.body.GetPosition().GetY());
              }
              setArmTorques(tuning.liftTorque);
              setArmTargets(CLAW_CLOSE_TARGET);
              setCranePhase('lifting');
              playTone(587.33, 0.12);
            }
          } else if (curPhase === 'lifting') {
            sim.phaseTimer += dt;
            sim.targetHeadY = Math.min(
              GACHA_PHYSICS.CLAW_LIFT_Y,
              sim.targetHeadY + 1.22 * dt
            );

            // 실제 물리적 리프트 감지 -> Balance Catch! (초기 원위치 정중앙) / 극한 드르륵! (비초기 중앙 빨간 Bar 근처)
            if (!sim.effectTriggeredThisTurn && sim.phaseTimer >= 0.12) {
              const headPos = headBody.GetPosition();
              for (const ent of prizeEntities.values()) {
                if (sim.wonSet.has(ent.data.id)) continue;
                const startY = sim.liftStartY.get(ent.data.id) ?? ent.data.position[1];
                const curY = ent.body.GetPosition().GetY();
                const velY = ent.body.GetLinearVelocity().GetY();
                if (curY - startY >= 0.065 && velY > 0.05) {
                  const isInit = isBoxAtInitialPose(ent.data);
                  const dims = getBoxDimensions(ent.data.slotIndex);
                  if (isInit) {
                    const startPos = sim.turnStartPositions.get(ent.data.id) || ent.data.position;
                    const centerDx = Math.abs(headPos.GetX() - startPos[0]);
                    const centerDz = Math.abs(headPos.GetZ() - startPos[2]);
                    const maxCenterDx = Math.max(0.20, dims.w * 0.30);
                    const maxCenterDz = Math.min(0.24, Math.max(0.20, dims.d * 0.16));
                    if (centerDx <= maxCenterDx && centerDz <= maxCenterDz) {
                      sim.effectTriggeredThisTurn = true;
                      triggerBalanceCatch();
                      break;
                    }
                  } else {
                    const hz = headPos.GetZ();
                    const nearCentralRedBar =
                      Math.abs(hz - GACHA_PHYSICS.BAR_HALF_Z) <= 0.28 ||
                      Math.abs(hz + GACHA_PHYSICS.BAR_HALF_Z) <= 0.28;
                    if (nearCentralRedBar) {
                      sim.effectTriggeredThisTurn = true;
                      triggerExtremeDrr();
                      break;
                    }
                  }
                }
              }
            }

            if (sim.targetHeadY >= GACHA_PHYSICS.CLAW_LIFT_Y || sim.phaseTimer >= 1.35) {
              sim.phaseTimer = 0;
              setArmTorques(tuning.closeTorque);
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

            let allQuiet = true;
            for (const ent of prizeEntities.values()) {
              if (sim.wonSet.has(ent.data.id)) continue;
              const v = ent.body.GetLinearVelocity();
              const av = ent.body.GetAngularVelocity();
              if (
                Math.hypot(v.GetX(), v.GetY(), v.GetZ()) > 0.05 ||
                Math.hypot(av.GetX(), av.GetY(), av.GetZ()) > 0.08
              ) {
                allQuiet = false;
                break;
              }
            }
            if (allQuiet) sim.settleQuietTime += dt;
            else sim.settleQuietTime = 0;

            if (sim.settleQuietTime >= 0.55 || sim.phaseTimer >= 4.2) {
              finishTurn();
            }
          }

          // 활성 턴 중 Jolt 120Hz 물리 스텝 실행 (대기 중엔 서버 저장 좌표 보존)
          if (curPhase !== 'idle') {
            tmpRVec.Set(sim.gantryX, homeY, sim.gantryZ);
            bi.MoveKinematic(gantryBody.GetID(), tmpRVec, tmpIdQuat, Math.max(dt, 1 / 120));
            tmpVec.Set(0, sim.targetHeadY - homeY, 0);
            sixConstraint.SetTargetPositionCS(tmpVec);

            // 조준 이동 중에는 상품이 미세 중력으로 움직이지 않도록 서버 좌표에 고정 유지
            const isAimingPhase =
              curPhase === 'ready_right' ||
              curPhase === 'moving_right' ||
              curPhase === 'ready_up' ||
              curPhase === 'moving_up';
            if (isAimingPhase) {
              for (const ent of prizeEntities.values()) {
                const sp = sim.turnStartPositions.get(ent.data.id) || ent.data.position;
                const sq = sim.turnStartQuats.get(ent.data.id) || ent.data.quaternion;
                tmpRVec.Set(sp[0], sp[1], sp[2]);
                tmpQuat.Set(sq[0], sq[1], sq[2], sq[3]);
                bi.SetPositionAndRotation(ent.body.GetID(), tmpRVec, tmpQuat, Jolt.EActivation_DontActivate);
                bi.SetLinearAndAngularVelocity(ent.body.GetID(), tmpZeroVec, tmpZeroVec);
              }
            }

            jolt.Step(dt, 2);

            if (!isAimingPhase) {
              for (const ent of prizeEntities.values()) {
                const pp = ent.body.GetPosition();
                const pq = ent.body.GetRotation();
                ent.mesh.position.set(pp.GetX(), pp.GetY(), pp.GetZ());
                ent.mesh.quaternion.set(pq.GetX(), pq.GetY(), pq.GetZ(), pq.GetW());

                if (!sim.wonSet.has(ent.data.id) && pp.GetY() < GACHA_PHYSICS.DROP_Y_THRESHOLD) {
                  sim.wonSet.add(ent.data.id);
                  setDroppedThisTurn(sim.wonSet.size);
                  playTone(783.99, 0.14, 'sine', 0.12);
                  setTimeout(() => playTone(1046.5, 0.25, 'sine', 0.12), 110);
                }
              }
            }
          }

          // 크레인/집게/케이블 비주얼 1:1 동기화
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

          tmpThreePosA.set(sim.gantryX, 3.22, sim.gantryZ);
          tmpThreePosB.set(hp.GetX(), hp.GetY() + 0.14, hp.GetZ());
          tmpThreeDir.subVectors(tmpThreePosB, tmpThreePosA);
          const cableLen = Math.max(0.08, tmpThreeDir.length());
          cableMesh.scale.set(1, cableLen, 1);
          cableMesh.position.lerpVectors(tmpThreePosA, tmpThreePosB, 0.5);
          tmpThreeDir.normalize();
          tmpThreeQuat.setFromUnitVectors(tmpThreeUp, tmpThreeDir);
          cableMesh.quaternion.copy(tmpThreeQuat);

          const showAim =
            curPhase === 'ready_right' ||
            curPhase === 'moving_right' ||
            curPhase === 'ready_up' ||
            curPhase === 'moving_up';
          aimRing.visible = showAim;
          aimBeam.visible = showAim;
          if (showAim) {
            aimRing.position.set(hp.GetX(), GACHA_PHYSICS.BAR_Y + 0.12, hp.GetZ());
            const beamH = Math.max(0.2, hp.GetY() - (GACHA_PHYSICS.BAR_Y + 0.12));
            aimBeam.scale.y = beamH / 1.7;
            aimBeam.position.set(hp.GetX(), GACHA_PHYSICS.BAR_Y + 0.12 + beamH / 2, hp.GetZ());
          }

          const desiredPose = getCameraPose(
            cameraViewRef.current,
            viewportW,
            viewportH,
            frontTiptoeDegRef.current
          );
          const lerpAlpha = Math.min(1, dt * 8.5);
          camera.position.lerp(desiredPose.pos, lerpAlpha);
          currentLookAt.lerp(desiredPose.look, lerpAlpha);
          camera.lookAt(currentLookAt);

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
  }, [playTone, setCranePhase, triggerExtremeDrr, triggerBalanceCatch]);

  const isCraneLockedToFront = isMyTurn || isFinishing || phase !== 'idle';

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
      simControlRef.current?.startDescending();
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
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
        simControlRef.current?.startDescending();
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
    if (engineError) return `❌ Jolt Physics 초기화 오류: ${engineError}`;
    if (!engineReady) return '⚙️ Jolt Physics 1.1.2 WASM 물리 엔진 로딩 중...';
    if (lockedByOther) return `🔒 현재 ${lockedByOther}님이 크레인을 조작 중입니다...`;
    switch (phase) {
      case 'idle':
        return '하단 [뽑기 시작]을 눌러 Jolt 3D UFO 브릿지 크레인을 조작하세요!';
      case 'ready_right':
        return '1단계: [➡ 우측 이동] 버튼을 꾹 눌렀다가 원하는 X 위치에서 떼세요!';
      case 'moving_right':
        return '➡ 오른쪽으로 이동 중... 손을 떼면 X 좌표가 고정됩니다!';
      case 'ready_up':
        return '2단계: [⬆ 안쪽(위) 이동] 버튼을 꾹 눌렀다가 원하는 Z 위치에서 떼세요!';
      case 'moving_up':
        return '⬆ 안쪽으로 이동 중... 손을 떼면 즉시 하강하여 집게가 작동합니다!';
      case 'descending':
        return '⬇ 6-DOF 크레인이 하강하고 있습니다...';
      case 'closing':
        return '🤏 실제 관절 모터 집게로 상자를 잡는 중...';
      case 'lifting':
        return '⬆ 물리 마찰과 토크로 상자를 들어올리고 있습니다!';
      case 'releasing':
      case 'settling':
        return droppedThisTurn > 0
          ? '🎉 Bar 사이로 상자가 떨어졌습니다!! 결과 저장 중...'
          : '⚖️ 상자가 Bar 위에서 흔들리며 자리를 잡는 중...';
    }
  })();

  return (
    <div className="w-full rounded-3xl overflow-hidden border border-cyan-500/35 bg-slate-950 shadow-2xl shadow-cyan-950/30">
      {/* 상단 상태 바 */}
      <div className="px-4 py-2.5 bg-slate-900/95 border-b border-slate-800 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[11px] font-black shrink-0">
              <Sparkles className="w-3 h-3" />
              {machineIndex + 1}/{machineCount}번 판
            </span>
            <span className="text-xs font-black text-amber-300 shrink-0 hidden sm:inline">
              {machineLabel}
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

        {/* 개별 뽑기판 빠른 전환 탭 (#1 ~ #6) + 우측 관리자 전용 개별 리필/재정렬 버튼 */}
        {machineSummaries.length > 0 && (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 no-scrollbar">
              {machineSummaries.map((ms) => {
                const isActive = ms.index === machineIndex;
                return (
                  <button
                    key={ms.index}
                    type="button"
                    disabled={isCraneLockedToFront}
                    onClick={() => onSelectMachine?.(ms.index)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-bold shrink-0 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                      isActive
                        ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-sm'
                        : 'bg-slate-950/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        ms.lockedBy
                          ? 'bg-rose-400 animate-pulse'
                          : ms.hasStock
                          ? 'bg-emerald-400'
                          : 'bg-slate-600'
                      }`}
                    />
                    <span>{ms.shortName}</span>
                    {!ms.hasStock && (
                      <span className="text-[9px] text-rose-400 font-black">품절</span>
                    )}
                  </button>
                );
              })}
            </div>

            {isAdmin && (
              <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                <button
                  type="button"
                  onClick={onAdminRefill}
                  disabled={isRefilling || isResetting || isCraneLockedToFront}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/50 text-emerald-300 text-[11px] font-black cursor-pointer disabled:opacity-45 transition-colors"
                  title={`현재 선택된 ${machineLabel} 뽑기판 리필`}
                >
                  {isRefilling ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <PackagePlus className="w-3.5 h-3.5" />
                  )}
                  <span>뽑기판 리필</span>
                </button>

                <button
                  type="button"
                  onClick={onAdminReset}
                  disabled={isResetting || isRefilling || isCraneLockedToFront}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 text-amber-300 text-[11px] font-black cursor-pointer disabled:opacity-45 transition-colors"
                  title={`현재 선택된 ${machineLabel} 뽑기판 중앙 정위치 재정렬`}
                >
                  {isResetting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="w-3.5 h-3.5" />
                  )}
                  <span>뽑기판 재정렬</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3D WebGL 캔버스 뷰포트 */}
      <div className="relative w-full h-[300px] sm:h-[450px] bg-[#060a16] select-none">
        <div ref={mountRef} className="w-full h-full" />

        {/* 좌측 상단 카메라 시점 표시 */}
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
          title="기본 정면 뷰(0°)로 복귀"
        >
          <Camera className="w-3 h-3 text-cyan-400" />
          <span>
            {cameraView === 'front'
              ? frontTiptoeDeg > 0
                ? `까치발 +${frontTiptoeDeg}°`
                : isCraneLockedToFront
                ? '정면뷰 (조작 고정)'
                : '정면뷰'
              : cameraView === 'top'
              ? '항공뷰 · 정면복귀'
              : '우측뷰 · 정면복귀'}
          </span>
        </button>

        {/* 상단 중앙 컨트롤: 항공뷰 + 까치발 업/다운 (0°~45°) */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5">
          {!isCraneLockedToFront && (
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

        {/* 우측 상단 Jolt 엔진 배지 (연속 뽑기 배지 없을 때 표시) */}
        {!(isMyTurn && sessionProgress && sessionProgress.total > 1) && (
          <div className="absolute top-2.5 right-2.5 z-20 hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-cyan-500/35 text-[10px] font-mono font-bold text-cyan-300 backdrop-blur-sm pointer-events-none">
            <Activity className="w-3 h-3" />
            <span>Jolt Physics 3D · 120Hz</span>
          </div>
        )}

        {/* 우측 중앙 우측뷰 전환 버튼 */}
        {!isCraneLockedToFront && (
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

        {/* Bar 사이 낙하 안내 뱃지 */}
        <div className="absolute bottom-2.5 left-2.5 pointer-events-none px-2.5 py-1 rounded-lg bg-emerald-950/85 border border-emerald-500/40 text-[10px] sm:text-xs font-bold text-emerald-300 backdrop-blur-sm">
          🎯 <strong className="text-white">{machineLabel}</strong> ({machineDifficulty}) · 통과 시{' '}
          <span className="text-amber-300 font-mono">{machineRewardSol} SOL</span> 당첨!
        </div>

        {droppedThisTurn > 0 && (
          <div className="absolute top-11 left-1/2 -translate-x-1/2 z-30 pointer-events-none px-4 py-1.5 rounded-full bg-amber-500 text-slate-950 font-black text-xs sm:text-sm shadow-lg animate-bounce">
            🎊 통과 성공!! 상자 획득!
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

        {/* 연속 뽑기 진행 회차 뱃지 */}
        {isMyTurn && sessionProgress && sessionProgress.total > 1 && (
          <div className="absolute top-2.5 right-2.5 z-20 pointer-events-none px-3 py-1 rounded-xl bg-indigo-950/90 border border-cyan-400/50 text-xs font-black text-cyan-200 shadow-lg backdrop-blur-sm flex items-center gap-1.5">
            <span>
              🔥 연속 뽑기 {sessionProgress.current} / {sessionProgress.total}회
            </span>
            {sessionProgress.bonusPlays > 0 &&
              sessionProgress.current > sessionProgress.total - sessionProgress.bonusPlays && (
                <span className="px-1.5 py-0.5 rounded-md bg-amber-500 text-slate-950 text-[10px] font-black">
                  🎁 무료 보너스!
                </span>
              )}
          </div>
        )}

        {/* 다른 멤버가 뽑기 진행 중일 때 동시 진행 방지 오버레이 */}
        {lockedByOther && !isMyTurn && (
          <div className="absolute inset-0 z-10 bg-slate-950/45 backdrop-blur-[1.5px] flex items-center justify-center p-4 pointer-events-auto">
            <div className="px-5 py-3.5 rounded-2xl bg-slate-900/95 border border-rose-500/60 shadow-2xl text-center space-y-1 max-w-xs">
              <div className="inline-flex items-center gap-1.5 text-rose-300 text-xs font-black">
                <span className="w-2 h-2 rounded-full bg-rose-400 animate-ping" />
                <span>
                  {otherSessionProgress && otherSessionProgress.total > 1
                    ? `연속 뽑기 진행 중 (${otherSessionProgress.current}/${otherSessionProgress.total}회)`
                    : '현재 뽑기 진행 중'}
                </span>
              </div>
              <p className="text-sm font-black text-white">
                🔒 <span className="text-amber-300">{lockedByOther}</span>님이 뽑기를 진행 중입니다
              </p>
              <p className="text-[11px] text-slate-400">
                완료 후 상자 위치가 반영되면 바로 참여할 수 있습니다.
              </p>
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
                선택된 플레이어: <strong className="text-amber-400">{selectedMember}</strong>{' '}
                <span className="text-slate-400">(보유 뽑기권 {selectedMemberTickets}장)</span>
              </div>
              <div className="text-[11px] text-cyan-300 font-bold">
                현재 뽑기판 [{machineIndex + 1}/{machineCount}]:{' '}
                <span className="text-white">{machineLabel}</span> · {machineDifficulty} ·{' '}
                <span className="text-amber-300 font-mono">{machineRewardSol} SOL</span>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto justify-center">
              <button
                type="button"
                disabled={isCraneLockedToFront || isStarting}
                onClick={onPrevMachine}
                className="inline-flex items-center justify-center gap-1 px-3.5 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-600/80 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-200 font-black text-xs sm:text-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>이전 뽑기</span>
              </button>

              <button
                type="button"
                disabled={!engineReady || !canStartTurn || isStarting || isFinishing || !!lockedByOther || items.length === 0}
                onClick={() => {
                  if (cameraViewRef.current !== 'front') {
                    setCameraView('front');
                    cameraViewRef.current = 'front';
                  }
                  onStartTurnRequest?.();
                }}
                className="flex-1 md:flex-none px-5 sm:px-6 py-3 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-400 hover:to-rose-400 text-slate-950 font-black text-xs sm:text-sm shadow-lg shadow-orange-500/25 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
              >
                {!engineReady
                  ? '⚙️ 물리 엔진 준비 중...'
                  : isFinishing
                  ? '💾 위치 저장 중...'
                  : isStarting
                  ? '크레인 준비 중...'
                  : lockedByOther
                  ? `🔒 ${lockedByOther}님 진행 중...`
                  : items.length === 0
                  ? '📦 품절 (리필 대기)'
                  : selectedMemberTickets < 1
                  ? '뽑기권 부족'
                  : '🕹️ 뽑기 시작!'}
              </button>

              <button
                type="button"
                disabled={isCraneLockedToFront || isStarting}
                onClick={onNextMachine}
                className="inline-flex items-center justify-center gap-1 px-3.5 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-600/80 hover:border-cyan-400/60 text-slate-200 hover:text-cyan-200 font-black text-xs sm:text-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
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
