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

  // ---- Turbo 動畫：把全站 transition/animation 時長壓到接近 0 ----
  // 純視覺效果，讀盤正確性不依賴它（讀盤是等 DOM 穩定，見下方 waitForBoardSettle）。
  // 刻意設 0.01s 而不是 0s：CSS Transitions 規格對 duration:0 不保證觸發
  // transitionend，遊戲若拿這個事件排程下一步，設 0 反而可能卡住。
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

  // ---- 讀盤等待：先等過網站自己的落子延遲，再等盤面真正穩定 ----
  // 讀 script.js 原始碼發現：這個網站的按鍵處理是「立刻把現有方塊滑到最終位置
  // （同步設定 style.left/top），但真正套用結果（含新方塊生成、加分）是透過
  // `setTimeout(() => applyAnimResult(...), SLIDE_MS)` 延後執行的，SLIDE_MS 是
  // 網站寫死的常數 = 90（跟我們壓縮的 CSS 動畫時長無關，改 CSS 不會讓它變快）。
  // 也就是說按下方向鍵之後，現有方塊的位置會立刻更新，但新方塊要等 90ms 後才會
  // 出現在 DOM 裡。如果只靠「連續兩個影格沒變化」判斷穩定，在那 90ms 補上新方塊
  // 之前，畫面很可能已經連續兩影格沒變化了（因為位置已經是同步設好的最終值），
  // 會被誤判成「穩定」，讀到一個少一顆方塊的舊盤面——這正是搜尋變快之後才會踩到
  // 的雷：以前單步要 ~130ms，天然蓋過這 90ms；現在單步只要 ~25ms，常常搶在 90ms
  // 之前就讀盤，導致盤面失真、分數崩掉。修法是先強制等滿 MIN_SETTLE_FLOOR_MS
  // （90 加一點安全邊際）才開始用訊號穩定判斷，兩者都滿足才真正回傳。
  // 用 setTimeout 而不是 requestAnimationFrame 來輪詢：分頁被瀏覽器排到背景時，
  // Chrome 會直接暫停 rAF（完全不觸發，不是變慢），實測背景分頁裡 `await
  // requestAnimationFrame` 可以卡住超過 3 秒都不resolve；setTimeout 在背景分頁
  // 只會被節流（大約每秒 1 次），變慢但不會整個卡死。這是舊版（固定 sleep）能在
  // 背景跑、改成 rAF 輪詢後卻不能的原因——舊版從來不依賴 rAF。
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

  // ---- 讀盤：從 .tile 的 dataset.v + style.left/top 反推 4x4 board ----
  // 盤面統一用長度 16 的 Int32Array 表示（index = r*4+c），不再用巢狀陣列——
  // 單一表示法貫穿讀盤/模擬/評分，少一層轉換，也是 Turbo 引擎的一部分。
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
        flat[i] = Math.max(flat[i], v); // 動畫交界時可能有殘影，取較大值保險
      }
    });
    return flat;
  }

  // ---- 零記憶體配置滑動核心：LINES 表 + 共用 scratch，不再 transpose/reverse/filter ----
  // 每個方向的 4 條「線」，數值以線上的走訪順序（index 0 = 該線最靠近目的地那端）
  // 列出對應的 flat index。例如 left 的第一條線是第 0 列，走訪順序就是 0,1,2,3
  // （原本就是往左靠的順序）；right 的第一條線一樣是第 0 列，但走訪順序反過來
  // （3,2,1,0），因為要往右靠。
  const LINES = {
    left:  [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]],
    right: [[3, 2, 1, 0], [7, 6, 5, 4], [11, 10, 9, 8], [15, 14, 13, 12]],
    up:    [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15]],
    down:  [[12, 8, 4, 0], [13, 9, 5, 1], [14, 10, 6, 2], [15, 11, 7, 3]],
  };
  const slideScratch = new Int32Array(4); // 每條線最多 4 格，重複使用同一塊緩衝
  // slideInto() 把結果寫進呼叫端給的 out，回傳有沒有真的移動——搜尋樹用共用
  // 暫存盤面呼叫它，整棵樹跑下來一次記憶體配置都不需要（見下方 poolBoard()）。
  // 合併得分放在 lastGained，避免為了回傳兩個值而配置物件。
  let lastGained = 0;
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
  // 會配置新陣列的包裝版，給搜尋樹以外的呼叫端用（搜尋熱路徑一律用 slideInto）。
  function simulateMove(flat, dir) {
    const out = new Int32Array(16);
    const moved = slideInto(flat, dir, out);
    return { board: out, moved, gained: lastGained };
  }
  // ---- 蛇形路徑（角落 + 名次由高到低排到尾巴），全部以 flat index 表示 ----
  // 只留 4 種旋轉（每個角落剛好對應一種走法），不加鏡射——鏡射會讓同一個角落
  // 有兩種走法互搶，分數在兩者間抖動，盤面看起來亂跳。
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
  // 把權重矩陣轉成「名次由高到低」的 flat index 清單：order[0] 是角落（頭），
  // order[15] 是蛇形終點（尾巴最末端）。
  function buildOrder(wm) {
    const order = [];
    for (let rank = 15; rank >= 0; rank--) {
      for (let i = 0; i < 16; i++) if (wm[i] === rank) order.push(i);
    }
    return order;
  }
  const SNAKE_ORDERS = SNAKE_VARIANTS.map(buildOrder);

  // 用「原始數值」而不是 log2：512 放錯地方的代價是 4 放錯地方的 128 倍，大數字
  // 自然極度不想亂動、小數字亂放幾乎不影響分數。門檻設在 32（而不是 128）是
  // 因為 32、64 這種中段數字重複散置也會浪費格子，一樣要維持蛇形，見下方
  // evaluate() 裡的門檻設定。
  const BIG_TILE_THRESHOLD = 32;
  const BIG_TILE_MULTIPLIER = 4;
  function weightedValue(v) {
    return v >= BIG_TILE_THRESHOLD ? v * BIG_TILE_MULTIPLIER : v;
  }

  // 玩家本人明確講：「固定在某一個角落後就不動了」——不是「每次都重新挑最像
  // 哪個角落」，是選定一個之後整局都不再換。開局第一次呼叫時挑一次（用當下
  // 盤面找最貼合的角落），之後整局鎖死，直到下一局重新開始才重選。
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

  // ---- 顧尾巴 + 抓異常：直接對應玩家本人講的判斷順序 ----
  // TAIL_SIZE：蛇形路徑最後幾格算「尾巴」，這是每一步真正該盯著看的地方
  // （新方塊從這裡進來）。中間（頭跟尾巴之間，index 1 ~ 15-TAIL_SIZE）算「身體」，
  // 身體排好之後基本上不用再管，除非出現異常。
  const TAIL_SIZE = 6;

  // 異常判定：沿蛇形路徑，名次越靠近頭（index 越小）應該數值越大（>=）。如果
  // 身體裡某一格（index i）的數值反而比它前一格（更靠近頭，index i-1）大，
  // 代表 index i-1 那格「應該大卻很小」——這就是玩家講的「頭尾中間有異常的小
  // 數字」。這裡不是「跟上一步比較」的 transition 規則，是每次都對當下盤面
  // 直接算違反了多少，讓 expectimax 自己去找「哪個方向能把這個異常合併養大、
  // 讓違反變小」，不需要另外寫一條「偵測到異常就特別加分」的特例規則。
  const ANOMALY_PENALTY_WEIGHT = 6;

  // 尾巴品質：空格數（有沒有位置收新方塊）+ 相鄰同數值的對數（隨時能合併，
  // 不會讓尾巴塞滿卡死）。這兩項只算在尾巴範圍內，才是真正對應「只在意尾巴」
  // ——身體/頭的品質已經由 snakeValue()（鎖定角落的權重矩陣算分）顧到了，
  // 不需要在這裡重複算。
  const TAIL_EMPTY_WEIGHT = 4;
  const TAIL_MERGE_READY_BONUS = 6;
  // 身體（頭尾中間）如果出現異常小數字，玩家本人講「就努力把它變大」——只有
  // 「異常存在就扣分」還不夠，扣分只代表「不喜歡」，不代表「主動去合併掉」；
  // 加一項「身體裡只要有相鄰兩格同數值就加分」，明確鼓勵 expectimax 選會把
  // 異常合併掉的方向，而不是放著扣分但沒有動力處理。
  const BODY_MERGE_READY_BONUS = 10;

  const EMPTY_WEIGHT = 8; // 全盤空格數，沿用先前驗證過的權重

  // 身體異常扣分——抽成獨立函式，evaluate() 跟 isBodyClean() 共用同一套計算，
  // 不要各寫一份，避免以後改一邊忘了改另一邊。
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
  // 「身體乾淨」判定，給重骰用。門檻不能設 0：小數字（2、4、8 這種）暫時卡在
  // 該大卻小的位置，是每一步都會自然發生、很快就會被合併掉的正常波動，不是
  // 玩家講的「異常」，設 0 會變成幾乎每一步都在悔棋，跟「不用這麼常悔棋」的
  // 要求相反。只有落差大到真的像「128 卡在該放 1024 的位置」這種等級，才算
  // 弄髒，才值得賭下一次隨機生成能避開。
  const BODY_DIRTY_THRESHOLD = 32;
  function isBodyClean(flat) {
    return bodyAnomalyPenalty(flat) <= BODY_DIRTY_THRESHOLD;
  }

  const SMOOTHNESS_WEIGHT = 25;
  function smoothness(flat) {
    let penalty = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const i = r * 4 + c;
        const v = flat[i];
        if (v === 0) continue;
        const lv = Math.log2(v);
        if (c < 3) {
          const rv = flat[i + 1];
          if (rv !== 0) penalty += Math.abs(lv - Math.log2(rv));
        }
        if (r < 3) {
          const dv = flat[i + 4];
          if (dv !== 0) penalty += Math.abs(lv - Math.log2(dv));
        }
      }
    }
    return penalty;
  }
  function evaluate(flat) {
    const order = activeOrder; // 用鎖定的角落，不重挑
    const tailStart = 16 - TAIL_SIZE; // index 1..tailStart-1 是身體，tailStart..15 是尾巴
    const anomalyPenalty = bodyAnomalyPenalty(flat);

    let tailBonus = 0;
    for (let i = tailStart; i < 16; i++) {
      if (flat[order[i]] === 0) tailBonus += TAIL_EMPTY_WEIGHT;
    }
    // 合併就緒獎勵：尾巴用 TAIL_MERGE_READY_BONUS，身體（頭尾中間）用
    // BODY_MERGE_READY_BONUS——身體出現異常小數字時，這裡會直接獎勵「把它
    // 合併掉」的方向，不是只靠 anomalyPenalty 被動扣分。
    for (let i = 0; i < 15; i++) {
      if (flat[order[i]] !== 0 && flat[order[i]] === flat[order[i + 1]]) {
        tailBonus += (i >= tailStart) ? TAIL_MERGE_READY_BONUS : BODY_MERGE_READY_BONUS;
      }
    }

    let empties = 0;
    for (let k = 0; k < 16; k++) if (flat[k] === 0) empties++;

    return snakeValue(flat) - anomalyPenalty * ANOMALY_PENALTY_WEIGHT + tailBonus + empties * EMPTY_WEIGHT - smoothness(flat) * SMOOTHNESS_WEIGHT;
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
  // 快取容器：依 (剩餘深度 << 1 | 是否玩家回合) 分槽，每槽是 Map<lo, Map<hi, 分數>>。
  function newCache() { return []; }

  // ---- 每層專用暫存：讓整棵搜尋樹不需要任何記憶體配置 ----
  // 每一層搜尋深度各有一組暫存（盤面 / 空格清單 / criticality 分數），同一層的
  // 各個分支輪流覆寫它。安全性來自「每個節點只寫自己這層的暫存、只讀上一層寫給
  // 它的那塊」：子節點的剩餘深度一定比父節點小 1，所以子樹永遠不會動到父節點正在
  // 讀的那塊。
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

  // ---- 深層分支機率剪枝：空格數 > PRUNE_EMPTY_THRESHOLD 時，只對「最貼近現有
  // 方塊」的 PRUNE_KEEP 個空格完整展開 2/4 兩種分支，其餘空格只展開機率占多數
  // 的 2（跳過 4）——那些格子離主戰場遠，10% 的 4 對整體評分影響很小，犧牲這點
  // 精度換取節點數大幅減少。criticality 用「四個方向的已有方塊加權值之和」衡量
  // 「這格離現有大數字有多近」，不是隨便挑，貼近大數字的空格才是真正會影響
  // 下一步合併判斷的地方。 ----
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

  // ---- expectimax：玩家層取 4 個方向中分數最高者，機率層對每個空格的 2/4 取
  // 期望值（貼近戰場的空格）或只取 2（遠離戰場、被剪枝的空格）----
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
          // 依 criticality 由大到小排序，前 PRUNE_KEEP 個完整展開 2/4，其餘只展開 2。
          // 用插入排序就地排（最多 16 個元素），不配置任何暫存陣列；「相等時不往前移」
          // 是穩定排序，同分時維持格號由小到大的原順序。
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
          // 剪枝：遠離戰場的空格只展開機率占多數的 2，跳過 4，用來換取節點數減少。
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

  // iterative deepening + 保證最小深度：depth < MIN_GUARANTEED_DEPTH 時完全不看
  // 時間，一定先跑完才考慮要不要停；depth > MIN_GUARANTEED_DEPTH 時，開始下一輪
  // 之前先用「上一輪耗時 x GROWTH_ESTIMATE」預測這一輪大概要多久，預測會爆預算就
  // 不跑，避免深層搜尋暴衝拖慢單步時間（一輪跑完才檢查時間不夠，同一輪內部自己
  // 就可能暴增）。
  //
  // 預算設低（實測結論，見 2048/攻略.md 6.5 節）：分數對深度在深度 5 之後就飽和，
  // 搜到 6 層已經買到全部棋力，再深純粹燒 CPU；2048 的高分 = 單局品質 × 試了幾局，
  // 品質飽和後，剩下的槓桿是「同樣時間多跑幾局」，所以預算砍到剛好穩住深度 6。
  const SEARCH_TIME_BUDGET_MS = 25; // 每一步的時間預算；調大不會更強（深度 5 以後分數已飽和），只會更慢
  // 盤面上已經有大異常（例如該放最大值的位置卻卡著小很多的數字）時，多花點
  // 時間往下想——悔棋只能救「這一步剛弄髒」的情況，已經卡著一段時間的異常
  // 悔棋不會管，只能靠搜尋看遠一點，找有沒有辦法趁機會把它救回來、或至少不要
  // 讓情況更糟。門檻沿用 BODY_DIRTY_THRESHOLD，跟悔棋判定「多大算異常」一致。
  const EXTENDED_SEARCH_TIME_BUDGET_MS = 60;
  const MAX_SEARCH_DEPTH = 9; // 安全上限，避免空格很少時每層太便宜、沒完沒了地往下挖
  // 硬性深度保證：這個深度以下完全不檢查時間，也不做成長預測，確保就算遇到特別貴
  // 的盤面也一定會把飽和點（深度 5）以上的那一層算完。
  const MIN_GUARANTEED_DEPTH = 6;
  const GROWTH_ESTIMATE = 4; // 保守估計「深度 +1」耗時會乘上幾倍，用來預判下一輪值不值得跑
  let lastSearchDepth = 0; // 最近一步實際搜到的深度（見 bestMove 結尾）
  function bestMove(flat) {
    updateActiveCorner(flat); // 只在還沒鎖定時挑一次，鎖定後這局都不再重選
    const searchBudget = bodyAnomalyPenalty(flat) > BODY_DIRTY_THRESHOLD
      ? EXTENDED_SEARCH_TIME_BUDGET_MS
      : SEARCH_TIME_BUDGET_MS;
    const start = performance.now();
    const deadline = start + searchBudget;
    let best = null;
    let lastRoundMs = 0;
    let reachedDepth = 0;
    // 快取在同一次 bestMove 的各輪 iterative deepening 之間共用：鍵值本身就含
    // 「剩餘深度」與「輪到誰」，而 (盤面, 剩餘深度, 回合) 三者就唯一決定該節點的
    // 值，所以深一輪可以直接命中淺一輪算過的子樹。
    const cache = newCache();
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
    // 這一步實際跑完的最深一輪。搜尋速度變快的好處就是同樣的時間預算能跑到更深，
    // 所以直接把它記錄下來（window.__2048BotLastDepth）可以隨時確認現在到底
    // 搜到第幾層，不用憑感覺猜。
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

  // 盤面上最大跟第二大的方塊數值（不是去重後的名次，是實際數值排序前兩名，
  // 如果剛好有兩顆一樣大的方塊，最大跟第二大會顯示同一個數字，這是正確的）。
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
        // 這一局輸了，但還沒到目標分數：每一局都是獨立的隨機試驗，運氣差提前死掉
        // 不代表方法錯，所以不整個停掉，改成自動重開再試一次（累計最佳紀錄）。
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
      if (!dir) { await nextFrame(); continue; } // 理論上不該發生（canMove 為 false 時應該已顯示 overlay），沒有盤面變化，等一影格重新判斷即可

      // 悔棋（重骰）的時機：玩家本人一開始講「不用這麼常悔棋，只有在被迫離開、
      // 原本角落被擋住才悔」「尾巴被其它小數字擋住時也可以悔棋」，後來玩家本人
      // 把這條規則收窄成只剩一種情況——只有「蛇形從正常變異常」才悔棋重骰：這步
      // 之前身體是乾淨的（沒有異常小數字），這步卻被迫產生異常，才值得賭下一次
      // 隨機生成能避開——見 isBodyClean/bodyAnomalyPenalty。已經存在的舊異常不
      // 重骰，重骰救不了它、只會浪費重骰次數。角落被擋、尾巴卡死這兩種舊觸發
      // 條件已經拿掉，不再悔棋。
      //
      // 這招只能救「剛抽到的爛運氣」，救不了已成定局的死盤：網站自己的邏輯在
      // 「真的無路可走」或「第一次湊到 2048」那一瞬間就會把悔棋鎖死
      // （script.js 對應那兩處都寫死 prevSnapshot = null，並附註「遊戲已明確結束，
      // 不可再悔棋」「紀錄已定案，禁止悔棋改變已記錄的結果」），所以 isUndoEnabled()
      // 到那時一定是 false，下面的迴圈會自然跳過、不會硬悔——這是刻意的邊界，
      // 不是漏掉沒處理。
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

  // 手動打 window.__2048BotStop = true 只會讓迴圈跑完當下這一步就結束，並不會
  // 清掉盤面或關閉分頁——遊戲本身（board/score）還在，只是沒有腳本繼續按鍵而已。
  // 同一個分頁、同一次貼上腳本的 Console session 裡，之後想接著玩，
  // 打 window.__2048BotResume() 就會從目前盤面繼續，不用重貼整份腳本。
  // （如果分頁重整過或整個關掉重開，這個 closure 就消失了，那就得重新貼一次腳本，
  // 但那也只是重新啟動腳本，遊戲本身的最高分紀錄還是讀 localStorage，不會不見。）
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
