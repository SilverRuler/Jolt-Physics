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
  Maximize2,
  Minimize2,
  LayoutGrid,
  Shuffle,
  Radio,
  X,
} from 'lucide-react';
import { GachaBoxItem } from '@/types/gacha';
import {
  GACHA_PHYSICS,
  getBoxDimensions,
  getBoxRewardAmount,
  isBoxAtInitialPose,
  isPlushSlot,
  PLUSH_CHUTE_HOME_X,
  PLUSH_CHUTE_HOME_Z,
  PLUSH_CHUTE_WALL_HEIGHT,
  PLUSH_FLOOR_Y,
  PLUSH_MOUND_SCALE,
} from '@/constants/gacha';
import {
  DEFAULT_PHYSICS_TUNING,
  getMachineProfile,
  PhysicsTuning,
  PRIZE_SPECS,
  PrizeSpec,
} from '@/constants/prizes';
import { isPrizeSpanningRedAndBlueBar } from '@/lib/gachaEffects';

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
  | 'carrying'
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
    suspended?: boolean;
  }>;
  isMachineSuspended?: boolean;
  isAdmin?: boolean;
  onAdminRefill?: () => void;
  onAdminReset?: () => void;
  isRefilling?: boolean;
  isResetting?: boolean;
  tuning?: PhysicsTuning;
  sandboxMode?: boolean;
}

interface PlushGeoJson {
  w: number;
  h: number;
  d: number;
  positions: number[];
  uvs: number[];
  indices: number[];
}

interface GachaLiveFrame {
  machineIndex: number;
  turnKey: string;
  member: string;
  phase: string;
  gantryX: number;
  gantryZ: number;
  headPos: [number, number, number];
  headQuat: [number, number, number, number];
  leftArmPos: [number, number, number];
  leftArmQuat: [number, number, number, number];
  rightArmPos: [number, number, number];
  rightArmQuat: [number, number, number, number];
  backArmPos?: [number, number, number];
  backArmQuat?: [number, number, number, number];
  frontArmPos?: [number, number, number];
  frontArmQuat?: [number, number, number, number];
  items: Array<{
    id: string;
    position: [number, number, number];
    quaternion: [number, number, number, number];
  }>;
  effect?: 'start' | 'balance_catch' | 'extreme_drr' | 'near_near' | 'finish_win' | null;
  effectSeq?: number;
  ts: number;
}

const LIVE_PHASE_LABELS: Record<string, string> = {
  ready_right: '우(→) 이동 대기',
  moving_right: '우(→) 이동 중',
  ready_up: '위(↑) 이동 대기',
  moving_up: '위(↑) 이동 중',
  descending: '집게 하강 중',
  closing: '상품 잡는 중',
  lifting: '들어올리는 중',
  carrying: '배출구로 운반 중',
  releasing: '드랍 중',
  settling: '안정화 중',
};

let joltModulePromise: Promise<typeof JoltNS> | null = null;
function getJoltModule(): Promise<typeof JoltNS> {
  if (!joltModulePromise) {
    joltModulePromise = initJolt();
  }
  return joltModulePromise;
}

const cachedPlushGeoMap = new Map<string, PlushGeoJson>();
const plushGeoPromiseMap = new Map<string, Promise<PlushGeoJson | null>>();

function loadPlushGeoData(geoSrc: string): Promise<PlushGeoJson | null> {
  const hit = cachedPlushGeoMap.get(geoSrc);
  if (hit) return Promise.resolve(hit);
  let prom = plushGeoPromiseMap.get(geoSrc);
  if (!prom) {
    prom = fetch(geoSrc)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: PlushGeoJson | null) => {
        if (data && Array.isArray(data.positions) && Array.isArray(data.indices)) {
          cachedPlushGeoMap.set(geoSrc, data);
          return data;
        }
        return null;
      })
      .catch(() => null);
    plushGeoPromiseMap.set(geoSrc, prom);
  }
  return prom;
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

// 좌/우 실제 Jolt 3-세그먼트 롱 <> 다이아몬드 갈고리 형상 (+36% 연장 · 높이 0.44~0.64m 전 상품 하단까지 깊게 감싸며 닫힘 시 끝단이 중앙 x≈0에서 맞닿음)
const ARM_SEGMENTS = [
  { pos: [0.12, -0.23, 0] as const, rotZ: 0.48, half: [0.028, 0.26, 0.045] as const, isTip: false },
  { pos: [0.11, -0.68, 0] as const, rotZ: -0.53, half: [0.026, 0.256, 0.052] as const, isTip: false },
  { pos: [-0.105, -0.91, 0] as const, rotZ: 0.03, half: [0.082, 0.025, 0.072] as const, isTip: true },
];

