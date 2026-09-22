/**
 * 2048（ychung1998.github.io/game-2048 版）自動遊玩腳本
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
 * 悔棋＝重骰：這款遊戲的「悔棋」按鈕（一次只能悔回上一步）被拿來當「重骰」用——
 * 每步先用 expectimax 算出「這個方向所有可能新方塊」的期望分數，實際按下去後
 * 如果抽到的結果比期望值明顯差（差距超過 REROLL_MARGIN，不是隨便低於平均值就重骰——
 * 平均值本來就有一半的結果會落在它以下，那樣重骰太浮濫、只是在浪費時間），
 * 就悔棋、原地重下同一個方向，換一次新的隨機結果（最多重骰 MAX_REROLLS 次）。
 * 但這招救不了「已經死棋」的局面：網站自己的程式
 * 在「真的無路可走」或「第一次湊到 2048」那一瞬間，就會把悔棋直接鎖死
 * （`prevSnapshot = null`），此時已經來不及悔棋了——悔棋只能預防性地重骰
 * 「即將發生」的爛運氣，不能事後復活一個已經判定結束的局。
 *
 * 原理：
 * - 這個網站的 board/score 是 script.js 內 ES module 的區域變數，沒有掛在 window 上
 *   （不像 dino 遊戲的 Runner.instance_ 那樣直接公開），所以讀盤是靠反推 DOM：
 *   每個 .tile 元素的 dataset.v 是數值、style.left/top 是像素座標，配合
 *   tileGeometry()（padding=10, gap=10, cellSize=(棋盤寬-20-30)/4）算回 row/col。
 * - 按鍵一樣是 dispatchEvent 真正的 KeyboardEvent('keydown', {key:'ArrowLeft'})，
 *   跟真人按方向鍵效果相同（這個網站的 handler 只讀 e.key，不需要像 dino 那樣
 *   額外處理唯讀的 keyCode）。
 * - 移動方向的選擇用 expectimax 搜尋 + 啟發式評分，搜多深是「空格數 -> 固定深度」
 *   的表格（空格越少局面越關鍵搜越深），四個方向永遠用同一個深度、一定要都算完
 *   才互相比較，確保公平；轉置表（transposition table）快取不同按鍵順序繞回同一
 *   盤面的重算，純加速、不影響公平性。
 *
 * 評分函式的設計演變（誠實記錄，不是每個版本都比前一版好）：
 * 一開始用 monotonicity（log2 數值）+ smoothness + 固定角落的蛇形權重矩陣
 * （corner lock）+ 專門保護角落的硬懲罰 + 遠離角落方向的軟懲罰 + 大數字合併加成，
 * 疊了一堆各自針對「貼腳本看盤面抓到的某個具體問題」寫的規則。實測發現這樣改
 * 會一直是「修好一個、換個樣子復發」的循環（例如角落保護加強了，換成角落旁邊
 * 那格被大數字卡位；深度加大想多顧幾格，又因為前提條件太難成立而整條規則失效）
 * ——這是這種「每步比較前後、只看單一次轉換」的修法本身的天花板：防得了「這一步
 * 有沒有把已經排好的破壞掉」，防不了「連續好幾步、每一步單獨看都不違規，但累積
 * 起來還是讓最大值慢慢飄到盤面中間」。
 *
 * 後來參考公開實作 aj-r/2048-AI（https://github.com/aj-r/2048-AI，宣稱能衝到
 * 13 萬分以上）的 smart_ai.js，發現它的評分函式簡單得多：monotonicity 用「原始
 * 數值」而不是 log2，外加空格數，就這樣，沒有角落鎖定、沒有蛇形權重矩陣、沒有
 * 任何「不准大數字亂跑」的硬規則。關鍵差異：log2 會把數值差距壓縮得很平——
 * 4 跟 512 的 log2 只差 5（2 vs 9），亂放的代價跟一顆小數字放錯地方差不多量級，
 * 所以才需要另外疊一堆規則硬性保護大數字。改用原始數值，512 放錯地方的代價是
 * 4 放錯地方的 128 倍，大數字自然而然變得極度不想亂動，小數字（2、4 這種）
 * 亂放幾乎不影響分數——這正好符合我們想要的行為（在意大數字的排列、不在意
 * 小數字暫時亂放），而且是從評分函式的根本量級上得到這個行為，不是靠一條一條
 * 加規則硬湊出來的。這裡先採用這個思路重寫評分函式，拿掉前面那整套角落鎖定/
 * 蛇形矩陣/各種硬懲罰，換成「monotonicity 用原始數值＋空格數」這個更簡單版本。
 *
 * 但後來被玩家本人（用嚴格蛇形手動衝到 289556 分／16384 的真實紀錄，不是網路
 * 二手說法）打臉：「每列每欄各自單調」不等於「整個盤面接成一條蛇形」——貼盤面
 * 給他看，底部一整排遞減、上一排也同方向遞減，兩排接不起來，嚴格來說不算蛇形。
 * 這個第一手經驗比「aj-r 的弱版看起來分數也不錯」這個間接證據更可信，所以蛇形
 * 矩陣又加回來了——但不是走回頭路，是修正過的版本：矩陣本身沒有變（4 旋轉 x
 * 鏡射、每次都全部算一次取最高分），差別是現在權重矩陣裡的數值用「原始值 ×
 * weightedValue()（含大數字加權）」而不是 log2，這樣角落一旦坐了有份量的
 * 數字，分數差距大到不會再像以前那樣在幾個方向之間抖動；而且完全不用「跟上一步
 * 比較」的 transition-based 規則、也不用「鎖定角落」的狀態，每次都是對當下盤面
 * 重新算，沒有歷史依賴，不會重蹈之前「前提條件太難成立、規則整個失效」的覆轍。
 * 結論：原本的 monotonicity（原始數值＋空格數）整段被蛇形矩陣（一樣用原始數值
 * 加權，見 snakeScore()）取代，不是兩者並存——蛇形矩陣本身就隱含單調性
 * （沿蛇形路徑遞減，行/列自然也是單調的），不需要疊兩套規則各自表述。
 *
 * 破解可能性（分析結論）：
 * - 檢查過 game-logic.mjs：新方塊生成用未加種子的原生 Math.random()
 *   （90% 生 2、10% 生 4，位置也是 Math.random() 選空格），沒有可預測或可操縱
 *   的弱點，是真隨機，符合玩家的直覺猜測——這款遊戲**不能**靠找隨機數漏洞取巧。
 * - 「最高分」「歷史紀錄」只存在 localStorage（2048-best-score / 2048-history），
 *   完全沒有任何校驗，技術上可以在 Console 打
 *   `localStorage.setItem('2048-best-score', '999999999')` 直接偽造顯示的最高分，
 *   但這只是竄改瀏覽器本機顯示、不是真的破解遊戲邏輯，純作弊沒有意義，
 *   這份腳本沒有用這條路。
 * - 沒有找到像 dino 版網站那樣內建、可直接借用的「AI/機器人模式」，
 *   下面的走法邏輯是自己刻的 expectimax。
 */
