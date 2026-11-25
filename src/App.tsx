import React, { useState, useCallback } from 'react';
import { Sliders, RotateCcw, Trophy, Cpu, Layers, Sparkles, Eye } from 'lucide-react';
import {
  DEFAULT_PHYSICS_TUNING,
  PRIZE_SPECS,
  PhysicsTuning,
  PrizeSpec,
  getRestingPosition,
} from './constants/prizes';
import { JoltUfoMachine3D, MachineSnapshot } from './components/JoltUfoMachine3D';

function createInitialSnapshots(): MachineSnapshot[] {
  return PRIZE_SPECS.map((spec) => ({
    hasStock: true,
    position: getRestingPosition(spec),
    quaternion: [0, 0, 0, 1],
    isInitialState: true,
    plays: 0,
    wins: 0,
  }));
}

interface WinLogEntry {
  id: string;
  label: string;
  rewardSol: number;
  time: string;
}

export default function App() {
  const [machineIndex, setMachineIndex] = useState(0);
  const [snapshots, setSnapshots] = useState<MachineSnapshot[]>(createInitialSnapshots);
  const [tuning, setTuning] = useState<PhysicsTuning>(DEFAULT_PHYSICS_TUNING);
  const [showTuning, setShowTuning] = useState(true);
  const [winLogs, setWinLogs] = useState<WinLogEntry[]>([]);

  const handleUpdateSnapshot = useCallback((idx: number, next: MachineSnapshot) => {
    setSnapshots((prev) => {
      const copy = [...prev];
      copy[idx] = next;
      return copy;
    });
  }, []);

  const handlePrizeWon = useCallback((spec: PrizeSpec) => {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    setWinLogs((prev) => [
      { id: `${Date.now()}_${spec.index}`, label: spec.label, rewardSol: spec.rewardSol, time },
      ...prev.slice(0, 19),
    ]);
  }, []);

  const totalWins = snapshots.reduce((sum, s) => sum + s.wins, 0);
  const totalPlays = snapshots.reduce((sum, s) => sum + s.plays, 0);

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100">
      {/* 상단 헤더 */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-gradient-to-tr from-cyan-500 via-blue-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-cyan-500/25">
              <Cpu className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <h1 className="text-sm sm:text-base font-black tracking-tight text-white flex items-center gap-2">
                <span>Jolt Physics UFO Catcher 3D</span>
                <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 border border-cyan-400/40 text-cyan-300 text-[10px] font-mono">
                  v1.1.2 WASM · Port 4000
                </span>
              </h1>
              <p className="text-[11px] text-slate-400">
                가짜 잡기(Constraint) 없는 100% 실제 관절 모터·마찰·무게중심 물리 엔진 테스트베드
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs font-mono flex items-center gap-2">
              <Trophy className="w-3.5 h-3.5 text-amber-400" />
              <span>
                당첨 <strong className="text-amber-300">{totalWins}</strong> / 시도 {totalPlays}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowTuning((v) => !v)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-black transition-colors cursor-pointer ${
                showTuning
                  ? 'bg-cyan-500/20 border-cyan-400/60 text-cyan-200'
                  : 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white'
              }`}
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>물리 튜닝</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-3 sm:px-4 py-4 space-y-4">
        {/* 핵심 Jolt Physics 3D 크레인 머신 */}
        <JoltUfoMachine3D
          machineIndex={machineIndex}
          snapshots={snapshots}
          tuning={tuning}
          onSelectMachine={setMachineIndex}
          onUpdateSnapshot={handleUpdateSnapshot}
          onPrizeWon={handlePrizeWon}
        />

        {/* Jolt 실시간 물리 튜닝 패널 + 테스트 당첨 로그 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {showTuning && (
            <section className="lg:col-span-2 p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <h2 className="text-xs sm:text-sm font-black text-white flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-cyan-400" />
                  <span>Jolt Physics 실시간 물리 파라미터 튜닝</span>
                </h2>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setTuning((t) => ({ ...t, showColliders: !t.showColliders }))}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-bold cursor-pointer transition-colors ${
                      tuning.showColliders
                        ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                        : 'bg-slate-950 border-slate-700 text-slate-400 hover:text-white'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>콜라이더 보기</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTuning(DEFAULT_PHYSICS_TUNING)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-[11px] font-bold cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>기본값 복원</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <label className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-300">집게 닫힘 토크 (잡는 힘)</span>
                    <span className="font-mono text-cyan-300">{tuning.closeTorque.toFixed(1)} N·m</span>
                  </div>
                  <input
                    type="range"
                    min={6}
                    max={24}
                    step={0.5}
                    value={tuning.closeTorque}
                    onChange={(e) => setTuning((t) => ({ ...t, closeTorque: Number(e.target.value) }))}
                    className="w-full accent-cyan-400"
                  />
                </label>

                <label className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-300">집게 리프트 유지 토크</span>
                    <span className="font-mono text-amber-300">{tuning.liftTorque.toFixed(1)} N·m</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={22}
                    step={0.5}
                    value={tuning.liftTorque}
                    onChange={(e) => setTuning((t) => ({ ...t, liftTorque: Number(e.target.value) }))}
                    className="w-full accent-amber-400"
                  />
                </label>

                <label className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-300">하강 누르기 최대 힘</span>
                    <span className="font-mono text-emerald-300">{tuning.downPressForce.toFixed(0)} N</span>
                  </div>
                  <input
                    type="range"
                    min={15}
                    max={70}
                    step={1}
                    value={tuning.downPressForce}
                    onChange={(e) => setTuning((t) => ({ ...t, downPressForce: Number(e.target.value) }))}
                    className="w-full accent-emerald-400"
                  />
                </label>

                <label className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-300">중앙 빨간 실리콘 링 마찰력</span>
                    <span className="font-mono text-rose-300">{tuning.barRingFriction.toFixed(2)} μ</span>
                  </div>
                  <input
                    type="range"
                    min={0.25}
                    max={1.2}
                    step={0.02}
                    value={tuning.barRingFriction}
                    onChange={(e) => setTuning((t) => ({ ...t, barRingFriction: Number(e.target.value) }))}
                    className="w-full accent-rose-400"
                  />
                </label>

                <label className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 space-y-1">
                  <div className="flex justify-between font-bold">
                    <span className="text-slate-300">상품 무게 배율</span>
                    <span className="font-mono text-purple-300">{tuning.massScale.toFixed(2)}×</span>
                  </div>
                  <input
                    type="range"
                    min={0.6}
                    max={1.5}
                    step={0.05}
                    value={tuning.massScale}
                    onChange={(e) => setTuning((t) => ({ ...t, massScale: Number(e.target.value) }))}
                    className="w-full accent-purple-400"
                  />
                </label>

                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <div className="font-bold text-slate-300">시뮬레이션 속도 / 무게중심</div>
                    <div className="text-[10px] text-slate-500">슬로우모션으로 물리 접촉 정밀 관찰</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setTuning((t) => ({ ...t, timeScale: t.timeScale === 1 ? 0.5 : 1 }))}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-mono font-black cursor-pointer ${
                        tuning.timeScale < 1
                          ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                          : 'bg-slate-900 border-slate-700 text-slate-300'
                      }`}
                    >
                      {tuning.timeScale}x
                    </button>
                    <button
                      type="button"
                      onClick={() => setTuning((t) => ({ ...t, useComOffset: !t.useComOffset }))}
                      className={`px-2.5 py-1 rounded-lg border text-[11px] font-bold cursor-pointer ${
                        tuning.useComOffset
                          ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300'
                          : 'bg-slate-900 border-slate-700 text-slate-400'
                      }`}
                    >
                      편심 {tuning.useComOffset ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Jolt 구조 특징 & 테스트 당첨 로그 */}
          <section className={`${showTuning ? 'lg:col-span-1' : 'lg:col-span-3'} p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3`}>
            <h2 className="text-xs sm:text-sm font-black text-white flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-emerald-400" />
              <span>cannon-es 대비 핵심 물리 차이</span>
            </h2>
            <ul className="space-y-1.5 text-[11px] text-slate-300 leading-relaxed">
              <li className="flex items-start gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">진짜 6-DOF 케이블 + 2× 힌지 모터 집게</strong>: 상자를 코드로 붙이지 않고 3단 곡면 집게와 실리콘 끝단 마찰만으로 집고 들어올립니다.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">금속 Bar vs 빨간 실리콘 링 마찰 분리</strong>: 크롬 구간(0.28μ)과 실리콘 링(0.76μ)을 별도 물리 콜라이더로 분리했습니다.
                </span>
              </li>
              <li className="flex items-start gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                <span>
                  <strong className="text-white">편심 무게중심 + LinearCast CCD</strong>: 박스 내부 피규어 무게 쏠림과 고속 관통 방지(CCD)를 적용했습니다.
                </span>
              </li>
            </ul>

            {winLogs.length > 0 && (
              <div className="pt-2 border-t border-slate-800 space-y-1.5">
                <div className="text-[11px] font-black text-amber-300">🏆 테스트 획득 기록 ({winLogs.length})</div>
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {winLogs.map((w) => (
                    <div
                      key={w.id}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-between text-[11px]"
                    >
                      <span className="font-bold text-white truncate">{w.label}</span>
                      <span className="font-mono text-amber-300 shrink-0">{w.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