const CLAW_OPEN_ANGLE = 0.72;
const CLAW_RELEASE_ANGLE = 0.94;
const CLAW_CLOSE_TARGET = -0.05;

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
  isMachineSuspended = false,
  isAdmin = false,
  onAdminRefill,
  onAdminReset,
  isRefilling = false,
  isResetting = false,
  tuning = DEFAULT_PHYSICS_TUNING,
  sandboxMode = false,
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
  const [showStartPopup, setShowStartPopup] = useState(false);
  const [showNearNear, setShowNearNear] = useState(false);
  const [showFinishWin, setShowFinishWin] = useState(false);
  const [spectateLiveActive, setSpectateLiveActive] = useState(false);
  const [spectatePhase, setSpectatePhase] = useState<string>('');
  const [isMachinePickerOpen, setIsMachinePickerOpen] = useState(false);
  const [isSpectatePickerOpen, setIsSpectatePickerOpen] = useState(false);
  const [spectateToast, setSpectateToast] = useState<string>('');
  const machineTabsRef = useRef<HTMLDivElement>(null);
  const spectateToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSpectateToast = useCallback((msg: string) => {
    setSpectateToast(msg);
    if (spectateToastTimerRef.current) clearTimeout(spectateToastTimerRef.current);
    spectateToastTimerRef.current = setTimeout(() => setSpectateToast(''), 2600);
  }, []);

  useEffect(() => {
    if (!isMachinePickerOpen && !isSpectatePickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsMachinePickerOpen(false);
        setIsSpectatePickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMachinePickerOpen, isSpectatePickerOpen]);

  useEffect(() => {
    const el = machineTabsRef.current;
    if (!el) return;
    const activeBtn = el.querySelector<HTMLButtonElement>(`button[data-machine-idx="${machineIndex}"]`);
    if (activeBtn) {
      activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  }, [machineIndex]);

  const phaseRef = useRef<CranePhase>('idle');
  const soundEnabledRef = useRef(true);
  const cameraViewRef = useRef<CameraView>('front');
  const frontTiptoeDegRef = useRef(0);
  const tuningRef = useRef<PhysicsTuning>(tuning);
  const targetRedBarHalfZ = getMachineProfile(machineIndex).redBarHalfZ;
  const redBarHalfZRef = useRef<number>(targetRedBarHalfZ);
  const itemsRef = useRef<GachaBoxItem[]>(items);
  const onTurnFinishRef = useRef(onTurnFinish);
  const isMyTurnRef = useRef(isMyTurn);
  const lockedByOtherRef = useRef<string | null>(lockedByOther);
  const machineIndexRef = useRef(machineIndex);
  const selectedMemberRef = useRef(selectedMember);
  const turnKeyRef = useRef<string | null>(turnKey);
  const sandboxModeRef = useRef(sandboxMode);
  const spectateFrameRef = useRef<GachaLiveFrame | null>(null);
  const lastLivePostTimeRef = useRef(0);
  const livePostInFlightRef = useRef(false);
  const liveEffectRef = useRef<{ effect: GachaLiveFrame['effect']; seq: number }>({ effect: null, seq: 0 });
  const lastSpectateEffectSeqRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const drrAudioRef = useRef<HTMLAudioElement | null>(null);
  const bcAudioRef = useRef<HTMLAudioElement | null>(null);
  const startAudioRef = useRef<HTMLAudioElement | null>(null);
  const nearAudio1Ref = useRef<HTMLAudioElement | null>(null);
  const nearAudio2Ref = useRef<HTMLAudioElement | null>(null);
  const finishAudioRef = useRef<HTMLAudioElement | null>(null);
  const drrTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bcTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  itemsRef.current = items;
  tuningRef.current = tuning;
  redBarHalfZRef.current = targetRedBarHalfZ;
  isMyTurnRef.current = isMyTurn;
  lockedByOtherRef.current = lockedByOther;
  machineIndexRef.current = machineIndex;
  selectedMemberRef.current = selectedMember;
  turnKeyRef.current = turnKey;
  sandboxModeRef.current = sandboxMode;

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
    const mkAudio = (src: string, vol = 0.88) => {
      const a = new Audio(src);
      a.preload = 'auto';
      a.volume = vol;
      return a;
    };
    drrAudioRef.current = mkAudio('/assets/drr.mp3', 0.85);
    bcAudioRef.current = mkAudio('/assets/bc.mp3', 0.9);
    startAudioRef.current = mkAudio('/assets/start.mp3', 0.88);
    nearAudio1Ref.current = mkAudio('/assets/nearnear.mp3', 0.9);
    nearAudio2Ref.current = mkAudio('/assets/nearnear2.mp3', 0.9);
    finishAudioRef.current = mkAudio('/assets/finish.mp3', 0.92);

    return () => {
      if (drrTimeoutRef.current) clearTimeout(drrTimeoutRef.current);
      if (bcTimeoutRef.current) clearTimeout(bcTimeoutRef.current);
      if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
      if (nearTimeoutRef.current) clearTimeout(nearTimeoutRef.current);
      if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
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
    if (isMyTurnRef.current) {
      liveEffectRef.current = { effect: 'extreme_drr', seq: liveEffectRef.current.seq + 1 };
    }
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
    if (isMyTurnRef.current) {
      liveEffectRef.current = { effect: 'balance_catch', seq: liveEffectRef.current.seq + 1 };
    }
    if (bcTimeoutRef.current) clearTimeout(bcTimeoutRef.current);
    bcTimeoutRef.current = setTimeout(() => setShowBalanceCatch(false), 1500);
    if (soundEnabledRef.current && bcAudioRef.current) {
      try {
        bcAudioRef.current.currentTime = 0;
        bcAudioRef.current.play().catch(() => {});
      } catch {}
    }
  }, []);

  const triggerStartPopup = useCallback((playStartAudio: boolean) => {
    setShowStartPopup(true);
    if (isMyTurnRef.current) {
      liveEffectRef.current = { effect: 'start', seq: liveEffectRef.current.seq + 1 };
    }
    if (startTimeoutRef.current) clearTimeout(startTimeoutRef.current);
    startTimeoutRef.current = setTimeout(() => setShowStartPopup(false), 1200);
    if (playStartAudio && soundEnabledRef.current && startAudioRef.current) {
      try {
        startAudioRef.current.currentTime = 0;
        startAudioRef.current.play().catch(() => {});
      } catch {}
    }
  }, []);

  const triggerNearNear = useCallback(() => {
    setShowNearNear(true);
    if (isMyTurnRef.current) {
      liveEffectRef.current = { effect: 'near_near', seq: liveEffectRef.current.seq + 1 };
    }
    if (nearTimeoutRef.current) clearTimeout(nearTimeoutRef.current);
    nearTimeoutRef.current = setTimeout(() => setShowNearNear(false), 1600);
    if (soundEnabledRef.current) {
      const pick = Math.random() < 0.5 ? nearAudio1Ref.current : nearAudio2Ref.current;
      if (pick) {
        try {
          pick.currentTime = 0;
          pick.play().catch(() => {});
        } catch {}
      }
    }
  }, []);

  const triggerFinishWin = useCallback(() => {
    setShowFinishWin(true);
    if (isMyTurnRef.current) {
      liveEffectRef.current = { effect: 'finish_win', seq: liveEffectRef.current.seq + 1 };
    }
    if (finishTimeoutRef.current) clearTimeout(finishTimeoutRef.current);
    finishTimeoutRef.current = setTimeout(() => setShowFinishWin(false), 2000);
    if (soundEnabledRef.current && finishAudioRef.current) {
      try {
        finishAudioRef.current.currentTime = 0;
        finishAudioRef.current.play().catch(() => {});
      } catch {}
    }
  }, []);

  // 실시간 관전 SSE 구독 (다른 플레이어가 진행 중일 때만 연결)
  useEffect(() => {
    if (sandboxMode || !lockedByOther || isMyTurn) {
      spectateFrameRef.current = null;
      lastSpectateEffectSeqRef.current = 0;
      setSpectateLiveActive(false);
      setSpectatePhase('');
      return;
    }

    const es = new EventSource(`/api/gacha/live?machineIndex=${machineIndex}`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.type === 'clear') {
          spectateFrameRef.current = null;
          setSpectateLiveActive(false);
          setSpectatePhase('');
          return;
        }
        if (msg?.type === 'frame' && msg.frame) {
          const frame = msg.frame as GachaLiveFrame;
          spectateFrameRef.current = frame;
          setSpectateLiveActive(true);
          setSpectatePhase(frame.phase || '');
          if (frame.effect && typeof frame.effectSeq === 'number' && frame.effectSeq !== lastSpectateEffectSeqRef.current) {
            lastSpectateEffectSeqRef.current = frame.effectSeq;
            const plushSpec = isPlushSlot(machineIndex);
            if (frame.effect === 'start') triggerStartPopup(false);
            else if (!plushSpec && frame.effect === 'balance_catch') triggerBalanceCatch();
            else if (!plushSpec && frame.effect === 'extreme_drr') triggerExtremeDrr();
            else if (!plushSpec && frame.effect === 'near_near') triggerNearNear();
            else if (frame.effect === 'finish_win') triggerFinishWin();
          }
        }
      } catch {}
    };
    es.onerror = () => {};

    return () => {
      es.close();
      spectateFrameRef.current = null;
      setSpectateLiveActive(false);
      setSpectatePhase('');
    };
  }, [
    sandboxMode,
    lockedByOther,
    isMyTurn,
    machineIndex,
    triggerStartPopup,
    triggerBalanceCatch,
    triggerExtremeDrr,
    triggerNearNear,
    triggerFinishWin,
  ]);

  const simControlRef = useRef<{
    syncFromItems: (nextItems: GachaBoxItem[]) => void;
    resetClawToHome: () => void;
    prepareTurnStart: (nextItems: GachaBoxItem[]) => void;
    startDescending: () => void;
    applyLiveTuning: (t: PhysicsTuning) => void;
    rebuildPrizesForTuning: () => void;
    updateRedBarSpacing: (halfZ: number) => void;
  } | null>(null);

  // 새 턴 시작 감지 -> 정면뷰 자동 전환 + 최신 서버 좌표 반영 + ready_right + 초기상태일 때만 start.mp3 재생
  useEffect(() => {
    if (isMyTurn && turnKey && engineReady) {
      setCameraView('front');
      cameraViewRef.current = 'front';
      setDroppedThisTurn(0);
      const curItems = itemsRef.current;
      const isInitialPoseOnly =
        curItems.length > 0 && curItems.every((it) => isBoxAtInitialPose(it));
      simControlRef.current?.prepareTurnStart(curItems);
      setCranePhase('ready_right');
      triggerStartPopup(isInitialPoseOnly || isPlushSlot(machineIndex));
    } else if (!isMyTurn && phaseRef.current !== 'idle') {
      setCranePhase('idle');
    }
  }, [isMyTurn, turnKey, engineReady, setCranePhase, triggerStartPopup]);

  useEffect(() => {
    if (engineReady) {
      simControlRef.current?.applyLiveTuning(tuning);
    }
  }, [
    engineReady,
    tuning.downPressForce,
    tuning.clawTipFriction,
    tuning.barRingFriction,
    tuning.showColliders,
    tuning,
  ]);

  useEffect(() => {
    if (engineReady && phaseRef.current === 'idle') {
      simControlRef.current?.rebuildPrizesForTuning();
    }
  }, [engineReady, tuning.massScale, tuning.useComOffset]);

  // 대기 상태에서 서버 폴링 또는 뽑기판 전환으로 items 변경 시 동기화
  useEffect(() => {
    if (engineReady && !isMyTurn && !isFinishing && phaseRef.current === 'idle') {
      simControlRef.current?.syncFromItems(items);
    }
  }, [items, engineReady, isMyTurn, isFinishing]);

  // 뽑기판 전환 시 대기 크레인 홈 복귀 + 테스트서버 상품별 빨간 Bar 간격 갱신
  useEffect(() => {
    if (engineReady) {
      simControlRef.current?.updateRedBarSpacing(targetRedBarHalfZ);
    }
    if (engineReady && !isMyTurn && !isFinishing && phaseRef.current === 'idle') {
      setDroppedThisTurn(0);
      simControlRef.current?.resetClawToHome();
      simControlRef.current?.syncFromItems(itemsRef.current);
    }
  }, [machineIndex, targetRedBarHalfZ, engineReady, isMyTurn, isFinishing]);

  // Jolt Physics 1.1.2 WASM + Three.js 메인 씬 초기화
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    let disposed = false;
    let animId = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let handleResize: (() => void) | null = null;
    let cleanupJolt: (() => void) | null = null;

    getJoltModule()
      .then((Jolt) => {
        if (disposed || !container) return;

        const tuning = tuningRef.current;
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
              pos: new THREE.Vector3(0, 7.45 * Math.max(1, scale * 0.88), 0.62),
              look: new THREE.Vector3(0, 0.78, 0.08),
            };
          }
          if (view === 'right') {
            return {
              fov,
              pos: new THREE.Vector3(5.35 * Math.max(1, scale * 0.85), 2.48 * (1 + (scale - 1) * 0.3), 0),
              look: new THREE.Vector3(0, 1.05, 0),
            };
          }
          const lookY = 0.98;
          const baseY = 3.55 * (1 + (scale - 1) * 0.62);
          const baseZ = 5.25 * scale;
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
          new THREE.BoxGeometry(4.0, 0.15, 4.16),
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

        const gridHelper = new THREE.GridHelper(4.0, 10, '#10b981', '#065f46');
        gridHelper.position.set(0, -1.46, 0);
        cabinetGroup.add(gridHelper);

        const pillarGeo = new THREE.CylinderGeometry(0.07, 0.07, 5.5, 16);
        const pillarMat = new THREE.MeshStandardMaterial({
          color: '#1e293b',
          emissive: '#38bdf8',
          emissiveIntensity: 0.35,
          metalness: 0.7,
          roughness: 0.2,
        });
        const pillarX = GACHA_PHYSICS.CABINET_HALF_X + 0.1;
        [
          [-pillarX, 1.2, -1.98],
          [pillarX, 1.2, -1.98],
          [-pillarX, 1.2, 1.98],
          [pillarX, 1.2, 1.98],
        ].forEach(([px, py, pz]) => {
          const p = new THREE.Mesh(pillarGeo, pillarMat);
          p.position.set(px, py, pz);
          cabinetGroup.add(p);
        });

        const frameBarMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.8, roughness: 0.25 });
        const railSideGeo = new THREE.BoxGeometry(0.12, 0.12, 4.12);
        [-pillarX, pillarX].forEach((rx) => {
          const r = new THREE.Mesh(railSideGeo, frameBarMat);
          r.position.set(rx, 3.82, 0);
          cabinetGroup.add(r);
        });

        const gantryBeam = new THREE.Mesh(
          new THREE.BoxGeometry(GACHA_PHYSICS.BAR_LENGTH + 0.2, 0.1, 0.14),
          new THREE.MeshStandardMaterial({ color: '#64748b', metalness: 0.85, roughness: 0.2 })
        );
        gantryBeam.position.set(0, 3.82, GACHA_PHYSICS.CLAW_HOME_Z);
        scene.add(gantryBeam);

        const trolleyMesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.28, 0.16, 0.24),
          new THREE.MeshStandardMaterial({ color: '#38bdf8', metalness: 0.75, roughness: 0.2 })
        );
        trolleyMesh.position.set(GACHA_PHYSICS.CLAW_HOME_X, 3.82, GACHA_PHYSICS.CLAW_HOME_Z);
        scene.add(trolleyMesh);

        const acrylicMat = new THREE.MeshPhysicalMaterial({
          color: '#94a3b8',
          transparent: true,
          opacity: 0.11,
          roughness: 0.1,
          metalness: 0.1,
          side: THREE.DoubleSide,
        });
        const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(GACHA_PHYSICS.BAR_LENGTH + 0.16, 4.0), acrylicMat);
        backGlass.position.set(0, 1.1, -1.96);
        cabinetGroup.add(backGlass);

        [-(GACHA_PHYSICS.CABINET_HALF_X + 0.06), GACHA_PHYSICS.CABINET_HALF_X + 0.06].forEach((sx) => {
          const sideGlass = new THREE.Mesh(new THREE.PlaneGeometry(3.96, 4.0), acrylicMat);
          sideGlass.rotation.y = Math.PI / 2;
          sideGlass.position.set(sx, 1.1, 0);
          cabinetGroup.add(sideGlass);
        });

        const activeProfile = getMachineProfile(machineIndex);
        const isPlushMachine = isPlushSlot(machineIndex);
        const headScale = activeProfile.headScale;
        const armPivotX = (isPlushMachine ? 0.20 : 0.22) * headScale;
        // 3D 뽑기 전용: 다리 길이 -30%, <> 꺾임 각도 완화(0.31/-0.35 rad), 얇은 스틸 암 + -30% 축소 팁
        const PLUSH_ARM_BASE = [
          { pos: [0.051, -0.160, 0] as const, rotZ: 0.31, half: [0.011, 0.168, 0.019] as const, mass: 0.09, isTip: false },
          { pos: [0.045, -0.476, 0] as const, rotZ: -0.35, half: [0.010, 0.166, 0.021] as const, mass: 0.09, isTip: false },
          { pos: [-0.048, -0.636, 0] as const, rotZ: 0.03, half: [0.048, 0.017, 0.042] as const, mass: 0.07, isTip: true },
        ];
        const scaledArmSegments = isPlushMachine
          ? PLUSH_ARM_BASE.map((seg) => ({
              ...seg,
              pos: [
                seg.pos[0] * activeProfile.armSizeScale,
                seg.pos[1] * activeProfile.armLengthScale,
                seg.pos[2],
              ] as const,
              half: [
                seg.half[0] * activeProfile.armSizeScale,
                seg.half[1] * activeProfile.armLengthScale,
                seg.half[2] * activeProfile.armSizeScale,
              ] as const,
            }))
          : ARM_SEGMENTS.map((seg) => ({
              ...seg,
              pos: [seg.pos[0] * activeProfile.armSizeScale, seg.pos[1] * activeProfile.armLengthScale, seg.pos[2]] as const,
              half: [
                seg.half[0] * activeProfile.armSizeScale,
                seg.half[1] * activeProfile.armLengthScale,
                seg.half[2] * activeProfile.armSizeScale,
              ] as const,
            }));
        const armBottomReach = (isPlushMachine ? 0.655 : 0.935) * activeProfile.armLengthScale;
        const effectiveDropY = isPlushMachine
          ? Number((PLUSH_FLOOR_Y + armBottomReach + 0.045).toFixed(3))
          : Number((GACHA_PHYSICS.CLAW_DROP_Y + (activeProfile.armLengthScale - 1.0) * 0.86).toFixed(3));
        const effectiveLiftY = isPlushMachine ? 3.36 : GACHA_PHYSICS.CLAW_LIFT_Y;

        if (!isPlushMachine) {
          const rampVisualGeo = new THREE.BoxGeometry(GACHA_PHYSICS.BAR_LENGTH, 0.05, 0.84);
          const rampVisualMat = new THREE.MeshPhysicalMaterial({
            color: '#38bdf8',
            transparent: true,
            opacity: 0.16,
            roughness: 0.2,
          });
          const frontRampMesh = new THREE.Mesh(rampVisualGeo, rampVisualMat);
          frontRampMesh.position.set(0, 1.24, 1.86);
          frontRampMesh.rotation.x = -0.72;
          cabinetGroup.add(frontRampMesh);

          const backRampMesh = new THREE.Mesh(rampVisualGeo, rampVisualMat);
          backRampMesh.position.set(0, 1.24, -1.86);
          backRampMesh.rotation.x = 0.72;
          cabinetGroup.add(backRampMesh);
        }

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

        const initRedHalfZ = activeProfile.redBarHalfZ;
        const initOuterHalfZ = activeProfile.outerBarHalfZ;
        const initOuterBarY = activeProfile.outerBarY;
        const allBarSpecs = isPlushMachine
          ? []
          : [
              { y: GACHA_PHYSICS.BAR_Y, z: -initRedHalfZ, isOuter: false, sign: -1 as const },
              { y: GACHA_PHYSICS.BAR_Y, z: initRedHalfZ, isOuter: false, sign: 1 as const },
              { y: initOuterBarY, z: -initOuterHalfZ, isOuter: true, sign: -1 as const },
              { y: initOuterBarY, z: initOuterHalfZ, isOuter: true, sign: 1 as const },
            ];
        const ringXPositions = [-1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5];
        const redBarMeshes: Array<{ mesh: THREE.Mesh; sign: -1 | 1 }> = [];
        const redRingMeshes: Array<{ mesh: THREE.Mesh; sign: -1 | 1 }> = [];

        allBarSpecs.forEach(({ y: by, z: bz, isOuter, sign }) => {
          const barMesh = new THREE.Mesh(barGeo, barMatVisual);
          barMesh.position.set(0, by, bz);
          barMesh.castShadow = true;
          barMesh.receiveShadow = true;
          cabinetGroup.add(barMesh);
          if (!isOuter) redBarMeshes.push({ mesh: barMesh, sign });

          for (const rx of ringXPositions) {
            const ring = new THREE.Mesh(ringGeo, isOuter ? blueRingMat : redRingMat);
            ring.position.set(rx, by, bz);
            cabinetGroup.add(ring);
            if (!isOuter) redRingMeshes.push({ mesh: ring, sign });
          }
        });

        // 3D 인형뽑기 전용: 클래식 산더미 바닥판 + 좌전방 배출구 구멍(WIN) + 아크릴 칸막이
        const plushFloorSlabs = isPlushMachine
          ? [
              { cx: 0.61, cy: PLUSH_FLOOR_Y - 0.06, cz: 0, w: 2.34, h: 0.12, d: 3.76 },
              { cx: -1.17, cy: PLUSH_FLOOR_Y - 0.06, cz: -0.74, w: 1.22, h: 0.12, d: 2.28 },
            ]
          : [];
        const plushChuteGuards = isPlushMachine
          ? [
              { cx: -0.56, cy: PLUSH_FLOOR_Y + PLUSH_CHUTE_WALL_HEIGHT / 2, cz: 1.14, w: 0.06, h: PLUSH_CHUTE_WALL_HEIGHT, d: 1.48 },
              { cx: -1.17, cy: PLUSH_FLOOR_Y + PLUSH_CHUTE_WALL_HEIGHT / 2, cz: 0.40, w: 1.22, h: PLUSH_CHUTE_WALL_HEIGHT, d: 0.06 },
            ]
          : [];
        if (isPlushMachine) {
          const plushDeckMat = new THREE.MeshStandardMaterial({
            color: '#1e293b',
            roughness: 0.55,
            metalness: 0.25,
          });
          for (const s of plushFloorSlabs) {
            const m = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), plushDeckMat);
            m.position.set(s.cx, s.cy, s.cz);
            m.receiveShadow = true;
            cabinetGroup.add(m);
          }
          const guardGlassMat = new THREE.MeshPhysicalMaterial({
            color: '#67e8f9',
            transparent: true,
            opacity: 0.32,
            roughness: 0.12,
            metalness: 0.1,
          });
          const guardRimMat = new THREE.MeshStandardMaterial({
            color: '#22d3ee',
            emissive: '#06b6d4',
            emissiveIntensity: 0.8,
          });
          for (const g of plushChuteGuards) {
            const gm = new THREE.Mesh(new THREE.BoxGeometry(g.w, g.h, g.d), guardGlassMat);
            gm.position.set(g.cx, g.cy, g.cz);
            cabinetGroup.add(gm);
            const rim = new THREE.Mesh(new THREE.BoxGeometry(g.w + 0.015, 0.03, g.d + 0.015), guardRimMat);
            rim.position.set(g.cx, PLUSH_FLOOR_Y + PLUSH_CHUTE_WALL_HEIGHT + 0.005, g.cz);
            cabinetGroup.add(rim);
          }
          const chuteSignCanvas = document.createElement('canvas');
          chuteSignCanvas.width = 256;
          chuteSignCanvas.height = 128;
          const sctx = chuteSignCanvas.getContext('2d');
          if (sctx) {
            sctx.fillStyle = '#083344';
            sctx.fillRect(0, 0, 256, 128);
            sctx.strokeStyle = '#22d3ee';
            sctx.lineWidth = 8;
            sctx.strokeRect(6, 6, 244, 116);
            sctx.fillStyle = '#fef08a';
            sctx.font = 'bold 36px sans-serif';
            sctx.textAlign = 'center';
            sctx.fillText('🎁 WIN', 128, 58);
            sctx.fillStyle = '#a5f3fc';
            sctx.font = 'bold 26px sans-serif';
            sctx.fillText('배출구 (DROP)', 128, 98);
          }
          const chuteSignTex = new THREE.CanvasTexture(chuteSignCanvas);
          chuteSignTex.colorSpace = THREE.SRGBColorSpace;
          const chuteSign = new THREE.Mesh(
            new THREE.PlaneGeometry(1.06, 0.54),
            new THREE.MeshBasicMaterial({ map: chuteSignTex })
          );
          chuteSign.rotation.x = -Math.PI / 2;
          chuteSign.position.set(PLUSH_CHUTE_HOME_X, -1.42, PLUSH_CHUTE_HOME_Z);
          cabinetGroup.add(chuteSign);
        }

        // UFO Head & Hinged Claw Arms Visuals
        const ufoHeadGroup = new THREE.Group();
        ufoHeadGroup.scale.setScalar(headScale);
        scene.add(ufoHeadGroup);

        if (isPlushMachine) {
          // 3D 인형뽑기 전용: 얇은 스틸 4집게와 어울리는 브러시드 메탈 타원형 구 헤드
          const ovalHead = new THREE.Mesh(
            new THREE.SphereGeometry(0.37, 32, 24),
            new THREE.MeshStandardMaterial({
              color: '#cbd5e1',
              emissive: '#0f172a',
              emissiveIntensity: 0.2,
              metalness: 0.92,
              roughness: 0.16,
            })
          );
          ovalHead.scale.set(1.06, 0.66, 1.06);
          ovalHead.position.set(0, 0.11, 0);
          ovalHead.castShadow = true;
          ufoHeadGroup.add(ovalHead);

          const topCollar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.11, 0.15, 0.12, 20),
            new THREE.MeshStandardMaterial({
              color: '#94a3b8',
              metalness: 0.94,
              roughness: 0.18,
            })
          );
          topCollar.position.set(0, 0.34, 0);
          ufoHeadGroup.add(topCollar);

          const equatorRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.39, 0.018, 12, 32),
            new THREE.MeshStandardMaterial({
              color: '#38bdf8',
              emissive: '#06b6d4',
              emissiveIntensity: 0.85,
              metalness: 0.6,
              roughness: 0.2,
            })
          );
          equatorRing.rotation.x = Math.PI / 2;
          equatorRing.position.set(0, 0.10, 0);
          ufoHeadGroup.add(equatorRing);

          const bottomHub = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.19, 0.07, 20),
            new THREE.MeshStandardMaterial({
              color: '#475569',
              metalness: 0.9,
              roughness: 0.22,
            })
          );
          bottomHub.position.set(0, -0.05, 0);
          ufoHeadGroup.add(bottomHub);
        } else {
          const ufoTop = new THREE.Mesh(
            new THREE.CylinderGeometry(0.30, 0.469, 0.25, 24),
            new THREE.MeshStandardMaterial({
              color: '#0ea5e9',
              emissive: '#0284c7',
              emissiveIntensity: 0.5,
              metalness: 0.65,
              roughness: 0.22,
            })
          );
          ufoTop.position.set(0, 0.10, 0);
          ufoTop.castShadow = true;
          ufoHeadGroup.add(ufoTop);

          const ufoRing = new THREE.Mesh(
            new THREE.TorusGeometry(0.438, 0.048, 12, 24),
            new THREE.MeshStandardMaterial({
              color: '#fbbf24',
              emissive: '#f59e0b',
              emissiveIntensity: 0.65,
            })
          );
          ufoRing.rotation.x = Math.PI / 2;
          ufoRing.position.set(0, -0.015, 0);
          ufoHeadGroup.add(ufoRing);
        }

        const armMetalMat = isPlushMachine
          ? new THREE.MeshStandardMaterial({
              color: '#f1f5f9',
              metalness: 0.96,
              roughness: 0.12,
            })
          : new THREE.MeshStandardMaterial({
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

        const debugWireMat = new THREE.MeshBasicMaterial({
          color: '#22c55e',
          wireframe: true,
          transparent: true,
          opacity: 0.75,
        });
        const debugMeshes: THREE.Object3D[] = [];

        const buildArmVisual = (side: -1 | 1, axis: 'x' | 'z' = 'x') => {
          const group = new THREE.Group();
          const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.12, 12), hingePinMat);
          if (axis === 'x') {
            pin.rotation.x = Math.PI / 2;
          } else {
            pin.rotation.z = Math.PI / 2;
          }
          group.add(pin);

          for (const seg of scaledArmSegments) {
            const geo =
              axis === 'x'
                ? new THREE.BoxGeometry(seg.half[0] * 2, seg.half[1] * 2, seg.half[2] * 2)
                : new THREE.BoxGeometry(seg.half[2] * 2, seg.half[1] * 2, seg.half[0] * 2);
            const mesh = new THREE.Mesh(geo, seg.isTip ? armTipMat : armMetalMat);
            if (axis === 'x') {
              mesh.position.set(side * seg.pos[0], seg.pos[1], seg.pos[2]);
              mesh.rotation.z = side * seg.rotZ;
            } else {
              mesh.position.set(seg.pos[2], seg.pos[1], side * seg.pos[0]);
              mesh.rotation.x = -side * seg.rotZ;
            }
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

        const leftArmVisual = buildArmVisual(-1, 'x');
        const rightArmVisual = buildArmVisual(1, 'x');
        const backArmVisual = isPlushMachine ? buildArmVisual(-1, 'z') : null;
        const frontArmVisual = isPlushMachine ? buildArmVisual(1, 'z') : null;

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
        if (isPlushMachine) {
          // 3D 인형뽑기에서 집게/헤드가 바닥판 및 ㄱ자 외벽을 뚫지 못하도록 물리 충돌 활성화
          objFilter.EnableCollision(LAYER_ARM, LAYER_BAR);
          objFilter.EnableCollision(LAYER_HEAD, LAYER_BAR);
        }

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
        Jolt.destroy(joltSettings);
        cleanupJolt = () => {
          try {
            Jolt.destroy(jolt);
          } catch {}
        };
        const ps = jolt.GetPhysicsSystem();
        ps.SetGravity(new Jolt.Vec3(0, -9.81, 0));
        const bi = ps.GetBodyInterface();

        // 4 Parallel Bars + Physical Silicone Rings
        const qBar = Jolt.Quat.prototype.sRotation(new Jolt.Vec3(0, 0, 1), Math.PI / 2);
        const redBarBodyEntries: Array<{ id: JoltNS.BodyID; sign: -1 | 1 }> = [];
        const redRingBodyIds: JoltNS.BodyID[] = [];
        const redRingBodyEntries: Array<{ id: JoltNS.BodyID; x: number; sign: -1 | 1 }> = [];
        allBarSpecs.forEach(({ y: by, z: bz, isOuter, sign }) => {
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
          const barBody = bi.CreateBody(bcs);
          bi.AddBody(barBody.GetID(), Jolt.EActivation_DontActivate);
          if (!isOuter) redBarBodyEntries.push({ id: barBody.GetID(), sign });

          for (const rx of ringXPositions) {
            const ringShape = new Jolt.CylinderShape(0.022, GACHA_PHYSICS.BAR_RADIUS + 0.006, 0.008);
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
            if (!isOuter) {
              redRingBodyIds.push(rb.GetID());
              redRingBodyEntries.push({ id: rb.GetID(), x: rx, sign });
            }
          }
        });

        if (isPlushMachine) {
          for (const s of plushFloorSlabs) {
            const slabBCS = new Jolt.BodyCreationSettings(
              new Jolt.BoxShape(new Jolt.Vec3(s.w / 2, s.h / 2, s.d / 2), 0.015),
              new Jolt.RVec3(s.cx, s.cy, s.cz),
              Jolt.Quat.prototype.sIdentity(),
              Jolt.EMotionType_Static,
              LAYER_BAR
            );
            slabBCS.mFriction = 0.55;
            slabBCS.mRestitution = 0.0;
            bi.AddBody(bi.CreateBody(slabBCS).GetID(), Jolt.EActivation_DontActivate);
          }
          for (const g of plushChuteGuards) {
            const guardBCS = new Jolt.BodyCreationSettings(
              new Jolt.BoxShape(new Jolt.Vec3(g.w / 2, g.h / 2, g.d / 2), 0.01),
              new Jolt.RVec3(g.cx, g.cy, g.cz),
              Jolt.Quat.prototype.sIdentity(),
              Jolt.EMotionType_Static,
              LAYER_BAR
            );
            guardBCS.mFriction = 0.22;
            guardBCS.mRestitution = 0.0;
            bi.AddBody(bi.CreateBody(guardBCS).GetID(), Jolt.EActivation_DontActivate);
          }
        }

        [-GACHA_PHYSICS.CABINET_HALF_X - 0.1, GACHA_PHYSICS.CABINET_HALF_X + 0.1].forEach((wx) => {
          const wallBCS = new Jolt.BodyCreationSettings(
            new Jolt.BoxShape(new Jolt.Vec3(0.1, 2.5, 2.3), 0.02),
            new Jolt.RVec3(wx, 1.2, 0),
            Jolt.Quat.prototype.sIdentity(),
            Jolt.EMotionType_Static,
            LAYER_ENV
          );
          wallBCS.mFriction = 0.25;
          wallBCS.mRestitution = 0.0;
          bi.AddBody(bi.CreateBody(wallBCS).GetID(), Jolt.EActivation_DontActivate);
        });

        if (isPlushMachine) {
          [-1.92, 1.92].forEach((wz) => {
            const fbBCS = new Jolt.BodyCreationSettings(
              new Jolt.BoxShape(new Jolt.Vec3(GACHA_PHYSICS.CABINET_HALF_X + 0.12, 1.55, 0.08), 0.02),
              new Jolt.RVec3(0, 1.35, wz),
              Jolt.Quat.prototype.sIdentity(),
              Jolt.EMotionType_Static,
              LAYER_ENV
            );
            fbBCS.mFriction = 0.22;
            fbBCS.mRestitution = 0.0;
            bi.AddBody(bi.CreateBody(fbBCS).GetID(), Jolt.EActivation_DontActivate);
          });
        } else {
          const frontRampBCS = new Jolt.BodyCreationSettings(
            new Jolt.BoxShape(new Jolt.Vec3(GACHA_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
            new Jolt.RVec3(0, 1.24, 1.86),
            Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), -0.72),
            Jolt.EMotionType_Static,
            LAYER_ENV
          );
          frontRampBCS.mFriction = 0.22;
          frontRampBCS.mRestitution = 0.0;
          bi.AddBody(bi.CreateBody(frontRampBCS).GetID(), Jolt.EActivation_DontActivate);

          const backRampBCS = new Jolt.BodyCreationSettings(
            new Jolt.BoxShape(new Jolt.Vec3(GACHA_PHYSICS.BAR_LENGTH / 2, 0.03, 0.42), 0.01),
            new Jolt.RVec3(0, 1.24, -1.86),
            Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), 0.72),
            Jolt.EMotionType_Static,
            LAYER_ENV
          );
          backRampBCS.mFriction = 0.22;
          backRampBCS.mRestitution = 0.0;
          bi.AddBody(bi.CreateBody(backRampBCS).GetID(), Jolt.EActivation_DontActivate);
        }

        const floorBCS = new Jolt.BodyCreationSettings(
          new Jolt.BoxShape(new Jolt.Vec3(2.2, 0.1, 2.3), 0.02),
          new Jolt.RVec3(0, -1.55, 0),
          Jolt.Quat.prototype.sIdentity(),
          Jolt.EMotionType_Static,
          LAYER_ENV
        );
        floorBCS.mFriction = 0.55;
        floorBCS.mRestitution = 0.05;
        bi.AddBody(bi.CreateBody(floorBCS).GetID(), Jolt.EActivation_DontActivate);

        // 5. Real Articulated UFO Crane Rig (Gantry ↔ SixDOF ↔ Head ↔ 2× or 4× Hinge ↔ Claw Arms)
        const homeX = isPlushMachine ? PLUSH_CHUTE_HOME_X : GACHA_PHYSICS.CLAW_HOME_X;
        const homeY = isPlushMachine ? effectiveLiftY : GACHA_PHYSICS.CLAW_HOME_Y;
        const homeZ = isPlushMachine ? PLUSH_CHUTE_HOME_Z : GACHA_PHYSICS.CLAW_HOME_Z;

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
          new Jolt.CylinderShape(0.125 * headScale, 0.36 * headScale, 0.02),
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
        sixSettings.SetLimitedAxis(
          Jolt.SixDOFConstraintSettings_EAxis_TranslationY,
          isPlushMachine ? -3.05 : -2.55,
          isPlushMachine ? 0.22 : 0.18
        );
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

        const createClawArm = (side: -1 | 1, axis: 'x' | 'z' = 'x') => {
          const comp = new Jolt.StaticCompoundShapeSettings();
          for (const seg of scaledArmSegments) {
            if (axis === 'x') {
              comp.AddShape(
                new Jolt.Vec3(side * seg.pos[0], seg.pos[1], seg.pos[2]),
                Jolt.Quat.prototype.sRotation(new Jolt.Vec3(0, 0, 1), side * seg.rotZ),
                new Jolt.BoxShapeSettings(new Jolt.Vec3(seg.half[0], seg.half[1], seg.half[2]), 0.008),
                0
              );
            } else {
              comp.AddShape(
                new Jolt.Vec3(seg.pos[2], seg.pos[1], side * seg.pos[0]),
                Jolt.Quat.prototype.sRotation(new Jolt.Vec3(1, 0, 0), -side * seg.rotZ),
                new Jolt.BoxShapeSettings(new Jolt.Vec3(seg.half[2], seg.half[1], seg.half[0]), 0.008),
                0
              );
            }
          }
          const shapeRes = comp.Create();
          const pivotX = axis === 'x' ? homeX + side * armPivotX : homeX;
          const pivotY = homeY - 0.02;
          const pivotZ = axis === 'z' ? homeZ + side * armPivotX : homeZ;
          const abcs = new Jolt.BodyCreationSettings(
            shapeRes.Get(),
            new Jolt.RVec3(pivotX, pivotY, pivotZ),
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

          const openSign = axis === 'x' ? side : -side;
          const hs = new Jolt.HingeConstraintSettings();
          hs.mSpace = Jolt.EConstraintSpace_WorldSpace;
          hs.mPoint1 = new Jolt.RVec3(pivotX, pivotY, pivotZ);
          hs.mPoint2 = new Jolt.RVec3(pivotX, pivotY, pivotZ);
          hs.mHingeAxis1 = axis === 'x' ? new Jolt.Vec3(0, 0, 1) : new Jolt.Vec3(1, 0, 0);
          hs.mHingeAxis2 = axis === 'x' ? new Jolt.Vec3(0, 0, 1) : new Jolt.Vec3(1, 0, 0);
          hs.mNormalAxis1 = axis === 'x' ? new Jolt.Vec3(1, 0, 0) : new Jolt.Vec3(0, 0, 1);
          hs.mNormalAxis2 = axis === 'x' ? new Jolt.Vec3(1, 0, 0) : new Jolt.Vec3(0, 0, 1);
          hs.mLimitsMin = openSign > 0 ? -0.10 : -1.18;
          hs.mLimitsMax = openSign > 0 ? 1.18 : 0.10;
          const hc = Jolt.castObject(hs.Create(headBody, armBody), Jolt.HingeConstraint);
          ps.AddConstraint(hc);

          const hm = hc.GetMotorSettings();
          hm.mSpringSettings.mMode = Jolt.ESpringMode_FrequencyAndDamping;
          hm.mSpringSettings.mFrequency = 11;
          hm.mSpringSettings.mDamping = 0.92;
          hm.mMinTorqueLimit = -tuning.closeTorque;
          hm.mMaxTorqueLimit = tuning.closeTorque;
          hc.SetMotorState(Jolt.EMotorState_Position);
          hc.SetTargetAngle(openSign * CLAW_OPEN_ANGLE);

          return { body: armBody, hinge: hc, openSign };
        };

        const leftArm = createClawArm(-1, 'x');
        const rightArm = createClawArm(1, 'x');
        const backArm = isPlushMachine ? createClawArm(-1, 'z') : null;
        const frontArm = isPlushMachine ? createClawArm(1, 'z') : null;
        const allArms = [leftArm, rightArm, ...(backArm ? [backArm] : []), ...(frontArm ? [frontArm] : [])];

        // 6. 동적 상품 맵 (MongoDB GachaBoxItem[] 1:1 동기화)
        interface PrizeEntity {
          data: GachaBoxItem;
          mesh: THREE.Mesh;
          debugGroup: THREE.Group;
          body: JoltNS.Body;
          sharedVisual?: boolean;
        }
        const prizeEntities = new Map<string, PrizeEntity>();
        const sharedPlushMatBySrc = new Map<string, THREE.MeshStandardMaterial>();
        const sharedPlushGeoBySrc = new Map<string, THREE.BufferGeometry>();
        const sharedPlushLoadingSrc = new Set<string>();

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

        const syncFromItems = (nextItems: GachaBoxItem[], forceRecreate = false) => {
          const nextIds = new Set(nextItems.map((it) => it.id));

          for (const [id, ent] of prizeEntities.entries()) {
            if (forceRecreate || !nextIds.has(id)) {
              bi.RemoveBody(ent.body.GetID());
              bi.DestroyBody(ent.body.GetID());
              scene.remove(ent.mesh);
              scene.remove(ent.debugGroup);
              if (!ent.sharedVisual) {
                ent.mesh.geometry.dispose();
                if (Array.isArray(ent.mesh.material)) {
                  ent.mesh.material.forEach((m) => m.dispose());
                } else {
                  ent.mesh.material.dispose();
                }
              }
              prizeEntities.delete(id);
            }
          }

          const liveTuning = tuningRef.current;

          for (const it of nextItems) {
            let ent = prizeEntities.get(it.id);
            if (!ent) {
              const dims = getBoxDimensions(it.slotIndex);
              const spec = getSpecForSlot(it.slotIndex);
              const plushItem = isPlushSlot(it.slotIndex);
              const debugGroup = new THREE.Group();
              debugGroup.visible = liveTuning.showColliders;
              scene.add(debugGroup);

              let mesh: THREE.Mesh;
              let shapeRef: JoltNS.Shape;

              if (plushItem) {
                let plushMat = sharedPlushMatBySrc.get(spec.imgSrc);
                if (!plushMat) {
                  plushMat = createPlushMaterial(spec.imgSrc);
                  sharedPlushMatBySrc.set(spec.imgSrc, plushMat);
                }
                const geoSrc = spec.plushGeoSrc || '/assets/sandrone_plush_geo.json';
                let sharedGeo = sharedPlushGeoBySrc.get(geoSrc);
                if (!sharedGeo) {
                  const cachedGeo = cachedPlushGeoMap.get(geoSrc);
                  sharedGeo = cachedGeo
                    ? buildBufferGeometryFromPlushData(cachedGeo)
                    : new THREE.BoxGeometry(dims.w * 0.7, dims.h, dims.d * 0.85);
                  sharedPlushGeoBySrc.set(geoSrc, sharedGeo);
                }
                mesh = new THREE.Mesh(sharedGeo, plushMat);
                mesh.scale.setScalar(PLUSH_MOUND_SCALE);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);

                if (!cachedPlushGeoMap.get(geoSrc) && !sharedPlushLoadingSrc.has(geoSrc)) {
                  sharedPlushLoadingSrc.add(geoSrc);
                  loadPlushGeoData(geoSrc).then((geoData) => {
                    if (!geoData || disposed) return;
                    const nextGeo = buildBufferGeometryFromPlushData(geoData);
                    const oldGeo = sharedPlushGeoBySrc.get(geoSrc);
                    sharedPlushGeoBySrc.set(geoSrc, nextGeo);
                    for (const liveEnt of prizeEntities.values()) {
                      if (isPlushSlot(liveEnt.data.slotIndex)) {
                        const s = getSpecForSlot(liveEnt.data.slotIndex);
                        if ((s.plushGeoSrc || '/assets/sandrone_plush_geo.json') === geoSrc) {
                          liveEnt.mesh.geometry = nextGeo;
                          liveEnt.mesh.scale.setScalar(PLUSH_MOUND_SCALE);
                        }
                      }
                    }
                    if (oldGeo && oldGeo !== nextGeo) oldGeo.dispose();
                  });
                }

                const parts =
                  spec.plushParts && spec.plushParts.length > 0
                    ? spec.plushParts
                    : [
                        { pos: [0.05, 0, 0.02] as [number, number, number], half: [0.28, 0.21, 0.50] as [number, number, number], w: 0.45 },
                        { pos: [0.04, 0, -0.44] as [number, number, number], half: [0.19, 0.18, 0.20] as [number, number, number], w: 0.20 },
                        { pos: [-0.30, 0, 0.24] as [number, number, number], half: [0.15, 0.16, 0.30] as [number, number, number], w: 0.18 },
                        { pos: [0.30, 0, 0.22] as [number, number, number], half: [0.14, 0.17, 0.28] as [number, number, number], w: 0.17 },
                      ];
                const comp = new Jolt.StaticCompoundShapeSettings();
                for (const p of parts) {
                  const px = p.pos[0] * PLUSH_MOUND_SCALE;
                  const py = p.pos[1] * PLUSH_MOUND_SCALE;
                  const pz = p.pos[2] * PLUSH_MOUND_SCALE;
                  const hx = p.half[0] * PLUSH_MOUND_SCALE;
                  const hy = p.half[1] * PLUSH_MOUND_SCALE;
                  const hz = p.half[2] * PLUSH_MOUND_SCALE;
                  comp.AddShape(
                    new Jolt.Vec3(px, py, pz),
                    tmpIdQuat,
                    new Jolt.BoxShapeSettings(new Jolt.Vec3(hx, hy, hz), 0.015),
                    0
                  );
                  const wf = new THREE.Mesh(
                    new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
                    debugWireMat
                  );
                  wf.position.set(px, py, pz);
                  debugGroup.add(wf);
                }
                if (liveTuning.useComOffset) {
                  const comWrap = new Jolt.OffsetCenterOfMassShapeSettings(
                    new Jolt.Vec3(
                      spec.comOffset[0] * PLUSH_MOUND_SCALE,
                      spec.comOffset[1] * PLUSH_MOUND_SCALE,
                      spec.comOffset[2] * PLUSH_MOUND_SCALE
                    ),
                    comp
                  );
                  shapeRef = comWrap.Create().Get();
                } else {
                  shapeRef = comp.Create().Get();
                }
              } else {
                const mats = createFigureBoxMaterials(it.slotIndex, it.label);
                mesh = new THREE.Mesh(new THREE.BoxGeometry(dims.w, dims.h, dims.d), mats);
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                scene.add(mesh);

                debugGroup.add(new THREE.Mesh(new THREE.BoxGeometry(dims.w, dims.h, dims.d), debugWireMat));

                const boxShapeSettings = new Jolt.BoxShapeSettings(
                  new Jolt.Vec3(dims.w / 2, dims.h / 2, dims.d / 2),
                  0.015
                );
                if (liveTuning.useComOffset) {
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
                new Jolt.RVec3(it.position[0], it.position[1], it.position[2]),
                new Jolt.Quat(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]),
                Jolt.EMotionType_Dynamic,
                LAYER_PRIZE
              );
              bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
              bcs.mMassPropertiesOverride.mMass = Math.max(
                0.35,
                (plushItem ? spec.mass * 0.72 : spec.mass) * liveTuning.massScale
              );
              bcs.mFriction = spec.friction;
              bcs.mRestitution = 0.0;
              bcs.mLinearDamping = plushItem ? 0.28 : 0.18;
              bcs.mAngularDamping = plushItem ? 0.40 : 0.28;
              bcs.mMotionQuality = plushItem
                ? Jolt.EMotionQuality_Discrete
                : Jolt.EMotionQuality_LinearCast;
              bcs.mAllowSleeping = true;
              const body = bi.CreateBody(bcs);
              bi.AddBody(body.GetID(), Jolt.EActivation_DontActivate);

              ent = { data: { ...it }, mesh, debugGroup, body, sharedVisual: plushItem };
              prizeEntities.set(it.id, ent);
            }

            ent.data = { ...it };
            tmpRVec.Set(it.position[0], it.position[1], it.position[2]);
            tmpQuat.Set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
            bi.SetPositionAndRotation(ent.body.GetID(), tmpRVec, tmpQuat, Jolt.EActivation_DontActivate);
            bi.SetLinearAndAngularVelocity(ent.body.GetID(), tmpZeroVec, tmpZeroVec);

            ent.mesh.position.set(it.position[0], it.position[1], it.position[2]);
            ent.mesh.quaternion.set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
            ent.debugGroup.position.copy(ent.mesh.position);
            ent.debugGroup.quaternion.copy(ent.mesh.quaternion);
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
          nearNearTriggeredThisTurn: false,
          lastHeadYForStall: homeY,
          descendStallTimer: 0,
          liftTopHoldTimer: 0,
          carryStopHoldTimer: 0,
          releaseClearTimer: 0,
        };

        const setArmTorques = (maxTorque: number) => {
          for (const a of allArms) {
            const m = a.hinge.GetMotorSettings();
            m.mMinTorqueLimit = -maxTorque;
            m.mMaxTorqueLimit = maxTorque;
          }
        };

        const setArmTargets = (openRad: number) => {
          for (const a of allArms) {
            a.hinge.SetTargetAngle(a.openSign * openRad);
          }
        };

        const resetClawToHome = () => {
          sim.gantryX = homeX;
          sim.gantryZ = homeZ;
          sim.targetHeadY = homeY;
          sim.phaseTimer = 0;
          sim.settleQuietTime = 0;
          sim.wonSet.clear();
          sim.effectTriggeredThisTurn = false;
          sim.nearNearTriggeredThisTurn = false;
          sim.descendStallTimer = 0;
          sim.liftTopHoldTimer = 0;
          sim.carryStopHoldTimer = 0;
          sim.releaseClearTimer = 0;

          tmpRVec.Set(homeX, homeY, homeZ);
          bi.SetPositionAndRotation(gantryBody.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetPositionAndRotation(headBody.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(headBody.GetID(), tmpZeroVec, tmpZeroVec);

          tmpRVec.Set(homeX - armPivotX, homeY - 0.02, homeZ);
          bi.SetPositionAndRotation(leftArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(leftArm.body.GetID(), tmpZeroVec, tmpZeroVec);

          tmpRVec.Set(homeX + armPivotX, homeY - 0.02, homeZ);
          bi.SetPositionAndRotation(rightArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
          bi.SetLinearAndAngularVelocity(rightArm.body.GetID(), tmpZeroVec, tmpZeroVec);

          if (backArm) {
            tmpRVec.Set(homeX, homeY - 0.02, homeZ - armPivotX);
            bi.SetPositionAndRotation(backArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
            bi.SetLinearAndAngularVelocity(backArm.body.GetID(), tmpZeroVec, tmpZeroVec);
          }
          if (frontArm) {
            tmpRVec.Set(homeX, homeY - 0.02, homeZ + armPivotX);
            bi.SetPositionAndRotation(frontArm.body.GetID(), tmpRVec, tmpIdQuat, Jolt.EActivation_Activate);
            bi.SetLinearAndAngularVelocity(frontArm.body.GetID(), tmpZeroVec, tmpZeroVec);
          }

          tmpVec.Set(0, 0, 0);
          sixConstraint.SetTargetPositionCS(tmpVec);
          setArmTorques(tuningRef.current.closeTorque);
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
          setArmTorques(tuningRef.current.descendFlexTorque);
          setArmTargets(CLAW_OPEN_ANGLE);
          motorY.mMinForceLimit = -tuningRef.current.downPressForce;
          setCranePhase('descending');
          playTone(640, 0.12);
        };

        const applyLiveTuning = (t: PhysicsTuning) => {
          motorY.mMinForceLimit = -t.downPressForce;
          for (const a of allArms) {
            bi.SetFriction(a.body.GetID(), t.clawTipFriction);
          }
          for (const rid of redRingBodyIds) {
            bi.SetFriction(rid, t.barRingFriction);
          }
          for (const dm of debugMeshes) {
            dm.visible = t.showColliders;
          }
          for (const ent of prizeEntities.values()) {
            ent.debugGroup.visible = t.showColliders;
          }
        };

        const rebuildPrizesForTuning = () => {
          if (prizeEntities.size === 0) return;
          const liveItems: GachaBoxItem[] = Array.from(prizeEntities.values()).map((ent) => {
            const p = ent.body.GetPosition();
            const q = ent.body.GetRotation();
            return {
              ...ent.data,
              position: [p.GetX(), p.GetY(), p.GetZ()],
              quaternion: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
            };
          });
          syncFromItems(liveItems, true);
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
            const movedSlightly =
              Math.hypot(px - startPos[0], pz - startPos[2]) > 0.008 ||
              Math.abs(py - startPos[1]) > 0.015;
            const quatDot = Math.abs(
              qx * startQuat[0] + qy * startQuat[1] + qz * startQuat[2] + qw * startQuat[3]
            );
            const nextIsInitial = wasInitial && !movedSlightly && quatDot >= 0.9998;
            ent.data.isInitialState = nextIsInitial;

            return {
              id: ent.data.id,
              position: [px, py, pz] as [number, number, number],
              quaternion: [qx, qy, qz, qw] as [number, number, number, number],
              isInitialState: nextIsInitial,
            };
          });

          setCranePhase('idle');
          if (!sandboxModeRef.current) {
            fetch('/api/gacha/live', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ clear: true, machineIndex: machineIndexRef.current }),
            }).catch(() => {});
          }
          onTurnFinishRef.current({
            wonItemIds,
            updatedItems,
            actionSummary: wonItemIds.length > 0 ? `${wonItemIds.length}개 획득` : '위치 이동',
          });
        };

        const updateRedBarSpacing = (halfZ: number) => {
          redBarHalfZRef.current = halfZ;
          for (const item of redBarMeshes) {
            item.mesh.position.z = item.sign * halfZ;
          }
          for (const item of redRingMeshes) {
            item.mesh.position.z = item.sign * halfZ;
          }
          for (const entry of redBarBodyEntries) {
            tmpRVec.Set(0, GACHA_PHYSICS.BAR_Y, entry.sign * halfZ);
            bi.SetPosition(entry.id, tmpRVec, Jolt.EActivation_DontActivate);
          }
          for (const entry of redRingBodyEntries) {
            tmpRVec.Set(entry.x, GACHA_PHYSICS.BAR_Y, entry.sign * halfZ);
            bi.SetPosition(entry.id, tmpRVec, Jolt.EActivation_DontActivate);
          }
        };

        simControlRef.current = {
          syncFromItems: (nextItems) => {
            if (disposed) return;
            syncFromItems(nextItems, false);
          },
          resetClawToHome: () => {
            if (disposed) return;
            resetClawToHome();
          },
          prepareTurnStart: (nextItems) => {
            if (disposed) return;
            prepareTurnStart(nextItems);
          },
          startDescending: () => {
            if (disposed) return;
            startDescending();
          },
          applyLiveTuning: (t) => {
            if (disposed) return;
            applyLiveTuning(t);
          },
          rebuildPrizesForTuning: () => {
            if (disposed) return;
            rebuildPrizesForTuning();
          },
          updateRedBarSpacing: (halfZ) => {
            if (disposed) return;
            updateRedBarSpacing(halfZ);
          },
        };

        syncFromItems(itemsRef.current);
        resetClawToHome();
        setEngineReady(true);

        // 8. Main Animation + Jolt 120Hz Physics Loop
        let lastTime = performance.now();
        const tmpSpecPos = new THREE.Vector3();
        const tmpSpecQuat = new THREE.Quaternion();

        const animate = (now: number) => {
          if (disposed) return;
          animId = requestAnimationFrame(animate);
          const rawDt = Math.min((now - lastTime) / 1000, 0.04);
          lastTime = now;
          const dt = rawDt * Math.max(0.25, Math.min(1.5, tuningRef.current.timeScale));

          // 실시간 관전 모드: 다른 플레이어로부터 수신한 라이브 좌표를 부드럽게 보간 렌더링
          if (!sandboxModeRef.current && Boolean(lockedByOtherRef.current) && !isMyTurnRef.current && spectateFrameRef.current) {
            const sf = spectateFrameRef.current;
            const sAlpha = Math.min(1, rawDt * 18);

            tmpSpecPos.set(sf.headPos[0], sf.headPos[1], sf.headPos[2]);
            tmpSpecQuat.set(sf.headQuat[0], sf.headQuat[1], sf.headQuat[2], sf.headQuat[3]);
            ufoHeadGroup.position.lerp(tmpSpecPos, sAlpha);
            ufoHeadGroup.quaternion.slerp(tmpSpecQuat, sAlpha);

            tmpSpecPos.set(sf.leftArmPos[0], sf.leftArmPos[1], sf.leftArmPos[2]);
            tmpSpecQuat.set(sf.leftArmQuat[0], sf.leftArmQuat[1], sf.leftArmQuat[2], sf.leftArmQuat[3]);
            leftArmVisual.position.lerp(tmpSpecPos, sAlpha);
            leftArmVisual.quaternion.slerp(tmpSpecQuat, sAlpha);

            tmpSpecPos.set(sf.rightArmPos[0], sf.rightArmPos[1], sf.rightArmPos[2]);
            tmpSpecQuat.set(sf.rightArmQuat[0], sf.rightArmQuat[1], sf.rightArmQuat[2], sf.rightArmQuat[3]);
            rightArmVisual.position.lerp(tmpSpecPos, sAlpha);
            rightArmVisual.quaternion.slerp(tmpSpecQuat, sAlpha);

            if (backArmVisual && sf.backArmPos && sf.backArmQuat) {
              tmpSpecPos.set(sf.backArmPos[0], sf.backArmPos[1], sf.backArmPos[2]);
              tmpSpecQuat.set(sf.backArmQuat[0], sf.backArmQuat[1], sf.backArmQuat[2], sf.backArmQuat[3]);
              backArmVisual.position.lerp(tmpSpecPos, sAlpha);
              backArmVisual.quaternion.slerp(tmpSpecQuat, sAlpha);
            }
            if (frontArmVisual && sf.frontArmPos && sf.frontArmQuat) {
              tmpSpecPos.set(sf.frontArmPos[0], sf.frontArmPos[1], sf.frontArmPos[2]);
              tmpSpecQuat.set(sf.frontArmQuat[0], sf.frontArmQuat[1], sf.frontArmQuat[2], sf.frontArmQuat[3]);
              frontArmVisual.position.lerp(tmpSpecPos, sAlpha);
              frontArmVisual.quaternion.slerp(tmpSpecQuat, sAlpha);
            }

            gantryBeam.position.z = THREE.MathUtils.lerp(gantryBeam.position.z, sf.gantryZ, sAlpha);
            trolleyMesh.position.set(
              THREE.MathUtils.lerp(trolleyMesh.position.x, sf.gantryX, sAlpha),
              3.82,
              gantryBeam.position.z
            );

            tmpThreePosA.set(trolleyMesh.position.x, 3.79, trolleyMesh.position.z);
            tmpThreePosB.set(ufoHeadGroup.position.x, ufoHeadGroup.position.y + 0.22, ufoHeadGroup.position.z);
            tmpThreeDir.subVectors(tmpThreePosB, tmpThreePosA);
            const cableLenSpec = Math.max(0.08, tmpThreeDir.length());
            cableMesh.scale.set(1, cableLenSpec, 1);
            cableMesh.position.lerpVectors(tmpThreePosA, tmpThreePosB, 0.5);
            tmpThreeDir.normalize();
            tmpThreeQuat.setFromUnitVectors(tmpThreeUp, tmpThreeDir);
            cableMesh.quaternion.copy(tmpThreeQuat);

            const specShowAim =
              sf.phase === 'ready_right' ||
              sf.phase === 'moving_right' ||
              sf.phase === 'ready_up' ||
              sf.phase === 'moving_up';
            aimRing.visible = specShowAim;
            aimBeam.visible = specShowAim;
            if (specShowAim) {
              aimRing.position.set(ufoHeadGroup.position.x, GACHA_PHYSICS.BAR_Y + 0.12, ufoHeadGroup.position.z);
              const beamH = Math.max(0.2, ufoHeadGroup.position.y - (GACHA_PHYSICS.BAR_Y + 0.12));
              aimBeam.scale.y = beamH / 1.7;
              aimBeam.position.set(ufoHeadGroup.position.x, GACHA_PHYSICS.BAR_Y + 0.12 + beamH / 2, ufoHeadGroup.position.z);
            }

            for (const it of sf.items) {
              const ent = prizeEntities.get(it.id);
              if (ent) {
                tmpSpecPos.set(it.position[0], it.position[1], it.position[2]);
                tmpSpecQuat.set(it.quaternion[0], it.quaternion[1], it.quaternion[2], it.quaternion[3]);
                ent.mesh.position.lerp(tmpSpecPos, sAlpha);
                ent.mesh.quaternion.slerp(tmpSpecQuat, sAlpha);
              }
            }

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
            renderer!.render(scene, camera);
            return;
          }

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
              effectiveDropY,
              sim.targetHeadY - 0.64 * dt
            );

            const actualHeadY = headBody.GetPosition().GetY();
            if (actualHeadY - sim.targetHeadY > 0.14 && Math.abs(actualHeadY - sim.lastHeadYForStall) < 0.015) {
              sim.descendStallTimer += dt;
            } else {
              sim.descendStallTimer = 0;
              sim.lastHeadYForStall = actualHeadY;
            }

            if (sim.targetHeadY <= effectiveDropY || sim.descendStallTimer >= 0.45) {
              sim.phaseTimer = 0;
              setArmTorques(tuningRef.current.closeTorque);
              setCranePhase('closing');
              playTone(330, 0.1, 'square', 0.05);
            }
          } else if (curPhase === 'closing') {
            sim.phaseTimer += dt;
            const prog = Math.min(1, sim.phaseTimer / 0.52);
            const activeCloseTarget = isPlushMachine ? -0.02 : CLAW_CLOSE_TARGET;
            const targetAng = CLAW_OPEN_ANGLE * (1 - prog) + activeCloseTarget * prog;
            setArmTargets(targetAng);

            if (sim.phaseTimer >= 0.62) {
              sim.phaseTimer = 0;
              sim.liftTopHoldTimer = 0;
              sim.releaseClearTimer = 0;
              sim.effectTriggeredThisTurn = false;
              sim.liftStartY.clear();
              for (const ent of prizeEntities.values()) {
                sim.liftStartY.set(ent.data.id, ent.body.GetPosition().GetY());
              }
              setArmTorques(tuningRef.current.liftTorque);
              setArmTargets(activeCloseTarget);
              setCranePhase('lifting');
              playTone(587.33, 0.12);
            }
          } else if (curPhase === 'lifting') {
            sim.phaseTimer += dt;
            const prevTargetY = sim.targetHeadY;
            sim.targetHeadY = Math.min(
              effectiveLiftY,
              sim.targetHeadY + 0.58 * dt
            );

            // 실제 물리적 리프트 감지 -> Balance Catch! (초기 원위치 정중앙) / 극한 드르륵! (비초기 중앙 빨간 Bar 근처)
            if (!isPlushMachine && !sim.effectTriggeredThisTurn && sim.phaseTimer >= 0.12) {
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
                    const activeRedHalfZ = redBarHalfZRef.current;
                    const nearCentralRedBar =
                      Math.abs(hz - activeRedHalfZ) <= 0.28 ||
                      Math.abs(hz + activeRedHalfZ) <= 0.28;
                    if (nearCentralRedBar) {
                      sim.effectTriggeredThisTurn = true;
                      triggerExtremeDrr();
                      break;
                    }
                  }
                }
              }
            }

            const reachedTop = prevTargetY >= effectiveLiftY - 0.005;
            if (reachedTop) sim.liftTopHoldTimer += dt;
            else sim.liftTopHoldTimer = 0;

            // 최고점 도달 후 상승 관성이 잠잠해질 때까지(0.22s) 잠깐 정지한 뒤:
            // - 3D 인형 산더미 모드: 집게를 문 상태 그대로 배출구(초기 위치)까지 운반(carrying)
            // - 하시와타시 박스 모드: 제자리에서 집게 벌림(releasing)
            if ((reachedTop && sim.liftTopHoldTimer >= 0.22) || sim.phaseTimer >= 4.4) {
              sim.phaseTimer = 0;
              if (isPlushMachine) {
                sim.carryStopHoldTimer = 0;
                setArmTorques(tuningRef.current.liftTorque);
                setArmTargets(-0.02);
                setCranePhase('carrying');
                playTone(493.88, 0.1);
              } else {
                sim.releaseClearTimer = 0;
                setArmTorques(Math.max(12, tuningRef.current.liftTorque * 2.2));
                setCranePhase('releasing');
                playTone(392, 0.1);
              }
            }
          } else if (curPhase === 'carrying') {
            // 3D 인형뽑기 전용: 집게가 물고 있는 상태를 유지하며 배출구(초기 위치)까지 부드럽게 운반
            sim.phaseTimer += dt;
            sim.targetHeadY = effectiveLiftY;
            setArmTorques(tuningRef.current.liftTorque);
            setArmTargets(-0.02);

            const dx = homeX - sim.gantryX;
            const dz = homeZ - sim.gantryZ;
            const dist = Math.hypot(dx, dz);
            const carrySpeed = 1.15;
            if (dist > 0.025) {
              const step = Math.min(dist, carrySpeed * dt);
              sim.gantryX += (dx / dist) * step;
              sim.gantryZ += (dz / dist) * step;
              sim.carryStopHoldTimer = 0;
            } else {
              sim.gantryX = homeX;
              sim.gantryZ = homeZ;
              sim.carryStopHoldTimer += dt;
            }

            if (sim.carryStopHoldTimer >= 0.22 || sim.phaseTimer >= 4.5) {
              sim.phaseTimer = 0;
              sim.releaseClearTimer = 0;
              setArmTorques(Math.max(12, tuningRef.current.liftTorque * 2.2));
              setCranePhase('releasing');
              playTone(392, 0.1);
            }
          } else if (curPhase === 'releasing') {
            // 크레인 X/Z 제자리 완전 고정 상태에서 집게를 끝까지 넓게 벌려 상품이 완전히 낙하·이탈한 뒤에만 원위치 복귀
            sim.phaseTimer += dt;
            const openProg = Math.min(1, sim.phaseTimer / 0.62);
            const eased = openProg * openProg * (3 - 2 * openProg);
            const openAngle = CLAW_CLOSE_TARGET * (1 - eased) + CLAW_RELEASE_ANGLE * eased;
            setArmTargets(openAngle);

            // 집게가 충분히 벌어진 뒤에는 제자리에서 헤드만 수직으로 살짝 더 올려 여유 공간 확보
            if (sim.phaseTimer >= 0.68) {
              sim.targetHeadY = Math.min(homeY, sim.targetHeadY + 0.65 * dt);
            }

            const hpNow = headBody.GetPosition();
            let allPrizesClearedClaw = true;
            for (const ent of prizeEntities.values()) {
              if (sim.wonSet.has(ent.data.id)) continue;
              const pp = ent.body.GetPosition();
              const pv = ent.body.GetLinearVelocity();
              const horizDist = Math.hypot(pp.GetX() - hpNow.GetX(), pp.GetZ() - hpNow.GetZ());
              const stillNearClaw = pp.GetY() > hpNow.GetY() - 1.25;
              const stillFallingMidAir = pp.GetY() > (isPlushMachine ? 0.68 : 1.32) && Math.abs(pv.GetY()) > 0.2;
              if (horizDist < 1.25 && (stillNearClaw || stillFallingMidAir)) {
                allPrizesClearedClaw = false;
                break;
              }
            }

            if (sim.phaseTimer >= 0.72 && allPrizesClearedClaw) {
              sim.releaseClearTimer += dt;
            } else {
              sim.releaseClearTimer = 0;
            }

            if ((sim.phaseTimer >= 1.25 && sim.releaseClearTimer >= 0.35) || sim.phaseTimer >= 3.0) {
              sim.phaseTimer = 0;
              sim.settleQuietTime = 0;
              setArmTorques(Math.max(10, tuningRef.current.closeTorque));
              setArmTargets(CLAW_OPEN_ANGLE);
              setCranePhase('settling');
            }
          } else if (curPhase === 'settling') {
            sim.phaseTimer += dt;
            sim.gantryX += (homeX - sim.gantryX) * Math.min(1, 2.2 * dt);
            sim.gantryZ += (homeZ - sim.gantryZ) * Math.min(1, 2.2 * dt);
            sim.targetHeadY += (homeY - sim.targetHeadY) * Math.min(1, 4.0 * dt);

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
                ent.debugGroup.position.copy(ent.mesh.position);
                ent.debugGroup.quaternion.copy(ent.mesh.quaternion);

                if (!sim.wonSet.has(ent.data.id) && pp.GetY() < GACHA_PHYSICS.DROP_Y_THRESHOLD) {
                  sim.wonSet.add(ent.data.id);
                  setDroppedThisTurn(sim.wonSet.size);
                  triggerFinishWin();
                } else if (
                  !isPlushMachine &&
                  !sim.wonSet.has(ent.data.id) &&
                  !sim.nearNearTriggeredThisTurn &&
                  (curPhase === 'releasing' || curPhase === 'settling') &&
                  sim.phaseTimer >= 0.22
                ) {
                  const dims = getBoxDimensions(ent.data.slotIndex);
                  if (
                    isPrizeSpanningRedAndBlueBar(
                      { x: pp.GetX(), y: pp.GetY(), z: pp.GetZ() },
                      { x: pq.GetX(), y: pq.GetY(), z: pq.GetZ(), w: pq.GetW() },
                      dims,
                      GACHA_PHYSICS.DROP_Y_THRESHOLD,
                      redBarHalfZRef.current
                    )
                  ) {
                    sim.nearNearTriggeredThisTurn = true;
                    triggerNearNear();
                  }
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

          let bpArm: JoltNS.RVec3 | null = null;
          let bqArm: JoltNS.Quat | null = null;
          if (backArm && backArmVisual) {
            bpArm = backArm.body.GetPosition();
            bqArm = backArm.body.GetRotation();
            backArmVisual.position.set(bpArm.GetX(), bpArm.GetY(), bpArm.GetZ());
            backArmVisual.quaternion.set(bqArm.GetX(), bqArm.GetY(), bqArm.GetZ(), bqArm.GetW());
          }
          let fpArm: JoltNS.RVec3 | null = null;
          let fqArm: JoltNS.Quat | null = null;
          if (frontArm && frontArmVisual) {
            fpArm = frontArm.body.GetPosition();
            fqArm = frontArm.body.GetRotation();
            frontArmVisual.position.set(fpArm.GetX(), fpArm.GetY(), fpArm.GetZ());
            frontArmVisual.quaternion.set(fqArm.GetX(), fqArm.GetY(), fqArm.GetZ(), fqArm.GetW());
          }

          gantryBeam.position.z = sim.gantryZ;
          trolleyMesh.position.set(sim.gantryX, 3.82, sim.gantryZ);

          tmpThreePosA.set(sim.gantryX, 3.79, sim.gantryZ);
          tmpThreePosB.set(hp.GetX(), hp.GetY() + 0.22, hp.GetZ());
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
            const aimBaseY = isPlushMachine ? PLUSH_FLOOR_Y + PLUSH_CHUTE_WALL_HEIGHT : GACHA_PHYSICS.BAR_Y + 0.12;
            aimRing.position.set(hp.GetX(), aimBaseY, hp.GetZ());
            const beamH = Math.max(0.2, hp.GetY() - aimBaseY);
            aimBeam.scale.y = beamH / 1.7;
            aimBeam.position.set(hp.GetX(), aimBaseY + beamH / 2, hp.GetZ());
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

          // 실시간 관전 브로드캐스트 (~13fps, 비동기 non-blocking)
          if (
            !sandboxModeRef.current &&
            isMyTurnRef.current &&
            curPhase !== 'idle' &&
            !livePostInFlightRef.current &&
            now - lastLivePostTimeRef.current >= 75
          ) {
            lastLivePostTimeRef.current = now;
            livePostInFlightRef.current = true;
            const liveItems = Array.from(prizeEntities.values()).map((ent) => {
              const ep = ent.body.GetPosition();
              const eq = ent.body.GetRotation();
              return {
                id: ent.data.id,
                position: [
                  Number(ep.GetX().toFixed(3)),
                  Number(ep.GetY().toFixed(3)),
                  Number(ep.GetZ().toFixed(3)),
                ],
                quaternion: [
                  Number(eq.GetX().toFixed(4)),
                  Number(eq.GetY().toFixed(4)),
                  Number(eq.GetZ().toFixed(4)),
                  Number(eq.GetW().toFixed(4)),
                ],
              };
            });
            fetch('/api/gacha/live', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                machineIndex: machineIndexRef.current,
                turnKey: turnKeyRef.current || '',
                member: selectedMemberRef.current,
                phase: curPhase,
                gantryX: Number(sim.gantryX.toFixed(3)),
                gantryZ: Number(sim.gantryZ.toFixed(3)),
                headPos: [Number(hp.GetX().toFixed(3)), Number(hp.GetY().toFixed(3)), Number(hp.GetZ().toFixed(3))],
                headQuat: [Number(hq.GetX().toFixed(4)), Number(hq.GetY().toFixed(4)), Number(hq.GetZ().toFixed(4)), Number(hq.GetW().toFixed(4))],
                leftArmPos: [Number(lp.GetX().toFixed(3)), Number(lp.GetY().toFixed(3)), Number(lp.GetZ().toFixed(3))],
                leftArmQuat: [Number(lq.GetX().toFixed(4)), Number(lq.GetY().toFixed(4)), Number(lq.GetZ().toFixed(4)), Number(lq.GetW().toFixed(4))],
                rightArmPos: [Number(rp.GetX().toFixed(3)), Number(rp.GetY().toFixed(3)), Number(rp.GetZ().toFixed(3))],
                rightArmQuat: [Number(rq.GetX().toFixed(4)), Number(rq.GetY().toFixed(4)), Number(rq.GetZ().toFixed(4)), Number(rq.GetW().toFixed(4))],
                ...(bpArm && bqArm
                  ? {
                      backArmPos: [Number(bpArm.GetX().toFixed(3)), Number(bpArm.GetY().toFixed(3)), Number(bpArm.GetZ().toFixed(3))],
                      backArmQuat: [Number(bqArm.GetX().toFixed(4)), Number(bqArm.GetY().toFixed(4)), Number(bqArm.GetZ().toFixed(4)), Number(bqArm.GetW().toFixed(4))],
                    }
                  : {}),
                ...(fpArm && fqArm
                  ? {
                      frontArmPos: [Number(fpArm.GetX().toFixed(3)), Number(fpArm.GetY().toFixed(3)), Number(fpArm.GetZ().toFixed(3))],
                      frontArmQuat: [Number(fqArm.GetX().toFixed(4)), Number(fqArm.GetY().toFixed(4)), Number(fqArm.GetZ().toFixed(4)), Number(fqArm.GetW().toFixed(4))],
                    }
                  : {}),
                items: liveItems,
                effect: liveEffectRef.current.effect,
                effectSeq: liveEffectRef.current.seq,
              }),
            })
              .catch(() => {})
              .finally(() => {
                livePostInFlightRef.current = false;
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
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => handleResize?.()) : null;
        if (ro && container) ro.observe(container);
        (container as any).__joltRo = ro;
      })
      .catch((err) => {
        console.error('Jolt Physics init failed:', err);
        if (!disposed) setEngineError(String(err?.message || err));
      });

    return () => {
      disposed = true;
      simControlRef.current = null;
      cancelAnimationFrame(animId);
      if (handleResize) window.removeEventListener('resize', handleResize);
      try {
        (container as any).__joltRo?.disconnect();
      } catch {}
      if (renderer) {
        renderer.dispose();
        if (renderer.domElement.parentNode === container) {
          container.removeChild(renderer.domElement);
        }
      }
      if (cleanupJolt) {
        cleanupJolt();
        cleanupJolt = null;
      }
      setEngineReady(false);
    };
  }, [machineIndex, playTone, setCranePhase, triggerExtremeDrr, triggerBalanceCatch, triggerNearNear, triggerFinishWin]);

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

  const [isFocusedMode, setIsFocusedMode] = useState(false);
  const isFocusedModeRef = useRef(false);
  const isMyTurnKeyLockRef = useRef(false);
  useEffect(() => {
    isFocusedModeRef.current = isFocusedMode;
  }, [isFocusedMode]);
  useEffect(() => {
    isMyTurnKeyLockRef.current = isMyTurn || isFinishing;
    if (typeof window !== 'undefined' && window.innerWidth >= 768) {
      if (isMyTurn) {
        setIsFocusedMode(true);
      } else if (!isFinishing) {
        setIsFocusedMode(false);
      }
    }
  }, [isMyTurn, isFinishing]);

  useEffect(() => {
    if (!isFocusedMode || typeof document === 'undefined') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isFocusedMode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      );

      // 데스크톱 플레이 중 또는 집중 확대 모드에서는 방향키/스페이스로 브라우저가 스크롤되지 않도록 완전 차단 (key repeat 포함!)
      if (
        !isTyping &&
        (isMyTurnKeyLockRef.current || isFocusedModeRef.current) &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === ' ')
      ) {
        e.preventDefault();
      }

      if (e.key === 'Escape' && isFocusedModeRef.current && !isMyTurnKeyLockRef.current) {
        e.preventDefault();
        setIsFocusedMode(false);
        return;
      }

      if (e.repeat || isTyping) return;
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

    window.addEventListener('keydown', onKeyDown, { passive: false });
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
        return isPlushSlot(machineIndex)
          ? '⬆ 인형을 집어 들어올리는 중...'
          : '⬆ 물리 마찰과 토크로 상자를 들어올리고 있습니다!';
      case 'carrying':
        return '🎁 인형을 문 채 배출구(구멍) 위로 운반하는 중...';
      case 'releasing':
      case 'settling':
        return droppedThisTurn > 0
          ? isPlushSlot(machineIndex)
            ? '🎉 배출구로 인형이 떨어졌습니다!! 결과 저장 중...'
            : '🎉 Bar 사이로 상자가 떨어졌습니다!! 결과 저장 중...'
          : isPlushSlot(machineIndex)
          ? '⚖️ 인형이 자리를 잡는 중...'
          : '⚖️ 상자가 Bar 위에서 흔들리며 자리를 잡는 중...';
    }
  })();

  return (
    <div
      className={
        isFocusedMode
          ? 'fixed inset-0 z-[60] bg-slate-950/95 backdrop-blur-md p-3 sm:p-5 flex items-center justify-center'
          : 'w-full'
      }
    >
    <div
      className={
        isFocusedMode
          ? 'w-full max-w-5xl h-full max-h-[94vh] rounded-3xl overflow-hidden border-2 border-cyan-400/60 bg-slate-950 shadow-2xl shadow-cyan-950/50 flex flex-col'
          : 'w-full rounded-3xl overflow-hidden border border-cyan-500/35 bg-slate-950 shadow-2xl shadow-cyan-950/30'
      }
    >
      {/* 상단 상태 바 */}
      <div className="px-4 py-2.5 bg-slate-900/95 border-b border-slate-800 space-y-2 shrink-0">
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

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsFocusedMode((v) => !v)}
              className={`hidden sm:inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-black transition-colors cursor-pointer ${
                isFocusedMode
                  ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200 hover:bg-cyan-500/30'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700'
              }`}
              title={isFocusedMode ? '집중 확대 모드 종료' : '데스크톱 집중 확대 모드 (스크롤 잠금)'}
            >
              {isFocusedMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              <span>{isFocusedMode ? '축소' : '확대'}</span>
            </button>
            <button
              type="button"
              onClick={() => setSoundEnabled((v) => !v)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer shrink-0"
              title={soundEnabled ? '효과음 끄기' : '효과음 켜기'}
            >
              {soundEnabled ? <Volume2 className="w-4 h-4 text-cyan-400" /> : <VolumeX className="w-4 h-4 text-slate-500" />}
            </button>
          </div>
        </div>

        {/* 개별 뽑기판 빠른 전환 탭 (#1 ~ #6) + 우측 관리자 전용 개별 리필/재정렬 버튼 */}
        {machineSummaries.length > 0 && (() => {
          const liveMachines = machineSummaries.filter((m) => Boolean(m.lockedBy) && !m.suspended);
          const availableRandomPool = machineSummaries.filter((m) => m.hasStock && !m.suspended);
          const scrollTabsBy = (delta: number) => {
            machineTabsRef.current?.scrollBy({ left: delta, behavior: 'smooth' });
          };
          return (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 w-full min-w-0">
            <div className="flex items-center gap-1.5 min-w-0 w-full flex-1">
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={isCraneLockedToFront}
                  onClick={() => setIsMachinePickerOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-gradient-to-r from-cyan-500/25 to-emerald-500/25 hover:from-cyan-500/35 hover:to-emerald-500/35 border border-cyan-400/60 text-cyan-200 text-[11px] font-black shrink-0 shadow-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  title="전체 뽑기판 한눈에 보고 선택하기"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>선택</span>
                </button>
                <button
                  type="button"
                  disabled={isCraneLockedToFront || availableRandomPool.length === 0}
                  onClick={() => {
                    if (availableRandomPool.length === 0) return;
                    const pool =
                      availableRandomPool.length > 1
                        ? availableRandomPool.filter((m) => m.index !== machineIndex)
                        : availableRandomPool;
                    const picked = pool[Math.floor(Math.random() * pool.length)];
                    if (picked) onSelectMachine?.(picked.index);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-gradient-to-r from-fuchsia-500/25 to-amber-500/25 hover:from-fuchsia-500/35 hover:to-amber-500/35 border border-fuchsia-400/60 text-fuchsia-200 text-[11px] font-black shrink-0 shadow-sm cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-all"
                  title="재고가 남은 뽑기판 중 랜덤 선택"
                >
                  <Shuffle className="w-3.5 h-3.5" />
                  <span>랜덤</span>
                </button>
                <button
                  type="button"
                  disabled={isCraneLockedToFront}
                  onClick={() => {
                    if (liveMachines.length === 0) {
                      showSpectateToast('현재 진행 중인 뽑기가 없습니다.');
                      return;
                    }
                    if (liveMachines.length === 1) {
                      onSelectMachine?.(liveMachines[0].index);
                      return;
                    }
                    setIsSpectatePickerOpen(true);
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border text-[11px] font-black shrink-0 shadow-sm cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-all ${
                    liveMachines.length > 0
                      ? 'bg-gradient-to-r from-rose-500/30 to-amber-500/30 hover:from-rose-500/40 hover:to-amber-500/40 border-rose-400/70 text-rose-100'
                      : 'bg-slate-900/90 hover:bg-slate-800 border-slate-700 text-slate-300'
                  }`}
                  title="현재 진행 중인 뽑기 실시간 자동 관전"
                >
                  <Radio className={`w-3.5 h-3.5 ${liveMachines.length > 0 ? 'text-rose-300 animate-pulse' : 'text-slate-400'}`} />
                  <span>관전{liveMachines.length > 0 ? ` (${liveMachines.length})` : ''}</span>
                </button>
              </div>

              <div className="flex items-center gap-1 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => scrollTabsBy(-240)}
                  className="p-1 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white shrink-0 cursor-pointer transition-colors"
                  aria-label="뽑기판 목록 왼쪽으로 스크롤"
                  title="왼쪽으로 스크롤"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <div
                  ref={machineTabsRef}
                  onWheel={(e) => {
                    const el = machineTabsRef.current;
                    if (!el) return;
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                      e.preventDefault();
                      el.scrollLeft += e.deltaY;
                    }
                  }}
                  className="flex items-center gap-1.5 overflow-x-auto touch-pan-x pb-0.5 min-w-0 flex-1"
                  style={{ scrollbarWidth: 'thin' }}
                >
                  {machineSummaries.map((ms) => {
                    const isActive = ms.index === machineIndex;
                    return (
                      <button
                        key={ms.index}
                        data-machine-idx={ms.index}
                        type="button"
                        disabled={isCraneLockedToFront}
                        onClick={() => onSelectMachine?.(ms.index)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-[11px] font-bold shrink-0 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                          isActive
                            ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200 shadow-sm'
                            : ms.suspended
                            ? 'bg-amber-950/35 hover:bg-amber-950/55 border-amber-500/40 text-amber-300/80'
                            : 'bg-slate-950/80 hover:bg-slate-800 border-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            ms.suspended
                              ? 'bg-amber-400'
                              : ms.lockedBy
                              ? 'bg-rose-400 animate-pulse'
                              : ms.hasStock
                              ? 'bg-emerald-400'
                              : 'bg-slate-600'
                          }`}
                        />
                        <span>{ms.shortName}</span>
                        {ms.suspended ? (
                          <span className="text-[9px] text-amber-300 font-black">점검</span>
                        ) : !ms.hasStock ? (
                          <span className="text-[9px] text-rose-400 font-black">품절</span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => scrollTabsBy(240)}
                  className="p-1 rounded-lg bg-slate-900/90 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white shrink-0 cursor-pointer transition-colors"
                  aria-label="뽑기판 목록 오른쪽으로 스크롤"
                  title="오른쪽으로 스크롤"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-1.5 shrink-0 sm:ml-auto">
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
          );
        })()}
        {spectateToast && (
          <div className="px-3 py-1.5 rounded-xl bg-slate-800/95 border border-slate-600/80 text-amber-200 text-[11px] font-bold flex items-center justify-between gap-2">
            <span>📡 {spectateToast}</span>
            <button type="button" onClick={() => setSpectateToast('')} className="text-slate-400 hover:text-white cursor-pointer">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 3D WebGL 캔버스 뷰포트 */}
      <div className={`relative w-full bg-[#060a16] select-none ${isFocusedMode ? 'flex-1 min-h-[360px]' : 'h-[300px] sm:h-[450px]'}`}>
        <div ref={mountRef} className="w-full h-full" />

        {isMachineSuspended && !isAdmin && (
          <div className="absolute inset-0 z-40 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-5 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-400/50 flex items-center justify-center text-2xl">
              🛠️
            </div>
            <div className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-400/40 text-amber-300 text-[11px] font-black">
              {machineIndex + 1}번 기기 운영 중단 · 점검중
            </div>
            <h3 className="text-base sm:text-lg font-black text-white">
              [{machineIndex + 1}번] {machineLabel} 점검중입니다
            </h3>
            <p className="text-xs text-slate-300 max-w-sm leading-relaxed">
              관리자에 의해 이 뽑기판만 일시 운영 중단 상태입니다. 상단 탭이나 <strong>[선택]</strong> 버튼으로 다른 정상 뽑기판을 이용해주세요!
            </p>
          </div>
        )}

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

        {showStartPopup && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="px-6 py-3 rounded-2xl bg-gradient-to-r from-sky-500 via-cyan-500 to-blue-600 border-2 border-cyan-100 text-white font-black text-xl sm:text-3xl tracking-tight shadow-[0_0_40px_rgba(34,211,238,0.85)] animate-bounce">
              🕹️ 뽑기 시작!
            </div>
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

        {showNearNear && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="px-6 py-3 rounded-2xl bg-gradient-to-r from-fuchsia-600 via-pink-500 to-rose-500 border-2 border-pink-100 text-white font-black text-xl sm:text-3xl tracking-tight shadow-[0_0_40px_rgba(236,72,153,0.85)] animate-bounce">
              😱 아슬 아슬!
            </div>
          </div>
        )}

        {showFinishWin && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
            <div className="px-7 py-3.5 rounded-2xl bg-gradient-to-r from-yellow-400 via-amber-500 to-orange-500 border-2 border-yellow-100 text-slate-950 font-black text-2xl sm:text-4xl tracking-tight shadow-[0_0_50px_rgba(251,191,36,0.95)] animate-bounce">
              🎉 당첨!
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

        {/* 다른 멤버가 뽑기 진행 중일 때 실시간 관전 + 동시 진행 방지 오버레이 */}
        {lockedByOther && !isMyTurn && (
          <div className="absolute inset-0 z-10 bg-slate-950/25 backdrop-blur-[0.6px] pointer-events-none flex items-start justify-center pt-11 sm:pt-12 px-3">
            <div className="px-4 py-2 rounded-2xl bg-slate-900/85 border border-rose-500/60 shadow-2xl text-center backdrop-blur-sm max-w-sm">
              <div className="inline-flex items-center gap-1.5 text-rose-300 text-[11px] font-black flex-wrap justify-center">
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                <span className="px-1.5 py-0.5 rounded bg-rose-500/20 border border-rose-400/40 text-rose-200 text-[10px]">
                  {spectateLiveActive ? 'LIVE 실시간 관전' : '관전 대기 중'}
                </span>
                <span className="text-white">
                  🔒 <span className="text-amber-300">{lockedByOther}</span>님 진행 중
                  {otherSessionProgress && otherSessionProgress.total > 1
                    ? ` (${otherSessionProgress.current}/${otherSessionProgress.total}회)`
                    : ''}
                </span>
              </div>
              <p className="text-[10px] text-slate-300 mt-0.5">
                {spectateLiveActive && spectatePhase && LIVE_PHASE_LABELS[spectatePhase]
                  ? `현재 동작: ${LIVE_PHASE_LABELS[spectatePhase]} · 카메라 시점 전환 가능`
                  : '실시간 조작 화면을 관전할 수 있으며, 종료 후 바로 참여 가능합니다.'}
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
                {sandboxMode ? (
                  <>
                    모드: <strong className="text-cyan-300">Jolt Physics 무료 무한 연습실 (Port 4200)</strong>
                  </>
                ) : (
                  <>
                    선택된 플레이어: <strong className="text-amber-400">{selectedMember}</strong>{' '}
                    <span className="text-slate-400">(보유 뽑기권 {selectedMemberTickets}장)</span>
                  </>
                )}
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

      {isMachinePickerOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => setIsMachinePickerOpen(false)}
        >
          <div
            className="bg-slate-900 border border-cyan-500/40 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <LayoutGrid className="w-4 h-4 text-cyan-400" />
                <h3 className="text-sm sm:text-base font-black text-white">뽑기판 상품 선택 ({machineSummaries.length}종)</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsMachinePickerOpen(false)}
                className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                aria-label="닫기"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-3 sm:p-4 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {machineSummaries.map((ms) => {
                const spec = PRIZE_SPECS[ms.index];
                const isActive = ms.index === machineIndex;
                const rewardSol = getBoxRewardAmount(ms.index);
                return (
                  <button
                    key={ms.index}
                    type="button"
                    onClick={() => {
                      onSelectMachine?.(ms.index);
                      setIsMachinePickerOpen(false);
                    }}
                    className={`p-2.5 rounded-2xl border text-left transition-all cursor-pointer flex items-center gap-2.5 ${
                      isActive
                        ? 'bg-cyan-500/20 border-cyan-400 ring-1 ring-cyan-400/50 shadow-md'
                        : ms.hasStock
                        ? 'bg-slate-950/85 hover:bg-slate-800/90 border-slate-800 hover:border-slate-600'
                        : 'bg-slate-950/50 hover:bg-slate-900/70 border-slate-800/70 opacity-65'
                    }`}
                  >
                    {spec?.imgSrc && (
                      <img
                        src={spec.imgSrc}
                        alt={ms.shortName}
                        className="w-11 h-11 rounded-xl object-cover bg-slate-900 border border-slate-700/80 shrink-0"
                      />
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-1">
                        <span className={`text-xs font-black truncate ${isActive ? 'text-cyan-200' : 'text-white'}`}>
                          {ms.shortName}
                        </span>
                      </div>
                      <div className="text-[10px] text-amber-300 font-mono font-bold">
                        🪙 {rewardSol} SOL
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        {ms.suspended ? (
                          <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[9px] font-bold">
                            🛠️ 점검중
                          </span>
                        ) : ms.lockedBy ? (
                          <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[9px] font-bold">
                            🔥 {ms.lockedBy}
                          </span>
                        ) : ms.hasStock ? (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[9px] font-bold">
                            ● 플레이 가능
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-rose-400 text-[9px] font-bold">
                            품절
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {isSpectatePickerOpen && (() => {
        const liveList = machineSummaries.filter((m) => Boolean(m.lockedBy) && !m.suspended);
        return (
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm"
            onClick={() => setIsSpectatePickerOpen(false)}
          >
            <div
              className="bg-slate-900 border border-rose-500/45 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-rose-400 animate-pulse" />
                  <h3 className="text-sm sm:text-base font-black text-white">
                    실시간 관전 선택 ({liveList.length}개 진행 중)
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIsSpectatePickerOpen(false)}
                  className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
                  aria-label="닫기"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-3 sm:p-4 overflow-y-auto space-y-2">
                {liveList.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-400">
                    현재 진행 중인 뽑기가 없습니다.
                  </p>
                ) : (
                  liveList.map((ms) => {
                    const spec = PRIZE_SPECS[ms.index];
                    return (
                      <button
                        key={ms.index}
                        type="button"
                        onClick={() => {
                          onSelectMachine?.(ms.index);
                          setIsSpectatePickerOpen(false);
                        }}
                        className="w-full p-3 rounded-2xl bg-slate-950/90 hover:bg-slate-800/90 border border-rose-500/35 hover:border-rose-400 text-left flex items-center gap-3 cursor-pointer transition-all"
                      >
                        {spec?.imgSrc && (
                          <img
                            src={spec.imgSrc}
                            alt={ms.shortName}
                            className="w-11 h-11 rounded-xl object-cover bg-slate-900 border border-slate-700 shrink-0"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs sm:text-sm font-black text-white truncate">
                            {ms.shortName}
                          </div>
                          <div className="text-[11px] text-rose-300 font-bold flex items-center gap-1 mt-0.5">
                            <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
                            <span>{ms.lockedBy}님 뽑기 진행 중 · 클릭하여 관전</span>
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};
