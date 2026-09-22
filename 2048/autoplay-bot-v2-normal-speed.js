/**
 * 2048（ychung1998.github.io/game-2048 版）自動遊玩腳本 —— 「顧尾巴」版
 *
 * 這是照玩家本人親口描述的手動技巧寫的版本。玩家本人用嚴格蛇形手動衝到
 * 289556 分／16384，講的技巧原文：
 *   「角落+蛇形，然後永遠只在意蛇形的尾巴，其它都不管，但如果尾巴跟頭中間有
 *     其它小數字，就努力把它變大」
 *   「固定在某一個角落後就不動了，合併都是從尾到頭，不用這麼常悔棋，只有在
 *     被迫離開、原本角落被擋住才悔，尾巴被其它小數字擋住時也可以悔棋，一樣
 *     是在被迫離開的時候」
 * 拆解成幾件事：
 * 1. 角落 + 蛇形：選定一個角落後整局鎖定不變，見 updateActiveCorner()。
 * 2. 只在意尾巴：蛇形路徑「數值最小的那一段」才是每一步真正需要盯著判斷的地方
 *    ——新方塊都從那邊進來，那裡的整齊度、有沒有空間收新方塊，直接決定接下來
 *    好不好走，見 isTailHealthy() 與 evaluate() 裡的 tailBonus。
 * 3. 頭尾中間出現異常的小數字（該是大數字的位置卻很小），要主動把它養大合併掉
 *    ——見 evaluate() 裡的 anomalyPenalty / BODY_MERGE_READY_BONUS。
 * 4. 悔棋只在三種「被迫離開原本健康狀態」的情況才觸發：角落被擋
 *    （isCornerAnchored/isCornerBlocked）、尾巴被卡死（isTailHealthy）、身體
 *    出現新異常（isBodyClean/bodyAnomalyPenalty），見主迴圈。悔棋本質是賭
 *    「下一次隨機生成的位置能避開」，救不了本來就存在的舊問題。
 *
 * 使用方式：
 * 1. （可選）修改下面的 TARGET_SCORE，改成你想衝到的分數，預設 Infinity（不設上限）
 * 2. 打開 https://ychung1998.github.io/game-2048/
 * 3. 打開瀏覽器 DevTools 的 Console
 * 4. 貼上這整段程式碼並按 Enter
 * 5. 腳本會自動判斷方向、模擬按鍵，贏了（跳出「繼續」彈窗）會自動按繼續；
 *    分數達到 TARGET_SCORE 才會真正停止。**輸了不會整個停掉**——新方塊生成是真
 *    隨機，單局提前死掉只代表運氣不好，不代表方法錯，所以「遊戲結束」時會自動按
 *    重新開始、再試下一局，直到某一局分數達標為止（見 __2048BotAttempts / __2048BotBest）。
 *    腳本啟動後也可以隨時打 `window.__2048BotTarget = 50000` 中途改目標分數，
 *    不用重新貼腳本。
 * 6. 暫停：`window.__2048BotStop = true`（跑完當下這一步就停，盤面、分數都還在）。
 *    繼續：同一個分頁、同一次貼上腳本的 Console session 裡，打
 *    `window.__2048BotResume()` 就會接著現在的盤面繼續玩，不用重貼腳本。
 *    如果分頁重整過或整個關掉重開，腳本的變數會消失，必須重新貼一次整份腳本
 *    （但這只是腳本要重新啟動，遊戲的最高分紀錄存在 localStorage，不會不見）。
 *
 * 重要：因為是真隨機，TARGET_SCORE 再高、重試再多次也不是「保證」達得到，只是
 * 每多一次試驗，達標機率就往上疊加一點——這是機率問題，不是腳本設定問題。
 *
 * 破解可能性（分析結論）：
 * - game-logic.mjs 的新方塊生成用未加種子的原生 Math.random()，是真隨機，不能
 *   靠找隨機數漏洞取巧。
 * - 「最高分」「歷史紀錄」只存在 localStorage、沒有任何校驗，技術上可以竄改，
 *   但那只是騙自己瀏覽器，這份腳本沒有用這條路。
 */
