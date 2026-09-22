/**
 * Chrome 恐龍遊戲 自動遊玩腳本
 *
 * 使用方式：
 * 1. 打開 https://elgoog.hk/dinosaur-game/ (或任何內嵌經典 Chrome Dino Runner 的頁面)
 * 2. 打開瀏覽器 DevTools 的 Console
 * 3. 貼上這整段程式碼並按 Enter
 * 4. 遊戲會自動開始、自動跳/蹲閃避障礙物，撞到後會自動重來
 * 5. 分數到 1000 時腳本會自動停止控制（可自行修改 TARGET_SCORE）
 *
 * 原理：
 * - 遊戲的核心物件掛在全域變數 Runner.instance_ 上（tRex、horizon.obstacles、
 *   currentSpeed、distanceMeter 等），這是遊戲原始碼自己公開的狀態，不是隱藏 API。
 * - 判斷「跳」還是「蹲」的門檻值（yPos >= 75 就跳，否則蹲）、以及提前量抓時機的
 *   各項參數（寬障礙物提早跳、連續障礙物提早跳、緊急距離強制跳、跳躍失敗重試等），
 *   是參考 elgoog.hk 網站自己內建的「AI/機器人模式」（__elgoogDinoBot）原始碼邏輯
 *   重新實作的，而不是直接呼叫它。
 * - 「按鍵」是用 document.createEvent('KeyboardEvent') 建立真正的鍵盤事件並
 *   dispatchEvent 出去，效果等同真人按下 ↑ / ↓，只是由程式在算好的時間點觸發。
 */