(function () {
  const TARGET_SCORE = Infinity; // 改成你想衝到的分數（例如 50000），達到就自動停止；不想設上限就留 Infinity
  const MOVE_DELAY_MS = 170; // 等滑動動畫(SLIDE_MS=90)+合併特效(220ms)收尾後再讀盤，太快會讀到動畫中的殘影
  const MAX_REROLLS = 6; // 同一步最多悔棋重骰幾次，避免極端情況下卡在無限迴圈
  const REROLL_MARGIN = 1.5; // 實際結果要比期望值「明顯」差才重骰，不然單純低於平均值就重骰太頻繁
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

  // ---- 啟發式評分：蛇形路徑權重 + 空格數（原始數值，見檔頭「評分函式的設計演變」） ----
  // 用「原始數值」而不是 log2：512 放錯地方的代價是 4 放錯地方的 128 倍，大數字
  // 自然極度不想亂動、小數字亂放幾乎不影響分數，不需要再另外疊各種硬懲罰去
  // 強迫這件事——量級本身就做到了大半。
  //
  // 使用者要求更明確：128 以上的數字至少要維持排列整齊，128 以下亂放沒關係。
  // 原始數值本身已經隱含「越大越重要」，但沒有specifically 卡在 128 這個門檻。
  // 這裡用連續的加權（>= 門檻的數值再乘上一個倍數），不是「有維持住才罰破功」的
  // transition-based 硬規則——前面 CORNER_VACATE_PENALTY / isSnakeIntact 那套
  // 就是因為這種「跟歷史比較」的寫法太脆弱、牽一髮動全身才拿掉的。這裡純粹是
  // 「這個數值多重要」的權重問題，不牽扯「上一步是不是還排好」，不會重蹈覆轍。
  //
  // 實測抓到問題：門檻設 128 時，貼腳本看盤面會出現三顆分開的 32、兩顆分開的
  // 64（例如 16,32,64,32 / 32,64,256,1024），中間都隔著別的數字合不起來——32、
  // 64 這種「中段」數字在門檻以下完全不被重視，導致重複的中段數字一直沒有被
  // 優先合併掉，浪費格子。門檻下修到 32，讓 32 以上的數字都納入加權，才會真的
  // 在意「同樣數值的中段方塊是不是散得到處都是」。
  const BIG_TILE_THRESHOLD = 32;
  const BIG_TILE_MULTIPLIER = 4;
  function weightedValue(v) {
    return v >= BIG_TILE_THRESHOLD ? v * BIG_TILE_MULTIPLIER : v;
  }

  // 「每列每欄各自單調」不等於「整個盤面接成一條蛇形」：貼盤面給玩家本人看時，
  // 直接被抓到底部一整排遞減、上一排也同方向遞減，兩排接不起來（3,3)->(2,3)是
  // 降的，但 (2,3)->(2,2) 卻是升的，路徑在這裡斷掉）。玩家本人是實測靠嚴格蛇形
  // 衝到 289556 分／16384 的，這個經驗優先於「aj-r 的弱版看起來也有高分」這個
  // 間接證據，所以改回明確的蛇形路徑權重矩陣——但這次記取前面失敗的教訓：
  // - 不做「跟上一步比較、有維持住才罰」的 transition-based 規則（isSnakeIntact
  //   那套），改成每次都用當下盤面直接算分，不牽扯歷史，沒有「前提條件太難成立
  //   導致規則失效」的風險。
  // - 不做「鎖定一個角落、整局不再換」（updateActiveCorner 那套），改成每次都
  //   對 8 種方向（4 旋轉 x 鏡射）都算一次分數、取最高分。之前這樣做會在小盤面
  //   時因為分數太接近而一直換角落、越玩越亂，但那是因為當時用 log2 數值，
  //   量級差距太小才會抖動；現在改用原始數值（＋大數字加權），角落一旦坐了個
  //   有份量的數字，跟其他方向的分數差距會大到不可能再抖動，順便解決了舊版的
  //   角落亂跳問題，不用額外鎖定機制。
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
  // 貼腳本玩到一半又抓到一個真實案例：角落 1024 穩穩卡住，隔壁卻放了一顆「8」，
  // 隔幾格又冒出一顆脫節的「256」。查了才發現：4 旋轉 + 鏡射共 8 種變體裡，
  // 每個角落其實對應「兩種」走法（一種照列繞、一種照欄繞，例如角落在左下角時，
  // 一種是「沿最底那排先往右走」，另一種是「沿最左那欄先往上走」），這兩種走法
  // 對同一顆大數字來說都能讓它穩穩卡在角落，分數卻可能各有勝負，導致 AI 在這兩種
  // 走法之間切換——切換的當下盤面看起來就會很怪（在其中一種走法眼中「合理」的
  // 排列，換到另一種走法眼中就是「亂放」）。人類玩家不會這樣，選定一種繞法
  // （通常是沿著列走的鋸齒）就會一路用到底，不會因為個別小數字的擺放就換繞法。
  // 修法：只留 4 旋轉（每個角落剛好對應一種走法），拿掉鏡射那 4 種，徹底消除
  // 「同一個角落兩種走法互相搶」的問題，不是靠鎖定機制硬留住某一種，而是根本
  // 不讓它有得選。
  const SNAKE_VARIANTS = [];
  (function buildSnakeVariants() {
    let m = SNAKE_RANKS;
    for (let i = 0; i < 4; i++) { SNAKE_VARIANTS.push(m); m = rotateMatrix(m); }
  })();
  function snakeScore(board) {
    let best = -Infinity;
    for (const wm of SNAKE_VARIANTS) {
      let score = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (board[r][c]) score += weightedValue(board[r][c]) * wm[r][c];
        }
      }
      if (score > best) best = score;
    }
    return best;
  }
  const EMPTY_WEIGHT = 8; // 沿用 aj-r/2048-AI 驗證過的權重
  function evaluate(board) {
    return snakeScore(board) + emptyCells(board).length * EMPTY_WEIGHT;
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

  // 只搜一層機率節點（這個方向所有可能新方塊的期望分數），給悔棋重骰當基準用。
  function chanceExpectation(board) {
    return search(board, 1, false, new Map());
  }

  // 之前試過「給固定時間預算、時間到就砍」的 iterative deepening，那次失敗是
  // 因為 deadline 是 4 個方向共用同一個時間戳記、在同一輪裡依序算，時間如果在
  // 算到排序中間的方向才用完，後面的方向就被迫用粗略估計，等於暗中偏袒排前面
  // 的方向——問題出在「同一輪內公平性被打破」，不是「iterative deepening」這個
  // 做法本身有問題。這次修法：deadline 只在「一整輪（四個方向都用同一深度算
  // 完）」之間檢查，search() 本身完全不知道 deadline 存在、永遠會把交代的深度
  // 完整算完，四個方向在同一輪裡保證公平；只有「要不要再往下一輪（更深）」這個
  // 決定會看時間夠不夠，不會有任何一個方向在算到一半被砍。
  //
  // 動機：貼腳本玩到大數字（512）卡在盤面中間、兩邊都是小數字，不在任何角落——
  // 空格數 -> 固定深度的表格在空格多時只搜 3 步，這麼淺的深度看不到「現在這步
  // 造成的偏移，之後代價會多大」，等大數字長大到搜索深度勉強看得到時，往回搬
  // 的代價已經被判定不值得，就定住了。搜深一點才有機會提早看到、提早避開。
  const SEARCH_TIME_BUDGET_MS = 150; // 每一步的時間預算；數字越大判斷越準，腳本也跑更慢
  const MAX_SEARCH_DEPTH = 9; // 安全上限，避免空格很少時每層太便宜、沒完沒了地往下挖
  function bestMove(board) {
    const deadline = performance.now() + SEARCH_TIME_BUDGET_MS;
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
        document.getElementById('overlay-restart').click();
        await sleep(MOVE_DELAY_MS);
        continue;
      }
      const board = readBoard();
      const dir = bestMove(board);
      if (!dir) { await sleep(MOVE_DELAY_MS); continue; } // 理論上不該發生（canMove 為 false 時應該已顯示 overlay）

      // 悔棋當「重骰」：新方塊生成完全隨機，若這次實際抽到的結果比 expectimax
      // 算出的「這個方向所有可能新方塊」期望值明顯差（超過 REROLL_MARGIN），
      // 就悔棋、原地重下同一個方向，換一次新的隨機結果，直到不再明顯低於期望值、
      // 或重骰次數用完為止。單純低於平均值不算——平均值兩側本來就各半機率。
      //
      // 這招只能救「剛抽到的爛運氣」，救不了已成定局的死盤：網站自己的邏輯在
      // 「真的無路可走」或「第一次湊到 2048」那一瞬間就會把悔棋鎖死
      // （script.js 對應那兩處都寫死 prevSnapshot = null，並附註「遊戲已明確結束，
      // 不可再悔棋」「紀錄已定案，禁止悔棋改變已記錄的結果」），所以 isUndoEnabled()
      // 到那時一定是 false，下面的迴圈會自然跳過、不會硬悔——這是刻意的邊界，
      // 不是漏掉沒處理。
      const { board: preSpawnBoard } = simulateMove(board, dir);
      const expectedEval = chanceExpectation(preSpawnBoard); // 這個方向所有可能新方塊的期望分數
      fireArrow(dir);
      window.__2048BotMoves++;
      await sleep(MOVE_DELAY_MS);

      let rerolls = 0;
      while (rerolls < MAX_REROLLS && isUndoEnabled() && evaluate(readBoard()) < expectedEval - REROLL_MARGIN) {
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
  console.log('2048 auto-play bot started. Target score:', TARGET_SCORE, '(輸了會自動重開再試，不會整個停掉；每步會用悔棋重骰爛運氣)');
  console.log('查詢狀態: window.__2048BotLog / window.__2048BotMoves / window.__2048BotAttempts / window.__2048BotBest / window.__2048BotRerolls');
  console.log('中途改目標分數: window.__2048BotTarget = 數字');
  console.log('暫停腳本: window.__2048BotStop = true　　繼續腳本: window.__2048BotResume()');
})();
