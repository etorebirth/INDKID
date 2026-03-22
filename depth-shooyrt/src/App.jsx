import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DepthShooter.jsx (v17)
 *
 * 追加（v16 → v17）
 * - Wave を無制限に継続（Wave1,2,...）。
 * - 各 Wave の総敵数 = 10 + (waveIndex * 2) で増加（Wave が上がる度に +2）。
 * - スポーン上限（1ターンに出現可能な最大体数）は、Wave>5 で 4、それまでは 3。
 * - 最終クリア（ALL CLEAR）の概念は廃止。各 Wave クリア毎に次へ進行可能。
 */

// 盤面定数
const COLS = 5;
const ROWS = 7;                // r=0: 最上段, r=ROWS-1: 最下段（プレイヤー前の行）
const FRONT_ROW = ROWS - 2;    // プレイヤーの前の行
const MAX_HP = 3;

// 敵タイプ
const EMPTY = 0;
const ENEMY1 = 1; // 2回攻撃ごとに直進
const ENEMY2 = 2; // 毎ターン直進
const ENEMY3 = 3; // 毎ターン 下/左下/右下 のいずれか

// 固定アセットパス
const ASSETS = {
  ENEMY1: '/src/assets/en1.png',
  ENEMY2: '/src/assets/en2.png',
  ENEMY3: '/src/assets/en3.png',
  PLAYER: '/src/assets/player.png',
  BGM: '/src/assets/famipop3.mp3',
  RESULT_WAVE: '/src/assets/yes.png',   // 任意
  RESULT_GAMEOVER: '/src/assets/oh.png' // 任意
};

function PlayerSvg({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2c2.8 2.6 3.6 6.5 0 10.5C8.4 8.5 9.2 4.6 12 2z" fill="#06b6d4"/>
      <path d="M12 9l6 4-3 1-3-2-3 2-3-1 6-4z" fill="#22d3ee"/>
      <rect x="11" y="13" width="2" height="5" rx="1" fill="#e5e7eb"/>
    </svg>
  );
}

// SFX（WebAudio ビープ）
function useSfx(enabled = true, volume = 0.6) {
  const ctxRef = useRef(null);
  const ensureCtx = () => { if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)(); return ctxRef.current; };
  const playBeep = (freq=500, dur=120, type='sine', gainMul=0.15) => { if (!enabled) return; const ctx = ensureCtx(); const osc=ctx.createOscillator(); const g=ctx.createGain(); osc.type=type; osc.frequency.value=freq; g.gain.value=volume*gainMul; osc.connect(g).connect(ctx.destination); osc.start(); setTimeout(()=>{ try{osc.stop();}catch{} try{osc.disconnect();}catch{} try{g.disconnect();}catch{} }, dur); };
  return {
    shot:()=>playBeep(720,80,'triangle'),
    hit:()=>playBeep(220,120,'sawtooth'),
    damage:()=>playBeep(140,220,'square',0.2),
    scan:()=>playBeep(1020,160,'sine',0.12),
    clear:()=>playBeep(900,300,'sine',0.15),
    nuke:()=>playBeep(300,360,'square',0.18),
    charge:()=>playBeep(520,140,'sine',0.12),
    setContextRunning:async()=>{ if (ctxRef.current && ctxRef.current.state==='suspended') await ctxRef.current.resume(); }
  };
}

// --- ユーティリティ（純粋関数） ---
function shuffled(arr) { const a = arr.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }

// Wave コンフィグ（動的）
function getWaveConfig(waveIndex /* 0-based */) {
  const n = waveIndex + 1; // 1,2,3,...
  const total = 10 + (waveIndex * 2); // Wave が上がる度に +2
  const spawnRate = Math.min(0.45, 0.30 + waveIndex * 0.01); // 少しだけ上げていく（頭打ち）
  const alwaysVisible = (n === 1); // Wave1 は可視、それ以降は通常
  return { id: n, name: `Wave ${n}`, total, spawnRate, alwaysVisible };
}

function getMaxSpawnPerTurn(waveIndex) {
  const n = waveIndex + 1;
  return n > 5 ? 4 : 3; // Wave>5 で 4、それまでは 3
}