(function () {
  const TARGET_SCORE = Infinity; // 改成你想衝到的分數（例如 50000），達到就自動停止；不想設上限就留 Infinity
  const MOVE_DELAY_MS = 170; // 等滑動動畫(SLIDE_MS=90)+合併特效(220ms)收尾後再讀盤，太快會讀到動畫中的殘影
  const MAX_REROLLS = 6; // 同一步最多悔棋重骰幾次，避免極端情況下卡在無限迴圈
  const DIRS = ['up', 'down', 'left', 'right'];
  const KEY_OF = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };

  function fireArrow(dir) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: KEY_OF[dir], bubbles: true, cancelable: true }));
  }

  // ---- 讀盤：從 .tile 的 dataset.v + style.left/top 反推 4x4 board ----
  function readBoard() {
    const boardEl = document.getElementById('board');
    const padding = 10, gap = 10;
    const inner = boardEl.clientWidth - padding * 2 - gap * 3;
    const cellSize = inner / 4;
    const step = cellSize + gap;
    const board = Array.from({ length: 4 }, () => Array(4).fill(0));
    document.querySelectorAll('#board .tile').forEach((t) => {
      const left = parseFloat(t.style.left);
      const top = parseFloat(t.style.top);
      const c = Math.round((left - padding) / step);
      const r = Math.round((top - padding) / step);
      const v = parseInt(t.dataset.v, 10);
      if (r >= 0 && r < 4 && c >= 0 && c < 4) {
        board[r][c] = Math.max(board[r][c], v); // 動畫交界時可能有殘影，取較大值保險
      }
    });
    return board;
  }

  // ---- 純函式的盤面模擬（用來搜尋，不影響真實 DOM/遊戲）----
  function moveLeft(board) {
    let moved = false;
    let gained = 0;
    const result = board.map((row) => {
      const nums = row.filter((v) => v !== 0);
      const merged = [];
      for (let i = 0; i < nums.length; i++) {
        if (i < nums.length - 1 && nums[i] === nums[i + 1]) {
          const val = nums[i] * 2;
          merged.push(val);
          gained += val;
          i++;
        } else {
          merged.push(nums[i]);
        }
      }
      while (merged.length < 4) merged.push(0);
      return merged;
    });
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (result[r][c] !== board[r][c]) moved = true;
      }
    }
    return { board: result, moved, gained };
  }
  function reverseRows(b) { return b.map((row) => row.slice().reverse()); }
  function transpose(b) { return b[0].map((_, c) => b.map((row) => row[c])); }
  function simulateMove(board, dir) {
    let b = board;
    let didTranspose = false;
    let didReverse = false;
    if (dir === 'up' || dir === 'down') { b = transpose(b); didTranspose = true; }
    if (dir === 'right' || dir === 'down') { b = reverseRows(b); didReverse = true; }
    const { board: moved, moved: didMove, gained } = moveLeft(b);
    let out = moved;
    if (didReverse) out = reverseRows(out);
    if (didTranspose) out = transpose(out);
    return { board: out, moved: didMove, gained };
  }
  function emptyCells(board) {
    const cells = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === 0) cells.push([r, c]);
      }
    }
    return cells;
  }

  // ---- 蛇形路徑（角落 + 名次由高到低排到尾巴）----
  // 只留 4 種旋轉（每個角落剛好對應一種走法），不加鏡射——鏡射會讓同一個角落
  // 有兩種走法互搶，分數在兩者間抖動，盤面看起來亂跳。
  const SNAKE_RANKS = [
    [15, 14, 13, 12],
    [8, 9, 10, 11],
    [7, 6, 5, 4],
    [0, 1, 2, 3],
  ];
  function rotateMatrix(m) {
    const n = m.length;
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => m[n - 1 - c][r]));
  }
  const SNAKE_VARIANTS = [];
  (function buildSnakeVariants() {
    let m = SNAKE_RANKS;
    for (let i = 0; i < 4; i++) { SNAKE_VARIANTS.push(m); m = rotateMatrix(m); }
  })();
  // 把權重矩陣轉成「名次由高到低」的座標清單：order[0] 是角落（頭），
  // order[15] 是蛇形終點（尾巴最末端）。
  function buildOrder(wm) {
    const order = [];
    for (let rank = 15; rank >= 0; rank--) {
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (wm[r][c] === rank) order.push([r, c]);
        }
      }
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
  // 哪個角落」，是選定一個之後整局都不再換。這點跟 evaluate() 的其他部分不同：
  // 那些都是「每次對當下盤面直接算，不看歷史」，這裡刻意例外，因為玩家本人的
  // 真實做法就是要鎖住不變，不是要它隨盤面自適應。開局第一次呼叫時挑一次
  // （用當下盤面找最貼合的角落），之後整局鎖死，直到下一局重新開始才重選。
  let cornerLocked = false;
  let activeIdx = 0;
  let activeOrder = SNAKE_ORDERS[0];
  let cornerR = activeOrder[0][0];
  let cornerC = activeOrder[0][1];
  function resetCornerLock() {
    cornerLocked = false;
  }
  function updateActiveCorner(board) {
    if (cornerLocked) return;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < SNAKE_VARIANTS.length; i++) {
      const wm = SNAKE_VARIANTS[i];
      let score = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (board[r][c]) score += weightedValue(board[r][c]) * wm[r][c];
        }
      }
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    activeIdx = bestIdx;
    activeOrder = SNAKE_ORDERS[bestIdx];
    cornerR = activeOrder[0][0];
    cornerC = activeOrder[0][1];
    cornerLocked = true;
  }
  function snakeValue(board) {
    const wm = SNAKE_VARIANTS[activeIdx];
    let score = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c]) score += weightedValue(board[r][c]) * wm[r][c];
      }
    }
    return score;
  }
  // 「被迫離開角落、角落被擋住」判定，給重骰用（見下面迴圈）。
  function isCornerAnchored(board) {
    const maxTile = Math.max(...board.flat());
    return maxTile > 0 && board[cornerR][cornerC] === maxTile;
  }
  function isCornerBlocked(board) {
    const cornerVal = board[cornerR][cornerC];
    if (cornerVal === 0) return false; // 空的還能補救，不算卡死
    const maxTile = Math.max(...board.flat());
    return cornerVal < maxTile;
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

  // 「尾巴被其它小數字擋住、被迫離開」判定，給重骰用——跟角落那組（isCornerAnchored
  // / isCornerBlocked）同一個精神，只是換成尾巴的定義：尾巴範圍內只要「有空格」
  // 或「有相鄰可合併的一對」，就代表還能繼續運作（健康）；塞滿又沒有能合併的，
  // 代表尾巴被卡死，這時候如果是被迫走到這一步（沒有更好的選擇），才值得重骰
  // 賭下一次生成位置能讓尾巴繼續有得動。
  function isTailHealthy(board) {
    const order = activeOrder;
    const tailStart = 16 - TAIL_SIZE;
    for (let i = tailStart; i < 16; i++) {
      const [r, c] = order[i];
      if (board[r][c] === 0) return true;
    }
    for (let i = tailStart; i < 15; i++) {
      const [r1, c1] = order[i];
      const [r2, c2] = order[i + 1];
      if (board[r1][c1] !== 0 && board[r1][c1] === board[r2][c2]) return true;
    }
    return false;
  }

  // 身體異常扣分——抽成獨立函式，evaluate() 跟 isBodyClean() 共用同一套計算，
  // 不要各寫一份，避免以後改一邊忘了改另一邊。
  function bodyAnomalyPenalty(board) {
    const order = activeOrder;
    const tailStart = 16 - TAIL_SIZE;
    let penalty = 0;
    for (let i = 1; i < tailStart; i++) {
      const [pr, pc] = order[i - 1];
      const [r, c] = order[i];
      const prevVal = weightedValue(board[pr][pc]);
      const curVal = weightedValue(board[r][c]);
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
  function isBodyClean(board) {
    return bodyAnomalyPenalty(board) <= BODY_DIRTY_THRESHOLD;
  }

  function evaluate(board) {
    const order = activeOrder; // 用鎖定的角落，不重挑
    const tailStart = 16 - TAIL_SIZE; // index 1..tailStart-1 是身體，tailStart..15 是尾巴
    const anomalyPenalty = bodyAnomalyPenalty(board);

    let tailBonus = 0;
    for (let i = tailStart; i < 16; i++) {
      const [r, c] = order[i];
      if (board[r][c] === 0) tailBonus += TAIL_EMPTY_WEIGHT;
    }
    // 合併就緒獎勵：尾巴用 TAIL_MERGE_READY_BONUS，身體（頭尾中間）用
    // BODY_MERGE_READY_BONUS——身體出現異常小數字時，這裡會直接獎勵「把它
    // 合併掉」的方向，不是只靠 anomalyPenalty 被動扣分。
    for (let i = 0; i < 15; i++) {
      const [r1, c1] = order[i];
      const [r2, c2] = order[i + 1];
      if (board[r1][c1] !== 0 && board[r1][c1] === board[r2][c2]) {
        tailBonus += (i >= tailStart) ? TAIL_MERGE_READY_BONUS : BODY_MERGE_READY_BONUS;
      }
    }

    return snakeValue(board) - anomalyPenalty * ANOMALY_PENALTY_WEIGHT + tailBonus + emptyCells(board).length * EMPTY_WEIGHT;
  }

  // ---- expectimax：玩家層取 4 個方向中分數最高者，機率層對每個空格的 2/4 取期望值 ----
  function boardKey(board) {
    let key = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) key += board[r][c] + ',';
    return key;
  }

  function search(board, depth, isPlayerTurn, cache) {
    if (depth === 0) return evaluate(board);
    const key = boardKey(board) + '|' + depth + '|' + (isPlayerTurn ? 1 : 0);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let result;
    if (isPlayerTurn) {
      let best = -Infinity;
      for (const dir of DIRS) {
        const { board: nb, moved } = simulateMove(board, dir);
        if (!moved) continue;
        const score = search(nb, depth - 1, false, cache);
        if (score > best) best = score;
      }
      result = best === -Infinity ? evaluate(board) : best;
    } else {
      const cells = emptyCells(board);
      if (cells.length === 0) {
        result = search(board, depth - 1, true, cache);
      } else {
        let total = 0;
        for (const [r, c] of cells) {
          const b2 = board.map((row) => row.slice());
          b2[r][c] = 2;
          total += 0.9 * search(b2, depth - 1, true, cache);
          const b4 = board.map((row) => row.slice());
          b4[r][c] = 4;
          total += 0.1 * search(b4, depth - 1, true, cache);
        }
        result = total / cells.length;
      }
    }
    cache.set(key, result);
    return result;
  }

  // iterative deepening：deadline 只在「一整輪（四個方向都用同一深度算完）」
  // 之間檢查，search() 本身不知道 deadline 存在、永遠把交代的深度完整算完，
  // 四個方向保證公平；只有「要不要再往下一輪」這個決定看時間夠不夠。
  const SEARCH_TIME_BUDGET_MS = 150; // 每一步的時間預算；數字越大判斷越準，腳本也跑更慢
  // 盤面上已經有大異常（例如該放最大值的位置卻卡著小很多的數字）時，多花點
  // 時間往下想——悔棋只能救「這一步剛弄髒」的情況，已經卡著一段時間的異常
  // 悔棋不會管，只能靠搜尋看遠一點，找有沒有辦法趁機會把它救回來、或至少不要
  // 讓情況更糟。門檻沿用 BODY_DIRTY_THRESHOLD，跟悔棋判定「多大算異常」一致。
  const EXTENDED_SEARCH_TIME_BUDGET_MS = 400;
  const MAX_SEARCH_DEPTH = 9; // 安全上限，避免空格很少時每層太便宜、沒完沒了地往下挖
  function bestMove(board) {
    updateActiveCorner(board); // 只在還沒鎖定時挑一次，鎖定後這局都不再重選
    const searchBudget = bodyAnomalyPenalty(board) > BODY_DIRTY_THRESHOLD
      ? EXTENDED_SEARCH_TIME_BUDGET_MS
      : SEARCH_TIME_BUDGET_MS;
    const deadline = performance.now() + searchBudget;
    let best = null;
    for (let depth = 2; depth <= MAX_SEARCH_DEPTH; depth++) {
      const cache = new Map(); // 換深度就要換新的 cache，不同深度的搜尋結果不能共用
      let localBest = null;
      let localBestScore = -Infinity;
      for (const dir of DIRS) {
        const { board: nb, moved } = simulateMove(board, dir);
        if (!moved) continue;
        const score = search(nb, depth - 1, false, cache); // 沒有 deadline 參數，保證完整算完
        if (score > localBestScore) { localBestScore = score; localBest = dir; }
      }
      if (localBest) best = localBest; // 這一輪四個方向都公平算完了，才採用
      if (performance.now() > deadline) break; // 只在完整一輪結束後才檢查要不要停
    }
    return best;
  }

  function isOverlayShown() { return !document.getElementById('overlay').classList.contains('hidden'); }
  function isContinueShown() { return !document.getElementById('overlay-continue').classList.contains('hidden'); }
  function isUndoEnabled() {
    const btn = document.getElementById('undo');
    return !!btn && !btn.disabled;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  function topTwoTiles(board) {
    const vals = board.flat().filter((v) => v > 0).sort((a, b) => b - a);
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
          await sleep(MOVE_DELAY_MS);
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
        await sleep(MOVE_DELAY_MS);
        continue;
      }
      const board = readBoard();
      const dir = bestMove(board);
      if (!dir) { await sleep(MOVE_DELAY_MS); continue; } // 理論上不該發生（canMove 為 false 時應該已顯示 overlay）

      // 悔棋（重骰）的時機：玩家本人明確講「不用這麼常悔棋，只有在被迫離開、
      // 原本角落被擋住才悔」，「尾巴被其它小數字擋住時也可以悔棋，一樣是在
      // 被迫離開的時候」。這裡只在下面三種情況才悔棋重骰，賭下一次生成位置
      // 能避開卡死：
      // 1. 這步之前角落還卡著最大值，這步卻被迫離開角落，離開後角落格子被新
      //    生成的方塊卡住（不是空著等之後補）——見 isCornerAnchored/isCornerBlocked。
      // 2. 這步之前尾巴還健康（有空格或有可合併的一對），這步卻被迫讓尾巴塞滿
      //    卡死——見 isTailHealthy。
      // 3. 這步之前身體是乾淨的（沒有異常小數字），這步卻被迫產生異常——見
      //    isBodyClean/bodyAnomalyPenalty。已經存在的舊異常不重骰，重骰救不了
      //    它、只會浪費重骰次數，只有「這步之前還乾淨、這步卻被迫弄髒」才值得
      //    賭下一次隨機生成能避開。
      //
      // 這招只能救「剛抽到的爛運氣」，救不了已成定局的死盤：網站自己的邏輯在
      // 「真的無路可走」或「第一次湊到 2048」那一瞬間就會把悔棋鎖死
      // （script.js 對應那兩處都寫死 prevSnapshot = null，並附註「遊戲已明確結束，
      // 不可再悔棋」「紀錄已定案，禁止悔棋改變已記錄的結果」），所以 isUndoEnabled()
      // 到那時一定是 false，下面的迴圈會自然跳過、不會硬悔——這是刻意的邊界，
      // 不是漏掉沒處理。
      const wasAnchoredBeforeMove = isCornerAnchored(board);
      const wasTailHealthyBeforeMove = isTailHealthy(board);
      const wasBodyCleanBeforeMove = isBodyClean(board);
      fireArrow(dir);
      window.__2048BotMoves++;
      await sleep(MOVE_DELAY_MS);

      let rerolls = 0;
      while (
        rerolls < MAX_REROLLS && isUndoEnabled() &&
        ((wasAnchoredBeforeMove && isCornerBlocked(readBoard()))
          || (wasTailHealthyBeforeMove && !isTailHealthy(readBoard()))
          || (wasBodyCleanBeforeMove && !isBodyClean(readBoard())))
      ) {
        document.getElementById('undo').click();
        await sleep(MOVE_DELAY_MS);
        fireArrow(dir); // 同一個方向重下，賭下一次隨機生成的位置/數值比較好
        window.__2048BotMoves++;
        rerolls++;
        window.__2048BotRerolls++;
        await sleep(MOVE_DELAY_MS);
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
  console.log('2048 auto-play bot（顧尾巴版）started. Target score:', TARGET_SCORE, '(輸了會自動重開再試，不會整個停掉；只有被迫離開角落、尾巴卡住、或身體出現新異常時才悔棋重骰)');
  console.log('查詢狀態: window.__2048BotLog / window.__2048BotMoves / window.__2048BotAttempts / window.__2048BotBest / window.__2048BotRerolls');
  console.log('中途改目標分數: window.__2048BotTarget = 數字');
  console.log('暫停腳本: window.__2048BotStop = true　　繼續腳本: window.__2048BotResume()');
})();