(function () {
  const TARGET_SCORE = 1000;

  // ---- 模擬鍵盤按鍵（等同真人按 ↑ / ↓）----
  function fireKey(type, code) {
    const evt = document.createEvent('KeyboardEvent');
    Object.defineProperty(evt, 'keyCode', { get: function () { return this.keyCodeVal; } });
    if (evt.initKeyboardEvent) {
      evt.initKeyboardEvent(type, true, true, document.defaultView, code, code, '', '', false, '');
    } else {
      evt.initKeyEvent(type, true, true, document.defaultView, false, false, false, false, code, 0);
    }
    evt.keyCodeVal = code;
    document.body.dispatchEvent(evt);
  }
  function jumpKey() { fireKey('keydown', 38); fireKey('keyup', 38); } // Up Arrow
  function duckDown() { fireKey('keydown', 40); }                     // Down Arrow (press)
  function duckUp() { fireKey('keyup', 40); }                         // Down Arrow (release)

  // ---- 判斷參數（沿用官方 AI/機器人模式 default 設定）----
  const cfg = {
    extraDistance: 0,
    jumpYThreshold: 75,        // yPos >= 此值 -> 跳；否則 -> 蹲
    threatFrontPadding: 4,
    jumpStartUpperFrames: 11,  // 提前幾影格開始「考慮」跳
    jumpStartLowerFrames: 4,   // 提前幾影格內「必須」跳（用於重試判斷）
    wideObstacleWidth: 42,     // 障礙物寬度 >= 此值視為「寬障礙物」（如雙仙人掌）
    wideObstacleAdvanceFrames: 1,
    chainGapFramesThreshold: 14, // 下一個障礙物間隔小於此影格數 -> 視為連續障礙
    chainAdvanceFrames: 2,
    duckStartFrames: 8,        // 提前幾影格開始蹲
    retryCooldownMs: 90,       // 跳躍失敗後，重跳的冷卻時間
    forceRetryFrames: 5,
    emergencyDistance: 70,     // 障礙物 x 座標小於此值 -> 視為緊急狀況，強制動作
    landingGraceMs: 220,       // 落地後這段時間內，允許立刻再次判斷是否需要重跳
    duckCooldownMs: 120,
  };

  // ---- 內部狀態 ----
  let ducking_uidCounter = 0;
  let currentThreatUID = '';
  let retryCount = 0;
  let lastJumpAt = -1;
  let lastDuckAt = -1;
  let wasJumping = false;
  let landedAt = 0;

  window.__dinoBotStop = false;
  window.__dinoBotDone = false;
  window.__dinoBotLog = [];
  window.__dinoBotAttempts = 0;
  window.__dinoBotBest = 0;
  window.__dinoBotRuns = (window.__dinoBotRuns || 0) + 1;
  const runId = window.__dinoBotRuns;

  function resetThreatState() {
    currentThreatUID = '';
    retryCount = 0;
    lastJumpAt = -1;
    lastDuckAt = -1;
    wasJumping = false;
    landedAt = 0;
  }

  // 找出「目前最靠近的威脅」與「下一個威脅」(用來判斷是否為連續障礙)
  function findThreats(obstacles, tRexX, r) {
    const rel = obstacles.filter(o => o.typeConfig.type !== 'SNACK/COLLECTABLE');
    if (!rel.length) return { current: null, next: null };
    let idx = rel.findIndex(o => !(o.xPos + o.width <= tRexX - r.threatFrontPadding));
    if (idx === -1) idx = 0;
    return { current: rel[idx], next: rel[idx + 1] || null };
  }

  // 依障礙物寬度 / 是否連續障礙，動態調整「該提早幾影格反應」
  function computeWindow(runner, cur, next, r) {
    const speed = Math.max(runner.currentSpeed || 0, 0.001);
    const gapPx = next ? (next.xPos - (cur.xPos + cur.width)) : Infinity;
    const gapFrames = Number.isFinite(gapPx) ? gapPx / speed : Infinity;
    let upper = r.jumpStartUpperFrames, lower = r.jumpStartLowerFrames;
    if (cur.width >= r.wideObstacleWidth) {
      upper += r.wideObstacleAdvanceFrames;
      lower += Math.max(1, Math.floor(r.wideObstacleAdvanceFrames / 2));
    }
    if (gapFrames <= r.chainGapFramesThreshold) {
      upper += r.chainAdvanceFrames;
      lower += Math.max(1, Math.floor(r.chainAdvanceFrames / 2));
    }
    lower = Math.max(1, lower);
    upper = Math.max(lower + 1, upper);
    return { upper, lower };
  }

  function tick() {
    if (window.__dinoBotStop || window.__dinoBotRuns !== runId) return;
    const rn = Runner.instance_;
    if (!rn || !rn.horizon) { setTimeout(tick, 4); return; }
    const t = rn.tRex;

    // 撞毀 -> 記錄分數並自動重新開始
    if (rn.crashed) {
      const finalScore = parseInt(rn.distanceMeter.digits.join(''));
      window.__dinoBotBest = Math.max(window.__dinoBotBest, finalScore);
      window.__dinoBotLog.push('crashed at ' + finalScore);
      if (window.__dinoBotLog.length > 20) window.__dinoBotLog.shift();
      window.__dinoBotAttempts += 1;
      resetThreatState();
      jumpKey(); // 按跳躍鍵 = 重新開始
      setTimeout(tick, 4);
      return;
    }

    const score = parseInt(rn.distanceMeter.digits.join(''));
    if (score >= TARGET_SCORE) {
      window.__dinoBotLog.push('REACHED ' + TARGET_SCORE);
      window.__dinoBotStop = true;
      window.__dinoBotDone = true;
      return;
    }

    const obstacles = rn.horizon.obstacles;
    if (!obstacles.length) { setTimeout(tick, 4); return; }

    const r = cfg;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (wasJumping && !t.jumping) landedAt = now; // 剛落地
    wasJumping = t.jumping;

    const { current: threat, next: nextThreat } = findThreats(obstacles, t.xPos, r);
    if (!threat) {
      if (t.ducking) duckUp();
      resetThreatState();
      setTimeout(tick, 4);
      return;
    }

    if (!threat.__botUID) { ducking_uidCounter += 1; threat.__botUID = 'ob-' + ducking_uidCounter; }
    if (currentThreatUID !== threat.__botUID) {
      currentThreatUID = threat.__botUID;
      retryCount = 0;
    }

    const win = computeWindow(rn, threat, nextThreat, r);
    const isJumpTarget = threat.yPos >= r.jumpYThreshold; // 核心判斷：跳 or 蹲
    const speed = Math.max(rn.currentSpeed || 0, 0.001);
    const framesToImpact = (threat.xPos - t.xPos) / speed;
    const rightEdge = threat.xPos + threat.width;
    const withinOuter = framesToImpact <= win.upper;
    const withinInner = framesToImpact <= win.lower;
    const inEmergency = threat.xPos <= r.emergencyDistance;
    const withinLandingGrace = landedAt > 0 && (now - landedAt) <= r.landingGraceMs;
    const msSinceJump = lastJumpAt < 0 ? Infinity : (now - lastJumpAt);
    const retryOk = msSinceJump >= r.retryCooldownMs;
    const forceRetry = inEmergency || framesToImpact <= r.forceRetryFrames;
    const shouldKeepDuck = !isJumpTarget && framesToImpact <= r.duckStartFrames && rightEdge > t.xPos - r.threatFrontPadding;

    if (t.ducking && !shouldKeepDuck) duckUp();

    const canAct = !t.jumping && !t.ducking;

    if (withinOuter) {
      if (isJumpTarget && canAct) {
        const isFirstAttempt = (retryCount === 0);
        if (isFirstAttempt || (retryOk && (withinLandingGrace || forceRetry || withinInner))) {
          if (t.ducking) duckUp();
          jumpKey();
          lastJumpAt = now;
          retryCount += 1;
        }
      } else if (!isJumpTarget && canAct) {
        const msSinceDuck = lastDuckAt < 0 ? Infinity : (now - lastDuckAt);
        if (framesToImpact <= r.duckStartFrames && msSinceDuck >= r.duckCooldownMs) {
          duckDown();
          lastDuckAt = now;
        }
      }
    }

    setTimeout(tick, 4);
  }

  tick();
  console.log('Dino auto-play bot started. Target score:', TARGET_SCORE);
  console.log('查詢狀態: window.__dinoBotLog / window.__dinoBotBest / window.__dinoBotAttempts');
  console.log('停止腳本: window.__dinoBotStop = true');
})();