/** 敵前進とスポーンを純粋計算 */
function computeAdvance(prevGrid, wave, remainingPool, turnShots, waveIndex) {
  const ROWS = prevGrid.length; const COLS = prevGrid[0].length;
  const next = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
  let enteringPlayerTile = 0;
  const willType1Move = (turnShots % 2 === 0);

  for (let r = ROWS - 1; r >= 0; r--) {
    for (let c = 0; c < COLS; c++) {
      const cell = prevGrid[r][c];
      if (cell === EMPTY) continue;
      let targetR = r, targetC = c;

      if (cell.t === ENEMY1) {
        if (willType1Move) targetR = r + 1;
      } else if (cell.t === ENEMY2) {
        targetR = r + 1;
      } else if (cell.t === ENEMY3) {
        const dirs = shuffled([0, -1, 1]);
        let moved = false;
        for (const dc of dirs) {
          const nr = r + 1, nc = c + dc;
          if (nc < 0 || nc >= COLS) continue;
          if (nr >= ROWS) { enteringPlayerTile += 1; moved = true; break; }
          if (next[nr][nc] === EMPTY) { targetR = nr; targetC = nc; moved = true; break; }
        }
        if (moved) { if (targetR < ROWS) next[targetR][targetC] = cell; continue; }
      }
      if (targetR >= ROWS) { enteringPlayerTile += 1; }
      else { if (next[targetR][targetC] === EMPTY) next[targetR][targetC] = cell; else if (next[r][c] === EMPTY) next[r][c] = cell; }
    }
  }

  // スポーン
  const MAX_SPAWN_PER_TURN = getMaxSpawnPerTurn(waveIndex);
  let spawned = 0;
  if (remainingPool > 0) {
    for (const c of shuffled([...Array(COLS).keys()])) {
      if (remainingPool - spawned <= 0) break;
      if (spawned >= MAX_SPAWN_PER_TURN) break;
      if (next[0][c] === EMPTY && Math.random() < wave.spawnRate) {
        next[0][c] = createEnemy(wave.alwaysVisible);
        spawned += 1;
      }
    }
  }
  return { next, damageThisTurn: enteringPlayerTile > 0, spawned };
}

