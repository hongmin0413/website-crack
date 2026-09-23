/**
 * 2048（ychung1998.github.io/game-2048 版）自動遊玩腳本
 *
 * 使用方式：
 * 1. （可選）修改下面的 TARGET_SCORE，改成你想衝到的分數，預設 Infinity（不設上限）
 * 2. 打開 https://ychung1998.github.io/game-2048/
 * 3. 打開瀏覽器 DevTools 的 Console
 * 4. 貼上這整段程式碼並按 Enter
 * 5. 腳本會自動判斷方向、模擬按鍵；湊到 2048 跳出「繼續」彈窗會自動按繼續；
 *    單局輸了會自動重新開始再玩下一局（新方塊是真隨機，單局提前死掉只是運氣問題），
 *    只有分數達到 TARGET_SCORE 才會真正停止
 *
 * 原理、實測數據與破解可能性分析詳見 2048/攻略.md。
 * 暫停腳本：window.__2048BotStop = true　　繼續腳本：window.__2048BotResume()
 * 中途改目標分數：window.__2048BotTarget = 數字
 * 查詢狀態：window.__2048BotLog / window.__2048BotMoves / window.__2048BotAttempts /
 *           window.__2048BotBest / window.__2048BotRerolls / window.__2048BotLastDepth
 */