export default function DepthShooter() {
  const [grid, setGrid] = useState(() => Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY)));
  const gridRef = useRef(grid); useEffect(()=>{ gridRef.current = grid; }, [grid]);
  const [playerCol, setPlayerCol] = useState(2);
  const [isShooting, setIsShooting] = useState(false);
  const [bulletRow, setBulletRow] = useState(-1);

  // 累積スコア／ショット
  const [score, setScore] = useState(0);
  const [shots, setShots] = useState(0);
  const shotsRef = useRef(0); useEffect(()=>{ shotsRef.current = shots; }, [shots]);

  // HP / 状態
  const [hp, setHp] = useState(MAX_HP);
  const [gameOver, setGameOver] = useState(false);
  const [cleared, setCleared] = useState(false);

  // SFX / 演出
  const [sfxOn, setSfxOn] = useState(true);
  const [sfxVol, setSfxVol] = useState(0.6);
  const [hitColor, setHitColor] = useState('#f43f5e');
  const [hitSize, setHitSize] = useState(36);
  const sfx = useSfx(sfxOn, sfxVol);

  // 探索（5撃破で再使用）
  const [killsSinceScan, setKillsSinceScan] = useState(0);
  const [scanAvailable, setScanAvailable] = useState(true);
  const scanReady = scanAvailable || killsSinceScan >= 5;
  const [scanFlash, setScanFlash] = useState(false);

  // 全体攻撃（各Wave1回）
  const [aoeReady, setAoeReady] = useState(true);

  // Wave管理（動的）
  const [waveIndex, setWaveIndex] = useState(0);
  const wave = getWaveConfig(waveIndex);
  const [remainingToSpawn, setRemainingToSpawn] = useState(() => wave.total);
  const [killedSoFar, setKilledSoFar] = useState(0);

  // BGM
  const [bgmOn, setBgmOn] = useState(() => (localStorage.getItem('ds_bgm_on') ?? 'true') === 'true');
  const [bgmVol, setBgmVol] = useState(() => parseFloat(localStorage.getItem('ds_bgm_vol') ?? '0.4'));
  const bgmRef = useRef(null);
  useEffect(()=>{ try{ localStorage.setItem('ds_bgm_on', String(bgmOn)); }catch{}; if (!bgmOn) { try{ bgmRef.current?.pause(); }catch{} } }, [bgmOn]);
  useEffect(()=>{ try{ localStorage.setItem('ds_bgm_vol', String(bgmVol)); }catch{}; if (bgmRef.current) bgmRef.current.volume = Math.max(0, Math.min(1, bgmVol)); }, [bgmVol]);
  const tryPlayBgm = () => { const a = bgmRef.current; if (!a || !bgmOn) return; a.volume = Math.max(0, Math.min(1, bgmVol)); const p = a.play(); if (p && typeof p.then === 'function') p.catch(()=>{}); };

  // 命中エフェクト
  const [effects, setEffects] = useState([]);
  const addHitEffect = (r, c) => { const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; setEffects(a=>[...a,{id,r,c}]); setTimeout(()=>setEffects(a=>a.filter(e=>e.id!==id)), 400); };

  // --- 共通：前進（Pure → Apply） ---
  const advance = (turnShots) => {
    const { next, damageThisTurn, spawned } = computeAdvance(gridRef.current, wave, remainingToSpawn, turnShots, waveIndex);
    setGrid(next); gridRef.current = next;
    if (spawned>0) setRemainingToSpawn(prev => Math.max(0, prev - spawned));
    if (damageThisTurn) { setHp(h=>{ const nh = Math.max(0, h-1); if (nh===0) setGameOver(true); return nh; }); sfx.damage(); }

    const anyOnBoard = next.flat().some(v => v !== EMPTY);
    if (!anyOnBoard && (remainingToSpawn - spawned) === 0) {
      setCleared(true);
      sfx.clear();
    }
  };

  // --- 射撃共通：pierce=false（通常/非貫通）, pierce=true（強撃/貫通） ---
  const shoot = ({ pierce }) => {
    if (isShooting || gameOver) return;
    setScanFlash(false);

    const turnShots = shotsRef.current + 1;
    setIsShooting(true); setShots(s=>s+1); sfx.setContextRunning?.(); sfx.shot(); tryPlayBgm();

    let r = ROWS; const stepMs = 80; let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; clearInterval(timer); setBulletRow(-1); setIsShooting(false); if (pierce) setCharge(0); advance(turnShots); };

    const timer = setInterval(() => {
      if (stopped) return;
      r -= 1; setBulletRow(r);
      if (r < 0) { stop(); return; }

      const snap = gridRef.current;
      if (r >= 0 && r < ROWS && snap[r]?.[playerCol] !== EMPTY) {
        const next = snap.map(row => row.slice());
        next[r][playerCol] = EMPTY;
        setGrid(next); gridRef.current = next;

        setScore(sc=>sc+10); setKillsSinceScan(k=>Math.min(5,k+1)); setKilledSoFar(k=>k+1); sfx.hit(); addHitEffect(r, playerCol);
        if (!pierce) { stop(); return; }
      }
    }, stepMs);
  };

  // 操作群
  const handleAttack = () => shoot({ pierce: false });
  const handleStrong = () => { if (charge >= 2) shoot({ pierce: true }); };
  const [charge, setCharge] = useState(0);
  const handleCharge = () => { if (isShooting || gameOver) return; setScanFlash(false); const turnShots = shotsRef.current + 1; setShots(s=>s+1); if (charge<2) setCharge(c=>Math.min(2,c+1)); sfx.charge(); tryPlayBgm(); advance(turnShots); };
  const handleScan = () => { if (!scanReady || gameOver) return; sfx.scan(); tryPlayBgm(); setGrid(prev => { const next = prev.map(row => row.slice()); for (let r=Math.max(0, ROWS-3); r<ROWS; r++) for (let c=0;c<COLS;c++){ const cell = next[r][c]; if (cell!==EMPTY) cell.revealed = true; } return next; }); setScanAvailable(false); setKillsSinceScan(0); setScanFlash(true); };
  const handleAoe = () => { if (!aoeReady || gameOver) return; sfx.nuke(); tryPlayBgm(); const kills = gridRef.current.flat().filter(v=>v!==EMPTY).length; const empty = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY)); setGrid(empty); gridRef.current = empty; if (kills>0) { setScore(sc=>sc+kills*10); setKillsSinceScan(k=>Math.min(5, k+kills)); setKilledSoFar(k=>k+kills); } setAoeReady(false); };

  // Wave 遷移（無制限）
  const goToWave = (index) => {
    const w = getWaveConfig(index);
    setWaveIndex(index);
    const empty = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
    setGrid(empty); gridRef.current = empty;
    setRemainingToSpawn(w.total); setCleared(false); setAoeReady(true);
    setKillsSinceScan(0); setKilledSoFar(0); setCharge(0); setScanAvailable(true); setScanFlash(false);
  };
  const handleNextWave = () => { goToWave(waveIndex + 1); };

  const handleRestartAll = () => {
    const empty = Array.from({ length: ROWS }, () => Array(COLS).fill(EMPTY));
    setGrid(empty); gridRef.current = empty; setPlayerCol(2);
    setScore(0); setShots(0); setBulletRow(-1); setIsShooting(false);
    setHp(MAX_HP); setGameOver(false); setCleared(false);
    setKillsSinceScan(0); setAoeReady(true); setKilledSoFar(0); setCharge(0);
    setWaveIndex(0); const w = getWaveConfig(0); setRemainingToSpawn(w.total);
    setScanAvailable(true); setScanFlash(false);
  };

  // キーボード
  useEffect(()=>{ const onKey=(e)=>{ const t=(e.target&&e.target.tagName||'').toLowerCase(); if (t==='input'||t==='textarea'||e.isComposing) return; if (e.key==='ArrowLeft'){e.preventDefault(); setPlayerCol(c=>Math.max(0,c-1));} else if(e.key==='ArrowRight'){e.preventDefault(); setPlayerCol(c=>Math.min(COLS-1,c+1));} else if(e.code==='Space'||e.key===' '){e.preventDefault(); handleAttack();} }; window.addEventListener('keydown', onKey); return ()=>window.removeEventListener('keydown', onKey); }, []);

  // 残数・進捗
  const remainingOnBoard = useMemo(()=> grid.flat().filter(v=>v!==EMPTY).length, [grid]);
  const totalThisWave = wave.total; const progressText = `${killedSoFar}/${totalThisWave}`; const remainingTotal = remainingToSpawn + remainingOnBoard;

  // 可視判定
  const isAlwaysVisible = wave.alwaysVisible === true;
  const isVisible = (r, c, cell) => { if (cell===EMPTY) return false; if (isAlwaysVisible) return true; if (cell.revealed) return true; return r === FRONT_ROW; };

  // 見た目
  const enemyStyle = (t) => { const base={position:'absolute',inset:6,borderRadius:10,boxShadow:'0 0 14px rgba(255,255,255,0.15)'}; if(t===ENEMY1) return {...base,background:'rgba(244,63,94,0.9)'}; if(t===ENEMY2) return {...base,background:'rgba(250,204,21,0.9)'}; if(t===ENEMY3) return {...base,background:'rgba(168,85,247,0.9)'}; return base; };

  // リザルト表示フラグ（無制限Waveのため ALL CLEAR は無し）
  const showWaveClear = cleared && !gameOver;
  const showGameOver = gameOver;

  // チャージUIテキスト
  const chargeText = charge < 2 ? `チャージ（${charge}/2）` : `強撃（${charge}/2 貫通）`;

  const enemyIconFor = (t) => (t===ENEMY1 ? ASSETS.ENEMY1 : t===ENEMY2 ? ASSETS.ENEMY2 : t===ENEMY3 ? ASSETS.ENEMY3 : '');

  return (
    <div style={styles.page}>
      {/* BGM */}
      <audio ref={bgmRef} src={ASSETS.BGM} loop preload="auto" />

      <div style={styles.headerRow}>
        <h1 style={styles.title}>5×7 グリッド + 1×5 プレイヤー（v17：無制限Wave / +2増加 / Wave5で4体同時スポーン）</h1>
        <div style={styles.headerBtns}><button onClick={handleRestartAll} style={{...styles.btn, ...styles.btnSecondary}}>最初から</button></div>
      </div>

      {/* ステータス */}
      <div style={styles.statusRow}>
        <div style={styles.statBox}><div style={styles.statLabel}>Wave</div><div style={styles.statValue}>{wave.name}</div></div>
        <div style={styles.statBox}><div style={styles.statLabel}>スコア（合算）</div><div style={styles.statValue}>{score}</div></div>
        <div style={styles.statBox}><div style={styles.statLabel}>進捗（撃破/総数）</div><div style={styles.statValue}>{progressText}</div></div>
      </div>

      <div style={styles.hpRow}>
        <div style={styles.hpLabel}>HP</div>
        <div style={styles.hearts}>{Array.from({length:MAX_HP}).map((_,i)=>(<div key={i} style={{...styles.heart,opacity:i<hp?1:0.25}}>❤</div>))}</div>
        {showGameOver && <div style={styles.gameOver}>GAME OVER</div>}
        {showWaveClear && <div style={styles.cleared}>WAVE CLEAR!</div>}
      </div>

      {/* 設定（SFX/BGM） */}
      <details style={styles.settings}>
        <summary style={{cursor:'pointer'}}>設定（SFX / BGM）</summary>
        <div style={styles.settingsBody}>
          <label style={styles.formRow}><input type="checkbox" checked={sfxOn} onChange={(e)=>setSfxOn(e.target.checked)} /> 効果音を有効にする</label>
          <label style={styles.formRow}>SFX音量: <input type="range" min={0} max={1} step={0.01} value={sfxVol} onChange={(e)=>setSfxVol(parseFloat(e.target.value))} style={{marginLeft:8}} /> {Math.round(sfxVol*100)}%</label>
          <label style={styles.formRow}>命中エフェクト色: <input type="color" value={hitColor} onChange={(e)=>setHitColor(e.target.value)} style={{marginLeft:8}} /></label>
          <label style={styles.formRow}>命中エフェクトサイズ: <input type="range" min={20} max={60} step={1} value={hitSize} onChange={(e)=>setHitSize(parseInt(e.target.value,10))} style={{marginLeft:8}} /> {hitSize}px</label>

          <div style={{fontWeight:700, marginTop:10}}>BGM</div>
          <label style={styles.formRow}><input type="checkbox" checked={bgmOn} onChange={(e)=>setBgmOn(e.target.checked)} /> BGMを有効にする（/assets/bgm.mp3）</label>
          <label style={styles.formRow}>BGM 音量: <input type="range" min={0} max={1} step={0.01} value={bgmVol} onChange={(e)=>setBgmVol(parseFloat(e.target.value))} style={{marginLeft:8}} /> {Math.round(bgmVol*100)}%</label>
        </div>
      </details>

      {/* レジェンド＆チャージ情報 */}
      <div style={styles.legend}>
        <div style={styles.legendItem}><span style={{...styles.legendDot, background:'rgba(244,63,94,0.9)'}} /> 敵1: 2回攻撃ごとに直進</div>
        <div style={styles.legendItem}><span style={{...styles.legendDot, background:'rgba(250,204,21,0.9)'}} /> 敵2: 毎ターン直進</div>
        <div style={styles.legendItem}><span style={{...styles.legendDot, background:'rgba(168,85,247,0.9)'}} /> 敵3: 毎ターン 下/左下/右下</div>
        <div style={{marginLeft:'auto', fontSize:12, color:'#94a3b8'}}>探索: {scanReady ? '使用可能' : `あと ${Math.max(0, 5-killsSinceScan)} 体で再使用可`}</div>
      </div>

      {/* 敵フィールド */}
      <div style={styles.fieldWrapper}>
        <div style={{...styles.grid, gridTemplateColumns:`repeat(${COLS},1fr)`, gridTemplateRows:`repeat(${ROWS},1fr)`}}>
          {Array.from({length:ROWS}).map((_,r)=> (
            Array.from({length:COLS}).map((_,c)=>{
              const cell = grid[r][c];
              const showEnemy = isVisible(r,c,cell);
              const showBullet = bulletRow===r && c===playerCol;
              const eff = effects.filter(e=>e.r===r&&e.c===c);
              const showScanOverlay = scanFlash && r >= Math.max(0, ROWS-3) && r < ROWS;
              const iconUrl = showEnemy && cell!==EMPTY ? enemyIconFor(cell.t) : '';
              return (
                <div key={`cell-${r}-${c}`} style={{...styles.cell, ...(showScanOverlay ? styles.cellScanned : {})}}>
                  <div style={styles.cellGuide} />
                  {showEnemy && cell!==EMPTY && <div style={enemyStyle(cell.t)} />}
                  {iconUrl && (
                    <div style={styles.iconWrap}>
                      <img src={iconUrl} alt="enemy" style={styles.iconImg} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
                    </div>
                  )}
                  {showBullet && <div style={styles.bulletWrap}><div style={styles.bullet}/></div>}
                  {eff.map(e=> <div key={e.id} style={{...styles.hitEffect, background:hitColor, width:hitSize, height:hitSize}} />)}
                </div>
              );
            })
          ))}
        </div>

        {/* プレイヤー行（強調） */}
        <div style={{...styles.grid, gridTemplateColumns:`repeat(${COLS},1fr)`, gridTemplateRows:'repeat(1,1fr)', marginTop:8}}>
          {Array.from({length:COLS}).map((_,c)=> (
            <button key={`p-${c}`} onClick={()=>!showGameOver&&!showWaveClear&&setPlayerCol(c)} disabled={showGameOver||showWaveClear} aria-label={`列${c+1}へ移動`} style={{ ...styles.playerCell, ...(c===playerCol?styles.playerCellActive:{}), cursor:(showGameOver||showWaveClear)?'not-allowed':'pointer' }}>
              {c===playerCol && (
                ASSETS.PLAYER ? (
                  <div style={styles.iconWrap}>
                    <img src={ASSETS.PLAYER} alt="player" style={styles.iconImg} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
                  </div>
                ) : (
                  <PlayerSvg size={44} />
                )
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 操作 */}
      <div style={styles.controls}>
        <button onClick={handleAttack} disabled={isShooting||showGameOver||showWaveClear} style={{...styles.btn, ...(isShooting||showGameOver||showWaveClear?styles.btnDisabled:styles.btnPrimary)}}>攻撃（非貫通 / Space）</button>
        {charge < 2 ? (
          <button onClick={handleCharge} disabled={isShooting||showGameOver||showWaveClear} style={{...styles.btn, ...styles.btnOutline}}>チャージ（{charge}/2）</button>
        ) : (
          <button onClick={handleStrong} disabled={isShooting||showGameOver||showWaveClear} style={{...styles.btn, background:'rgba(234,88,12,0.95)', color:'#fff', borderColor:'rgba(234,88,12,1)'}}>強撃（{charge}/2 貫通）</button>
        )}
        <button onClick={handleScan} disabled={!scanReady||showGameOver||showWaveClear} style={{...styles.btn, ...styles.btnOutline, opacity:(!scanReady||showGameOver||showWaveClear)?0.6:1}}>探索（手前3行 恒久表示）</button>
        <button onClick={handleAoe} disabled={!aoeReady||showGameOver||showWaveClear} style={{...styles.btn, background: aoeReady?'rgba(244,63,94,0.9)':'rgba(71,85,105,0.6)', color:'#fff', borderColor:'rgba(244,63,94,0.9)'}}>全体攻撃（Waveに1回）</button>
        <div style={{marginLeft:'auto', color:'#94a3b8', fontSize:12}}>弾数: {shots} ／ 残り敵: {remainingTotal} ／ チャージ: {charge}/2</div>
      </div>

      {/* オーバーレイ（結果） */}
      {(showGameOver || showWaveClear) && (
        <div style={styles.overlay}>
          <div style={styles.resultCard}>
            {/* 画像（任意） */}
            {showGameOver && ASSETS.RESULT_GAMEOVER && (
              <div style={styles.resultImgWrap}>
                <img src={ASSETS.RESULT_GAMEOVER} alt="game over" style={styles.resultImg} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
              </div>
            )}
            {showWaveClear && ASSETS.RESULT_WAVE && (
              <div style={styles.resultImgWrap}>
                <img src={ASSETS.RESULT_WAVE} alt="wave clear" style={styles.resultImg} onError={(e)=>{ e.currentTarget.style.display='none'; }} />
              </div>
            )}

            {showGameOver && (<div style={{fontSize:22,fontWeight:800,marginBottom:6}}>GAME OVER</div>)}
            {showWaveClear && (<div style={{fontSize:22,fontWeight:800,marginBottom:6}}>{wave.name} CLEAR</div>)}

            <div style={{color:'#94a3b8', marginBottom:12}}>リザルト</div>
            <div style={styles.resultRow}><span>スコア（合算）</span><span>{score}</span></div>
            <div style={styles.resultRow}><span>弾数</span><span>{shots}</span></div>
            <div style={styles.resultRow}><span>進捗</span><span>{progressText}</span></div>
            <div style={styles.resultRow}><span>全体攻撃</span><span>{aoeReady ? '未使用' : '使用済み'}</span></div>

            <div style={{display:'flex', gap:8, marginTop:16, justifyContent:'flex-end'}}>
              {showGameOver && <button onClick={handleRestartAll} style={{...styles.btn, ...styles.btnPrimary}}>リトライ</button>}
              {showWaveClear && <button onClick={handleNextWave} style={{...styles.btn, ...styles.btnPrimary}}>次へ</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page:{fontFamily:'system-ui,-apple-system,Segoe UI,Roboto,Noto Sans,Helvetica,Arial,sans-serif',background:'linear-gradient(to bottom,#0f172a,#1f2937)',color:'#e5e7eb',minHeight:'100vh',padding:'16px',boxSizing:'border-box',display:'flex',flexDirection:'column',alignItems:'center'},
  headerRow:{width:'100%',maxWidth:880,display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12},
  title:{fontSize:18,fontWeight:700,margin:0}, headerBtns:{display:'flex',gap:8},
  statusRow:{width:'100%',maxWidth:880,display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,marginBottom:8},
  statBox:{background:'rgba(30,41,59,0.6)',borderRadius:14,padding:12,boxShadow:'inset 0 0 0 1px rgba(71,85,105,0.6)'},
  statLabel:{color:'#94a3b8',fontSize:12,marginBottom:2}, statValue:{fontSize:20,fontWeight:700},
  hpRow:{width:'100%',maxWidth:880,display:'flex',alignItems:'center',gap:12,marginBottom:8}, hpLabel:{color:'#94a3b8',fontSize:12}, hearts:{display:'flex',gap:6}, heart:{fontSize:18,color:'#ef4444'}, gameOver:{marginLeft:'auto',color:'#fca5a5',fontWeight:700}, cleared:{marginLeft:'auto',color:'#a7f3d0',fontWeight:800},
  settings:{width:'100%',maxWidth:880,marginBottom:10,background:'rgba(30,41,59,0.5)',borderRadius:12,padding:10,boxShadow:'0 0 0 1px rgba(71,85,105,0.6) inset'}, settingsBody:{marginTop:8,display:'grid',gap:8}, formRow:{display:'flex',alignItems:'center',gap:6,fontSize:14},
  legend:{width:'100%',maxWidth:880,display:'flex',alignItems:'center',gap:14,margin:'6px 0 8px 0'}, legendItem:{display:'flex',alignItems:'center',gap:6,fontSize:13,color:'#e5e7eb'}, legendDot:{display:'inline-block',width:14,height:14,borderRadius:4},
  fieldWrapper:{width:'100%',maxWidth:880,background:'rgba(30,41,59,0.5)',borderRadius:16,padding:12,boxShadow:'0 0 0 1px rgba(71,85,105,0.6) inset'}, grid:{display:'grid',gap:6},
  cell:{position:'relative',aspectRatio:'1 / 1',background:'rgba(15,23,42,0.6)',border:'1px solid rgba(71,85,105,0.6)',borderRadius:10,overflow:'hidden', transition:'background-color .15s ease'},
  cellScanned:{background:'linear-gradient(180deg, rgba(56,189,248,0.18), rgba(15,23,42,0.6))', border:'1px solid rgba(56,189,248,0.5)'},
  cellGuide:{position:'absolute',inset:0,backgroundImage:'linear-gradient(135deg, rgba(255,255,255,0.08) 1px, transparent 1px)',backgroundSize:'10px 10px',opacity:0.08,pointerEvents:'none'},
  iconWrap:{position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', pointerEvents:'none'},
  iconImg:{maxWidth:'80%', maxHeight:'80%', objectFit:'contain', filter:'drop-shadow(0 2px 2px rgba(0,0,0,.45))'},
  bulletWrap:{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}, bullet:{width:8,height:8,borderRadius:999,background:'rgb(251,191,36)',boxShadow:'0 0 12px rgba(251,191,36,0.9)',animation:'pulse 0.6s ease-in-out infinite'},
  playerCell:{position:'relative',aspectRatio:'1 / 1',background:'linear-gradient(180deg, rgba(2,132,199,0.25), rgba(15,23,42,0.6))',border:'2px solid rgba(56,189,248,0.8)',borderRadius:10,display:'flex',alignItems:'center',justifyContent:'center',color:'#e5e7eb',transition:'background .15s ease,border-color .15s ease'}, playerCellActive:{outline:'2px solid rgba(34,211,238,0.9)',boxShadow:'0 0 0 2px rgba(8,145,178,0.4) inset, 0 0 10px rgba(34,211,238,0.5)',borderColor:'rgba(34,211,238,0.95)'},
  controls:{width:'100%',maxWidth:880,display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}, btn:{padding:'10px 14px',borderRadius:12,border:'1px solid rgba(148,163,184,0.4)',background:'rgba(226,232,240,0.9)',color:'#0f172a',fontWeight:700,cursor:'pointer'}, btnPrimary:{background:'rgba(34,211,238,0.9)',borderColor:'rgba(103,232,249,0.9)'}, btnOutline:{background:'transparent',color:'#e5e7eb',borderColor:'rgba(71,85,105,0.8)'}, btnSecondary:{background:'rgba(51,65,85,0.9)',color:'#e5e7eb',borderColor:'rgba(71,85,105,0.9)'}, btnDisabled:{opacity:0.6,cursor:'not-allowed'},
  overlay:{position:'fixed',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(2,6,23,0.7)',zIndex:50}, resultCard:{width:360,background:'rgba(15,23,42,0.95)',border:'1px solid rgba(71,85,105,0.8)',borderRadius:16,padding:16,boxShadow:'0 8px 24px rgba(0,0,0,0.5)'}, resultRow:{display:'flex',justifyContent:'space-between',gap:12,padding:'6px 0',borderBottom:'1px dashed rgba(71,85,105,0.6)'},
  resultImgWrap:{width:'100%',display:'flex',justifyContent:'center',marginBottom:10}, resultImg:{maxWidth:'100%',maxHeight:'100%',objectFit:'contain',filter:'drop-shadow(0 2px 2px rgba(0,0,0,.45))'},
  hints:{width:'100%',maxWidth:880,marginTop:12,color:'#cbd5e1',fontSize:14}, list:{margin:0,paddingLeft:18},
  hitEffect:{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',borderRadius:999,opacity:0.85,animation:'explode 0.35s ease-out forwards'}
};

// keyframes 注入（一度だけ）
if (typeof document !== 'undefined' && !document.getElementById('depth-shooter-keyframes')) {
  const style = document.createElement('style'); style.id = 'depth-shooter-keyframes';
  style.innerHTML = `@keyframes pulse {0%{transform:scale(1);opacity:1}50%{transform:scale(1.2);opacity:.85}100%{transform:scale(1);opacity:1}} @keyframes explode {0%{transform:translate(-50%,-50%) scale(.2);opacity:.95}100%{transform:translate(-50%,-50%) scale(1.8);opacity:0}}`;
  document.head.appendChild(style);
}