(function () {
  const TARGET_SCORE = Infinity; // 改成你想衝到的分數（例如 50000），達到就自動停止；不想設上限就留 Infinity
  const FAST_ANIMATIONS = true; // 壓縮全站 CSS 動畫時長，讓畫面看起來也是瞬間完成；若懷疑跟讀盤卡住有關，改 false
  const MAX_REROLLS = 6; // 同一步最多悔棋重骰幾次，避免極端情況下卡在無限迴圈
  const DIRS = ['up', 'down', 'left', 'right'];
  const KEY_OF = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  // 純視覺效果，讀盤不依賴它；0.01s 而非 0s 是刻意的，CSS duration:0 不保證觸發 transitionend
  if (FAST_ANIMATIONS && !document.getElementById('__2048_bot_turbo_style')) {
    const style = document.createElement('style');
    style.id = '__2048_bot_turbo_style';
    style.textContent = `
      *, *::before, *::after {
        transition-duration: 0.01s !important;
        transition-delay: 0s !important;
        animation-duration: 0.01s !important;
        animation-delay: 0s !important;
      }
    `;
    document.head.appendChild(style);
  }

  function fireArrow(dir) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: KEY_OF[dir], bubbles: true, cancelable: true }));
  }

  // 網站按鍵後現有方塊位置同步更新，但新方塊要等 SLIDE_MS=90 後才進 DOM（見 notes.md），
  // 所以先強制等滿 MIN_SETTLE_FLOOR_MS 才開始判斷穩定，避免讀到少一顆方塊的舊盤面。
  // 用 setTimeout 輪詢而非 requestAnimationFrame：背景分頁 rAF 會完全暫停，setTimeout 只會被節流
  const MIN_SETTLE_FLOOR_MS = 110;
  const POLL_INTERVAL_MS = 16; // 前景時約等同一個影格，背景時會被節流變慢但仍會醒
  const SETTLE_STABLE_FRAMES = 2;
  const SETTLE_MAX_WAIT_MS = 400;
  function boardDomSignature() {
    let sig = '';
    document.querySelectorAll('#board .tile').forEach((t) => {
      sig += t.style.left + ',' + t.style.top + ',' + t.dataset.v + '|';
    });
    return sig;
  }
  function nextFrame() { return new Promise((r) => setTimeout(r, POLL_INTERVAL_MS)); }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async function waitForBoardSettle() {
    const start = performance.now();
    await sleep(MIN_SETTLE_FLOOR_MS);
    let prevSig = boardDomSignature();
    let stableFrames = 0;
    while (performance.now() - start < SETTLE_MAX_WAIT_MS) {
      await nextFrame();
      const sig = boardDomSignature();
      if (sig === prevSig) {
        stableFrames++;
        if (stableFrames >= SETTLE_STABLE_FRAMES) break;
      } else {
        stableFrames = 0;
        prevSig = sig;
      }
    }
    window.__2048BotLastSettleMs = performance.now() - start;
  }

  // 從 .tile 的 dataset.v + style.left/top 反推 4x4 board；盤面統一用長度 16 的 Int32Array（index = r*4+c）
  function readBoard() {
    const boardEl = document.getElementById('board');
    const padding = 10, gap = 10;
    const inner = boardEl.clientWidth - padding * 2 - gap * 3;
    const cellSize = inner / 4;
    const step = cellSize + gap;
    const flat = new Int32Array(16);
    document.querySelectorAll('#board .tile').forEach((t) => {
      const left = parseFloat(t.style.left);
      const top = parseFloat(t.style.top);
      const c = Math.round((left - padding) / step);
      const r = Math.round((top - padding) / step);
      const v = parseInt(t.dataset.v, 10);
      if (r >= 0 && r < 4 && c >= 0 && c < 4) {
        const i = r * 4 + c;
        flat[i] = Math.max(flat[i], v); // 動畫交界殘影，取較大值保險
      }
    });
    return flat;
  }

  // 每個方向 4 條「線」，index 0 = 該線最靠近目的地那端（right/down 走訪順序反過來）
  const LINES = {
    left:  [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
    right: [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]],
    up:    [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]],
    down:  [[12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]],
  };
  const slideScratch = new Int32Array(4);
  let lastGained = 0; // 合併得分放這裡，避免為了回傳兩個值配置物件
  function slideInto(flat, dir, out) {
    const lines = LINES[dir];
    let moved = false;
    let gained = 0;
    for (let li = 0; li < 4; li++) {
      const idx = lines[li];
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const v = flat[idx[k]];
        if (v !== 0) slideScratch[n++] = v;
      }
      let w = 0;
      for (let k = 0; k < n; k++) {
        if (k < n - 1 && slideScratch[k] === slideScratch[k + 1]) {
          const val = slideScratch[k] * 2;
          gained += val;
          out[idx[w++]] = val;
          k++;
        } else {
          out[idx[w++]] = slideScratch[k];
        }
      }
      for (; w < 4; w++) out[idx[w]] = 0;
      for (let k = 0; k < 4; k++) if (out[idx[k]] !== flat[idx[k]]) moved = true;
    }
    lastGained = gained;
    return moved;
  }
  function simulateMove(flat, dir) {
    const out = new Int32Array(16);
    const moved = slideInto(flat, dir, out);
    return { board: out, moved, gained: lastGained };
  }
  // 蛇形路徑，只留 4 種旋轉（每個角落一種走法），不加鏡射避免同角落兩種走法互搶
  const SNAKE_RANKS_2D = [
    [15, 14, 13, 12],
    [8, 9, 10, 11],
    [7, 6, 5, 4],
    [0, 1, 2, 3],
  ];
  function rotateMatrix2D(m) {
    const n = m.length;
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => m[n - 1 - c][r]));
  }
  function flatten2D(m) {
    const f = new Int32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) f[r * 4 + c] = m[r][c];
    return f;
  }
  const SNAKE_VARIANTS = []; // 4 個 flat(16) 權重矩陣
  (function buildSnakeVariants() {
    let m = SNAKE_RANKS_2D;
    for (let i = 0; i < 4; i++) { SNAKE_VARIANTS.push(flatten2D(m)); m = rotateMatrix2D(m); }
  })();
  // order[0] 是角落（頭），order[15] 是蛇形終點（尾巴）
  function buildOrder(wm) {
    const order = [];
    for (let rank = 15; rank >= 0; rank--) {
      for (let i = 0; i < 16; i++) if (wm[i] === rank) order.push(i);
    }
    return order;
  }
  const SNAKE_ORDERS = SNAKE_VARIANTS.map(buildOrder);

  const BIG_TILE_THRESHOLD = 32;
  const BIG_TILE_MULTIPLIER = 4;
  function weightedValue(v) {
    return v >= BIG_TILE_THRESHOLD ? v * BIG_TILE_MULTIPLIER : v;
  }

  // 角落選定後整局鎖死不換（玩家本人的固定技巧，見攻略.md），下一局重新開始才重選
  let cornerLocked = false;
  let activeIdx = 0;
  let activeOrder = SNAKE_ORDERS[0];
  function resetCornerLock() {
    cornerLocked = false;
  }
  function updateActiveCorner(flat) {
    if (cornerLocked) return;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < SNAKE_VARIANTS.length; i++) {
      const wm = SNAKE_VARIANTS[i];
      let score = 0;
      for (let k = 0; k < 16; k++) if (flat[k]) score += weightedValue(flat[k]) * wm[k];
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    activeIdx = bestIdx;
    activeOrder = SNAKE_ORDERS[bestIdx];
    cornerLocked = true;
  }
  function snakeValue(flat) {
    const wm = SNAKE_VARIANTS[activeIdx];
    let score = 0;
    for (let k = 0; k < 16; k++) if (flat[k]) score += weightedValue(flat[k]) * wm[k];
    return score;
  }

  // 蛇形路徑最後 TAIL_SIZE 格算尾巴，其餘（除了頭）算身體；技巧細節見攻略.md
  const TAIL_SIZE = 6;
  const ANOMALY_PENALTY_WEIGHT = 6;
  const TAIL_EMPTY_WEIGHT = 4;
  const TAIL_MERGE_READY_BONUS = 6;
  const BODY_MERGE_READY_BONUS = 10;
  const EMPTY_WEIGHT = 8;

  // evaluate() 跟 isBodyClean() 共用，避免各寫一份、以後改一邊忘了改另一邊
  function bodyAnomalyPenalty(flat) {
    const order = activeOrder;
    const tailStart = 16 - TAIL_SIZE;
    let penalty = 0;
    for (let i = 1; i < tailStart; i++) {
      const prevVal = weightedValue(flat[order[i - 1]]);
      const curVal = weightedValue(flat[order[i]]);
      if (curVal > prevVal) penalty += curVal - prevVal;
    }
    return penalty;
  }
  // 門檻不能設 0：小數字暫時卡位是每步都會發生的正常波動，設 0 會變成幾乎每步都悔棋
  const BODY_DIRTY_THRESHOLD = 32;
  function isBodyClean(flat) {
    return bodyAnomalyPenalty(flat) <= BODY_DIRTY_THRESHOLD;
  }

  function evaluate(flat) {
    const order = activeOrder; // 用鎖定的角落，不重挑
    const tailStart = 16 - TAIL_SIZE; // index 1..tailStart-1 是身體，tailStart..15 是尾巴
    const anomalyPenalty = bodyAnomalyPenalty(flat);

    let tailBonus = 0;
    for (let i = tailStart; i < 16; i++) {
      if (flat[order[i]] === 0) tailBonus += TAIL_EMPTY_WEIGHT;
    }
    for (let i = 0; i < 15; i++) {
      if (flat[order[i]] !== 0 && flat[order[i]] === flat[order[i + 1]]) {
        tailBonus += (i >= tailStart) ? TAIL_MERGE_READY_BONUS : BODY_MERGE_READY_BONUS;
      }
    }

    let empties = 0;
    for (let k = 0; k < 16; k++) if (flat[k] === 0) empties++;

    return snakeValue(flat) - anomalyPenalty * ANOMALY_PENALTY_WEIGHT + tailBonus + empties * EMPTY_WEIGHT;
  }

  // ---- 盤面雜湊：方塊都是 2 的冪，用 clz32 取 exponent，每格 4 bit、8 格打包成
  // 一個 32-bit 整數，整個盤面就是 lo/hi 兩個整數；快取是巢狀 Map
  // （(剩餘深度, 輪到誰) → lo → hi → 分數），全程只用原生 32-bit 整數運算，
  // 不用 BigInt（BigInt 在 V8 裡每個運算都要配置堆積物件，這是熱路徑，代價太高）。
  // exponent 0~15 剛好塞滿 4 bit；65536（exponent 16）以上會溢位、讓不同盤面
  // 撞到同一個鍵，所以 packHalf() 偵測到就設 packOverflow，該節點直接跳過快取
  // ——只影響效能，不會讀到錯的分數。
  let packOverflow = false;
  function packHalf(flat, off) {
    let h = 0;
    for (let i = 0; i < 8; i++) {
      const v = flat[off + i];
      const e = v === 0 ? 0 : 31 - Math.clz32(v);
      if (e > 15) packOverflow = true;
      h |= e << (i * 4);
    }
    return h >>> 0;
  }
  function newCache() { return []; } // 依 (剩餘深度 << 1 | 是否玩家回合) 分槽，每槽 Map<lo, Map<hi, 分數>>

  // 每層深度各自的暫存（盤面/空格/criticality），子節點深度必小 1，子樹不會動到父節點正在讀的那塊
  const boardPool = [];
  const cellsPool = [];
  const critPool = [];
  function poolBoard(level) {
    let b = boardPool[level];
    if (b === undefined) b = boardPool[level] = new Int32Array(16);
    return b;
  }
  function poolCells(level) {
    let b = cellsPool[level];
    if (b === undefined) b = cellsPool[level] = new Int32Array(16);
    return b;
  }
  function poolCrit(level) {
    let b = critPool[level];
    if (b === undefined) b = critPool[level] = new Int32Array(16);
    return b;
  }

  // 空格數 > PRUNE_EMPTY_THRESHOLD 時，只對 criticality 最高的 PRUNE_KEEP 個空格展開 2/4 兩種分支，其餘只展開 2
  const PRUNE_EMPTY_THRESHOLD = 6;
  const PRUNE_KEEP = 6;
  function criticality(flat, i) {
    const r = (i / 4) | 0, c = i % 4;
    let score = 0;
    if (r > 0 && flat[i - 4]) score += weightedValue(flat[i - 4]);
    if (r < 3 && flat[i + 4]) score += weightedValue(flat[i + 4]);
    if (c > 0 && flat[i - 1]) score += weightedValue(flat[i - 1]);
    if (c < 3 && flat[i + 1]) score += weightedValue(flat[i + 1]);
    return score;
  }

  function search(flat, depth, isPlayerTurn, cache) {
    if (depth === 0) return evaluate(flat);

    packOverflow = false;
    const lo = packHalf(flat, 0);
    const hi = packHalf(flat, 8);
    const cacheable = !packOverflow; // 遞迴會覆寫 packOverflow，先把自己這格的結果存下來
    const slot = (depth << 1) | (isPlayerTurn ? 1 : 0);
    let byLo = cache[slot];
    if (cacheable) {
      if (byLo === undefined) byLo = cache[slot] = new Map();
      const byHi = byLo.get(lo);
      if (byHi !== undefined) {
        const hit = byHi.get(hi);
        if (hit !== undefined) return hit;
      }
    }

    const child = poolBoard(depth); // 這一層專用的暫存盤面
    let result;
    if (isPlayerTurn) {
      let best = -Infinity;
      for (let d = 0; d < 4; d++) {
        if (!slideInto(flat, DIRS[d], child)) continue;
        const score = search(child, depth - 1, false, cache);
        if (score > best) best = score;
      }
      result = best === -Infinity ? evaluate(flat) : best;
    } else {
      const cells = poolCells(depth);
      let nCells = 0;
      for (let i = 0; i < 16; i++) if (flat[i] === 0) cells[nCells++] = i;
      if (nCells === 0) {
        result = search(flat, depth - 1, true, cache);
      } else {
        let nCritical = nCells;
        if (nCells > PRUNE_EMPTY_THRESHOLD) {
          // 插入排序就地排（最多 16 個元素），不配置暫存陣列，穩定排序保持同分原順序
          const crit = poolCrit(depth);
          for (let k = 0; k < nCells; k++) crit[k] = criticality(flat, cells[k]);
          for (let k = 1; k < nCells; k++) {
            const cv = cells[k], sv = crit[k];
            let j = k - 1;
            while (j >= 0 && crit[j] < sv) { cells[j + 1] = cells[j]; crit[j + 1] = crit[j]; j--; }
            cells[j + 1] = cv; crit[j + 1] = sv;
          }
          nCritical = PRUNE_KEEP;
        }
        let total = 0;
        for (let k = 0; k < nCritical; k++) {
          const i = cells[k];
          child.set(flat); child[i] = 2;
          total += 0.9 * search(child, depth - 1, true, cache);
          child.set(flat); child[i] = 4;
          total += 0.1 * search(child, depth - 1, true, cache);
        }
        for (let k = nCritical; k < nCells; k++) {
          const i = cells[k];
          child.set(flat); child[i] = 2;
          total += search(child, depth - 1, true, cache);
        }
        result = total / nCells;
      }
    }

    if (cacheable) {
      let byHi = byLo.get(lo);
      if (byHi === undefined) { byHi = new Map(); byLo.set(lo, byHi); }
      byHi.set(hi, result);
    }
    return result;
  }

  // 預算刻意設低：分數對深度在深度 5 後就飽和（見 notes.md），深度 6 已買到全部棋力
  const SEARCH_TIME_BUDGET_MS = 25;
  const EXTENDED_SEARCH_TIME_BUDGET_MS = 60; // 盤面已有大異常時延長，悔棋救不了舊異常，只能靠搜尋看遠一點
  const MAX_SEARCH_DEPTH = 9;
  const MIN_GUARANTEED_DEPTH = 6; // 這個深度以下不檢查時間，確保飽和點以上那層一定算完
  const GROWTH_ESTIMATE = 4;
  let lastSearchDepth = 0;
  function bestMove(flat) {
    updateActiveCorner(flat);
    const searchBudget = bodyAnomalyPenalty(flat) > BODY_DIRTY_THRESHOLD
      ? EXTENDED_SEARCH_TIME_BUDGET_MS
      : SEARCH_TIME_BUDGET_MS;
    const start = performance.now();
    const deadline = start + searchBudget;
    let best = null;
    let lastRoundMs = 0;
    let reachedDepth = 0;
    const cache = newCache(); // 各輪 iterative deepening 共用，鍵值含剩餘深度與回合，深一輪能命中淺一輪算過的子樹
    for (let depth = 2; depth <= MAX_SEARCH_DEPTH; depth++) {
      if (depth > MIN_GUARANTEED_DEPTH) {
        const predicted = lastRoundMs * GROWTH_ESTIMATE;
        if (performance.now() + predicted > deadline) break; // 預判這一輪會爆預算，乾脆不跑
      }
      const roundStart = performance.now();
      const rootChild = poolBoard(depth);
      let localBest = null;
      let localBestScore = -Infinity;
      for (let d = 0; d < 4; d++) {
        const dir = DIRS[d];
        if (!slideInto(flat, dir, rootChild)) continue;
        const score = search(rootChild, depth - 1, false, cache); // 沒有 deadline 參數，保證完整算完
        if (score > localBestScore) { localBestScore = score; localBest = dir; }
      }
      lastRoundMs = performance.now() - roundStart;
      if (localBest) { best = localBest; reachedDepth = depth; } // 這一輪四個方向都公平算完了，才採用
      if (depth >= MIN_GUARANTEED_DEPTH && performance.now() > deadline) break;
    }
    lastSearchDepth = reachedDepth;
    window.__2048BotLastDepth = reachedDepth;
    return best;
  }

  function isOverlayShown() { return !document.getElementById('overlay').classList.contains('hidden'); }
  function isContinueShown() { return !document.getElementById('overlay-continue').classList.contains('hidden'); }
  function isUndoEnabled() {
    const btn = document.getElementById('undo');
    return !!btn && !btn.disabled;
  }

  window.__2048BotStop = false;
  window.__2048BotRunning = false;
  window.__2048BotLog = [];
  window.__2048BotMoves = 0;
  window.__2048BotAttempts = 0;
  window.__2048BotBest = 0;
  window.__2048BotRerolls = 0;
  window.__2048BotTarget = TARGET_SCORE; // 中途可改：window.__2048BotTarget = 50000

  function currentScore() {
    return parseInt(document.getElementById('score').textContent, 10) || 0;
  }

  function topTwoTiles(flat) {
    const vals = Array.from(flat).filter((v) => v > 0).sort((a, b) => b - a);
    return { max: vals[0] || 0, second: vals[1] || 0 };
  }

  async function loop() {
    window.__2048BotRunning = true;
    while (!window.__2048BotStop) {
      const score = currentScore();
      if (score >= window.__2048BotTarget) {
        const { max: targetMax, second: targetSecond } = topTwoTiles(readBoard());
        window.__2048BotLog.push('reached target, score=' + score + ', max=' + targetMax + ', second=' + targetSecond);
        console.log('2048 bot: 已達目標分數', window.__2048BotTarget, '，目前分數 =', score,
          '，最大 =', targetMax, '，第二大 =', targetSecond, '，共試了', window.__2048BotAttempts + 1, '局，自動停止');
        window.__2048BotStop = true;
        break;
      }
      if (isOverlayShown()) {
        if (isContinueShown()) {
          document.getElementById('overlay-continue').click(); // 已達 2048，按繼續，目標是刷更高分/更大數字
          await waitForBoardSettle();
          continue;
        }
        const finalScore = currentScore();
        const { max: maxTile, second: secondTile } = topTwoTiles(readBoard());
        window.__2048BotAttempts++;
        window.__2048BotBest = Math.max(window.__2048BotBest, finalScore);
        window.__2048BotLog.push('attempt ' + window.__2048BotAttempts + ' over, score=' + finalScore + ', max=' + maxTile + ', second=' + secondTile);
        if (window.__2048BotLog.length > 30) window.__2048BotLog.shift();
        console.log('2048 bot: 第', window.__2048BotAttempts, '局結束，分數 =', finalScore,
          '，最大 =', maxTile, '，第二大 =', secondTile, '，自動重開');
        resetCornerLock(); // 新的一局重新選一次要鎖定哪個角落，不沿用上一局的選擇
        document.getElementById('overlay-restart').click();
        await waitForBoardSettle();
        continue;
      }
      const board = readBoard();
      const dir = bestMove(board);
      if (!dir) { await nextFrame(); continue; }

      // 只有「這步之前身體乾淨、這步卻被迫產生異常」才悔棋重骰，技巧細節見攻略.md
      const wasBodyCleanBeforeMove = isBodyClean(board);
      fireArrow(dir);
      window.__2048BotMoves++;
      await waitForBoardSettle();

      let rerolls = 0;
      while (
        rerolls < MAX_REROLLS && isUndoEnabled() &&
        wasBodyCleanBeforeMove && !isBodyClean(readBoard())
      ) {
        document.getElementById('undo').click();
        await waitForBoardSettle();
        fireArrow(dir); // 同一個方向重下，賭下一次隨機生成的位置/數值比較好
        window.__2048BotMoves++;
        rerolls++;
        window.__2048BotRerolls++;
        await waitForBoardSettle();
      }
    }
    window.__2048BotRunning = false;
  }

  window.__2048BotResume = function () {
    if (window.__2048BotRunning) {
      console.log('2048 bot: 現在就在跑了，不用重複啟動');
      return;
    }
    window.__2048BotStop = false;
    loop();
    console.log('2048 bot: 已繼續，目前分數 =', document.getElementById('score').textContent);
  };

  loop();
  console.log('2048 auto-play bot started. Target score:', TARGET_SCORE);
  console.log('暫停腳本: window.__2048BotStop = true　　繼續腳本: window.__2048BotResume()');
})();
