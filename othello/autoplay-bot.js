/**
 * 黑白棋（Othello）自動遊玩腳本 — 每次執行都即時搜尋，落子路徑不固定
 *
 * 使用方式：
 * 1. 打開 https://ychung1998.github.io/othello/ ，人機對戰模式（我執黑先手），
 *    確認棋盤是初始盤面（雙方各 2 子，尚未落過任何一步）
 * 2. 打開瀏覽器 DevTools 的 Console
 * 3. 貼上這整段程式碼並按 Enter
 * 4. 腳本會先即時搜尋一條保證獲勝的完整序列（每次執行結果通常不同），一找到
 *    就馬上在畫面上全速依序落子
 * 5. 結束後在 console 印出這次實際使用的黑棋落子路徑
 *
 * 原理詳見 othello/攻略.md「AI 演算法（已完全破解）+ 本地搜尋工具」一節。
 * 停止腳本：window.__othelloBotStop = true
 * 查詢狀態：window.__othelloBotBlackMoves
 */
(function () {
  const py = (s) => pyodide.runPython(s);

  window.playMove = function (r, c) {
    const ok = py(`game.place(${r}, ${c})`);
    if (!ok) return { error: 'illegal' };
    let s = refresh();
    while (s.current === 2 && !s.winner) {
      py("_mv = game.ai_move()\nif _mv is not None:\n    game.place(_mv[0], _mv[1])");
      s = refresh();
    }
    return { state: s, done: !!s.winner };
  };

  // ---- 純 JS 重現 othello.py 的翻子/合法步/評分/negamax+alpha-beta 邏輯 ----
  // 棋盤用 dual-int32 bitboard 表示：{blackLo,blackHi,whiteLo,whiteHi}，index=r*8+c，
  // lo 放 index 0-31（row 0-3），hi 放 index 32-63（row 4-7），全部用原生 Number 位元
  // 運算（V8 對 32-bit 位元運算有快速路徑，比 BigInt 快很多）。棋盤是不可變值，每次
  // 下子回傳「新的」board 物件，呼叫端重新賦值即可，完全不需要複製陣列或悔棋還原。
  const OTH = (function () {
    const BLACK = 1, WHITE = 2;
    const WEIGHTS = [
      [120, -20, 20, 5, 5, 20, -20, 120],
      [-20, -40, -5, -5, -5, -5, -40, -20],
      [20, -5, 15, 3, 3, 15, -5, 20],
      [5, -5, 3, 3, 3, 3, -5, 5],
      [5, -5, 3, 3, 3, 3, -5, 5],
      [20, -5, 15, 3, 3, 15, -5, 20],
      [-20, -40, -5, -5, -5, -5, -40, -20],
      [120, -20, 20, 5, 5, 20, -20, 120],
    ];
    const other = (c) => (c === BLACK ? WHITE : BLACK);
    const u32 = (x) => x >>> 0;

    const COL0_HALF = u32((1 << 0) | (1 << 8) | (1 << 16) | (1 << 24));
    const COL7_HALF = u32((1 << 7) | (1 << 15) | (1 << 23) | (1 << 31));
    const NOT_COL0_HALF = u32(~COL0_HALF);
    const NOT_COL7_HALF = u32(~COL7_HALF);

    function shl(lo, hi, n) {
      return [u32(lo << n), u32(u32(hi << n) | u32(lo >>> (32 - n)))];
    }
    function shr(lo, hi, n) {
      return [u32(u32(lo >>> n) | u32(hi << (32 - n))), u32(hi >>> n)];
    }
    // 8 個方向：位移量 + 位移後要套用的邊界遮罩（防止跨列 wraparound）
    const DIRS = [
      { delta: -8, maskHalf: 0xFFFFFFFF }, // N
      { delta: 8, maskHalf: 0xFFFFFFFF },  // S
      { delta: 1, maskHalf: NOT_COL0_HALF },  // E
      { delta: -1, maskHalf: NOT_COL7_HALF }, // W
      { delta: -7, maskHalf: NOT_COL0_HALF }, // NE
      { delta: -9, maskHalf: NOT_COL7_HALF }, // NW
      { delta: 9, maskHalf: NOT_COL0_HALF },  // SE
      { delta: 7, maskHalf: NOT_COL7_HALF },  // SW
    ];
    function shiftDir(lo, hi, dir) {
      const [nlo, nhi] = dir.delta > 0 ? shl(lo, hi, dir.delta) : shr(lo, hi, -dir.delta);
      return [u32(nlo & dir.maskHalf), u32(nhi & dir.maskHalf)];
    }
    function popcount32(x) {
      x = x - ((x >>> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      x = (x + (x >>> 4)) & 0x0f0f0f0f;
      return (x * 0x01010101) >>> 24;
    }
    function popcountPair(lo, hi) { return popcount32(lo) + popcount32(hi); }
    function bitAt(r, c) {
      const idx = r * 8 + c;
      return idx < 32 ? [u32(1 << idx), 0] : [0, u32(1 << (idx - 32))];
    }
    function movesList(lo, hi) {
      const out = [];
      for (let i = 0; i < 32; i++) if ((lo >>> i) & 1) out.push([(i / 8) | 0, i % 8]);
      for (let i = 0; i < 32; i++) if ((hi >>> i) & 1) { const idx = i + 32; out.push([(idx / 8) | 0, idx % 8]); }
      return out;
    }
    const weightMasks = new Map();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const w = WEIGHTS[r][c];
      const [blo, bhi] = bitAt(r, c);
      const prev = weightMasks.get(w) || [0, 0];
      weightMasks.set(w, [u32(prev[0] | blo), u32(prev[1] | bhi)]);
    }
    const weightEntries = [...weightMasks.entries()];

    function POof(board, color) {
      return color === BLACK
        ? [board.blackLo, board.blackHi, board.whiteLo, board.whiteHi]
        : [board.whiteLo, board.whiteHi, board.blackLo, board.blackHi];
    }
    function generateMoves(Plo, Phi, Olo, Ohi) {
      const emptyLo = u32(~(Plo | Olo)), emptyHi = u32(~(Phi | Ohi));
      let movesLo = 0, movesHi = 0;
      for (const dir of DIRS) {
        let [clo, chi] = shiftDir(Plo, Phi, dir);
        clo = u32(clo & Olo); chi = u32(chi & Ohi);
        for (let i = 0; i < 5; i++) {
          let [slo, shi] = shiftDir(clo, chi, dir);
          slo = u32(slo & Olo); shi = u32(shi & Ohi);
          clo = u32(clo | slo); chi = u32(chi | shi);
        }
        let [flo, fhi] = shiftDir(clo, chi, dir);
        flo = u32(flo & emptyLo); fhi = u32(fhi & emptyHi);
        movesLo = u32(movesLo | flo); movesHi = u32(movesHi | fhi);
      }
      return [movesLo, movesHi];
    }
    // 回傳指定落子在指定盤面上會翻掉的棋子（bitmask），不合法/沒有翻子回傳 [0,0]
    function flipsOn(board, r, c, color) {
      const [Plo, Phi, Olo, Ohi] = POof(board, color);
      const [bitLo, bitHi] = bitAt(r, c);
      let totalLo = 0, totalHi = 0;
      for (const dir of DIRS) {
        let [clo, chi] = shiftDir(bitLo, bitHi, dir);
        clo = u32(clo & Olo); chi = u32(chi & Ohi);
        let floodLo = 0, floodHi = 0;
        while (clo !== 0 || chi !== 0) {
          floodLo = u32(floodLo | clo); floodHi = u32(floodHi | chi);
          let [nlo, nhi] = shiftDir(clo, chi, dir);
          clo = u32(nlo & Olo); chi = u32(nhi & Ohi);
        }
        if (floodLo === 0 && floodHi === 0) continue;
        const [blo, bhi] = shiftDir(floodLo, floodHi, dir);
        if ((blo & Plo) !== 0 || (bhi & Phi) !== 0) { totalLo = u32(totalLo | floodLo); totalHi = u32(totalHi | floodHi); }
      }
      return [totalLo, totalHi];
    }
    function legalMovesOn(board, color) {
      const [Plo, Phi, Olo, Ohi] = POof(board, color);
      const [mlo, mhi] = generateMoves(Plo, Phi, Olo, Ohi);
      return movesList(mlo, mhi);
    }
    // 回傳套用某手棋之後「新的」board 物件（不可變，原本的 board 不受影響）
    function applyMove(board, r, c, color, flips) {
      const [flo, fhi] = flips;
      const [bitLo, bitHi] = bitAt(r, c);
      const [Plo, Phi, Olo, Ohi] = POof(board, color);
      const newPlo = u32(Plo | bitLo | flo), newPhi = u32(Phi | bitHi | fhi);
      const newOlo = u32(Olo & ~flo), newOhi = u32(Ohi & ~fhi);
      return color === BLACK
        ? { blackLo: newPlo, blackHi: newPhi, whiteLo: newOlo, whiteHi: newOhi }
        : { blackLo: newOlo, blackHi: newOhi, whiteLo: newPlo, whiteHi: newPhi };
    }
    function evaluate(board, color) {
      const [Plo, Phi, Olo, Ohi] = POof(board, color);
      let pos = 0;
      for (const [w, [mlo, mhi]] of weightEntries) {
        pos += w * (popcountPair(Plo & mlo, Phi & mhi) - popcountPair(Olo & mlo, Ohi & mhi));
      }
      const [mvPlo, mvPhi] = generateMoves(Plo, Phi, Olo, Ohi);
      const [mvOlo, mvOhi] = generateMoves(Olo, Ohi, Plo, Phi);
      const myMoves = popcountPair(mvPlo, mvPhi), oppMoves = popcountPair(mvOlo, mvOhi);
      let mobility = 0;
      if (myMoves + oppMoves) mobility = (100 * (myMoves - oppMoves)) / (myMoves + oppMoves);
      const myDiscs = popcountPair(Plo, Phi), oppDiscs = popcountPair(Olo, Ohi);
      const empties = 64 - myDiscs - oppDiscs;
      let discDiff = 0;
      if (myDiscs + oppDiscs) discDiff = (100 * (myDiscs - oppDiscs)) / (myDiscs + oppDiscs);
      const discWeight = empties <= 12 ? 2.0 : 0.1;
      return pos + mobility * 1.5 + discDiff * discWeight;
    }
    // 排序只加速 alpha-beta 剪枝，不影響 minimax 回傳值；aiMove 外層仍照原始順序遍歷保持 tie-break 一致
    function minimax(board, depth, alpha, beta, toMove, aiColor) {
      const [Plo, Phi, Olo, Ohi] = POof(board, toMove);
      const [mvLo, mvHi] = generateMoves(Plo, Phi, Olo, Ohi);
      if (mvLo === 0 && mvHi === 0) {
        const [OPlo, OPhi, OOlo, OOhi] = POof(board, other(toMove));
        const [omvLo, omvHi] = generateMoves(OPlo, OPhi, OOlo, OOhi);
        if (omvLo === 0 && omvHi === 0) {
          const [APlo, APhi, AOlo, AOhi] = POof(board, aiColor);
          const my = popcountPair(APlo, APhi), his = popcountPair(AOlo, AOhi);
          return my !== his ? 100000 + (my - his) : 0;
        }
        if (depth === 0) return evaluate(board, aiColor);
        return minimax(board, depth - 1, alpha, beta, other(toMove), aiColor);
      }
      if (depth === 0) return evaluate(board, aiColor);
      const moves = movesList(mvLo, mvHi);
      const maximizing = toMove === aiColor;
      let value = maximizing ? -Infinity : Infinity;
      const ordered = moves.map(([r, c]) => ({ r, c, h: WEIGHTS[r][c] })).sort((a, b2) => b2.h - a.h);
      for (const { r, c } of ordered) {
        const [bitLo, bitHi] = bitAt(r, c);
        let flo = 0, fhi = 0;
        for (const dir of DIRS) {
          let [clo, chi] = shiftDir(bitLo, bitHi, dir);
          clo = u32(clo & Olo); chi = u32(chi & Ohi);
          let floodLo = 0, floodHi = 0;
          while (clo !== 0 || chi !== 0) {
            floodLo = u32(floodLo | clo); floodHi = u32(floodHi | chi);
            let [nlo, nhi] = shiftDir(clo, chi, dir);
            clo = u32(nlo & Olo); chi = u32(nhi & Ohi);
          }
          if (floodLo === 0 && floodHi === 0) continue;
          const [blo, bhi] = shiftDir(floodLo, floodHi, dir);
          if ((blo & Plo) !== 0 || (bhi & Phi) !== 0) { flo = u32(flo | floodLo); fhi = u32(fhi | floodHi); }
        }
        const newPlo = u32(Plo | bitLo | flo), newPhi = u32(Phi | bitHi | fhi);
        const newOlo = u32(Olo & ~flo), newOhi = u32(Ohi & ~fhi);
        const newBoard = toMove === BLACK
          ? { blackLo: newPlo, blackHi: newPhi, whiteLo: newOlo, whiteHi: newOhi }
          : { blackLo: newOlo, blackHi: newOhi, whiteLo: newPlo, whiteHi: newPhi };
        const score = minimax(newBoard, depth - 1, alpha, beta, other(toMove), aiColor);
        if (maximizing) { value = Math.max(value, score); alpha = Math.max(alpha, value); }
        else { value = Math.min(value, score); beta = Math.min(beta, value); }
        if (alpha >= beta) break;
      }
      return value;
    }
    function aiMove(board, current, depth = 4) {
      const [Plo, Phi, Olo, Ohi] = POof(board, current);
      const [mvLo, mvHi] = generateMoves(Plo, Phi, Olo, Ohi);
      const moves = movesList(mvLo, mvHi); // row-major，跟原陣列版 legalMovesOn 順序一致
      if (moves.length === 0) return null;
      if (moves.length === 1) return moves[0];
      const totalDiscs = popcountPair(u32(board.blackLo | board.whiteLo), u32(board.blackHi | board.whiteHi));
      const empties = 64 - totalDiscs;
      const d = empties <= 8 ? empties : depth;
      let best = moves[0], bestVal = -Infinity;
      for (const [r, c] of moves) {
        const flips = flipsOn(board, r, c, current);
        const newBoard = applyMove(board, r, c, current, flips);
        const val = minimax(newBoard, d - 1, -Infinity, Infinity, other(current), current);
        if (val > bestVal) { bestVal = val; best = [r, c]; }
      }
      return best;
    }
    function initBoard() {
      const [b33lo, b33hi] = bitAt(3, 3), [b44lo, b44hi] = bitAt(4, 4);
      const [b34lo, b34hi] = bitAt(3, 4), [b43lo, b43hi] = bitAt(4, 3);
      return {
        blackLo: u32(b34lo | b43lo), blackHi: u32(b34hi | b43hi),
        whiteLo: u32(b33lo | b44lo), whiteHi: u32(b33hi | b44hi),
      };
    }
    return { BLACK, WHITE, WEIGHTS, other, popcountPair, flipsOn, legalMovesOn, applyMove, evaluate, aiMove, initBoard };
  })();

  // ---- 回合推進（跳過/終局判定）+ 黑方候選排序（角優先、翻子數次之） ----
  const OTH2 = (function () {
    const { BLACK, WHITE, other, popcountPair, flipsOn, legalMovesOn, applyMove, WEIGHTS } = OTH;
    function countDiscs(board) {
      return { bl: popcountPair(board.blackLo, board.blackHi), w: popcountPair(board.whiteLo, board.whiteHi) };
    }
    function resolveTurn(board, current) {
      while (true) {
        if (legalMovesOn(board, current).length > 0) return { current, winner: null };
        const opp = other(current);
        if (legalMovesOn(board, opp).length > 0) { current = opp; continue; }
        const { bl, w } = countDiscs(board);
        return { current, winner: bl === w ? 'draw' : (bl > w ? BLACK : WHITE) };
      }
    }
    function settleToBlack(board, mover) {
      let res = resolveTurn(board, other(mover));
      const whiteMoves = [];
      while (res.winner === null && res.current === WHITE) {
        const wm = OTH.aiMove(board, WHITE, 4);
        const flips = flipsOn(board, wm[0], wm[1], WHITE);
        board = applyMove(board, wm[0], wm[1], WHITE, flips);
        whiteMoves.push({ r: wm[0], c: wm[1] });
        res = resolveTurn(board, BLACK);
      }
      return { board, current: res.current, winner: res.winner, whiteMoves };
    }
    // 候選排序只影響 DFS 先試哪一手，直接決定要翻多少節點才撞到必勝解，細節見攻略.md
    function rankBlackMoves(board) {
      const moves = legalMovesOn(board, BLACK);
      return moves.map(([r, c]) => {
        const flips = flipsOn(board, r, c, BLACK);
        const nb = applyMove(board, r, c, BLACK, flips);
        const whiteOpts = legalMovesOn(nb, WHITE).length;
        return { r, c, flips, score: WEIGHTS[r][c] * 10 - whiteOpts * 12 - popcountPair(flips[0], flips[1]) * 3 };
      }).sort((a, b2) => b2.score - a.score);
    }
    return { countDiscs, resolveTurn, settleToBlack, rankBlackMoves };
  })();

  function shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // settleToBlack 是純函式，DFS 不同分支常走到同一盤面，整輪搜尋共用快取（實測命中率約 38%）
  let settleMemo = new Map();
  const SETTLE_MEMO_MAX = 200000; // 保險上限，避免極端長搜尋把記憶體吃光
  function resetSettleMemo() { settleMemo = new Map(); }
  function settleToBlackCached(board) {
    const key = board.blackLo + ',' + board.blackHi + ',' + board.whiteLo + ',' + board.whiteHi;
    const hit = settleMemo.get(key);
    if (hit !== undefined) return hit;
    const res = OTH2.settleToBlack(board, OTH.BLACK);
    if (settleMemo.size < SETTLE_MEMO_MAX) settleMemo.set(key, res);
    return res;
  }
  // 候選順序在角優先的分數排序之上，同分群組隨機打亂，增加多樣性但不犧牲太多搜尋效率
  function rankedShuffled(board, branchFactor) {
    const ranked = OTH2.rankBlackMoves(board);
    const grouped = [];
    let i = 0;
    while (i < ranked.length) {
      let j = i + 1;
      while (j < ranked.length && ranked[j].score === ranked[i].score) j++;
      grouped.push(...shuffle(ranked.slice(i, j)));
      i = j;
    }
    return grouped.slice(0, branchFactor);
  }

  // ---- 單人路徑 DFS（只有黑方分支，白方是決定性函式直接算），可分段續跑 ----
  // board 是不可變值，每個 stack frame 各自存自己的 board 快照，backtrack 時直接
  // pop 掉整個 frame 即可，不需要像陣列版那樣手動 undo 翻子。
  window.initSearchFromMoves = function (forcedMoves, branchFactor) {
    let board = OTH.initBoard();
    const path = [];
    for (const [r, c] of forcedMoves) {
      const flips = OTH.flipsOn(board, r, c, OTH.BLACK);
      board = OTH.applyMove(board, r, c, OTH.BLACK, flips);
      const settle = settleToBlackCached(board);
      board = settle.board;
      path.push({ blackMove: { r, c } });
      if (settle.winner !== null) throw new Error('game ended during forced prefix');
    }
    window.searchStack = [{ board, candidates: rankedShuffled(board, branchFactor), idx: 0, moveInfo: null }];
    window.searchNodes = 0; window.searchBranchFactor = branchFactor; window.searchResult = null; window.searchPrefix = path;
  };
  window.runSearch = function (timeBudgetMs, nodeBudget) {
    const t0 = performance.now();
    const stack = window.searchStack, K = window.searchBranchFactor;
    let result = window.searchResult;
    while (stack.length && !result) {
      if (performance.now() - t0 > timeBudgetMs) return { status: 'TIME_PAUSE', nodes: window.searchNodes };
      const top = stack[stack.length - 1];
      if (top.idx >= top.candidates.length) { stack.pop(); continue; }
      const cand = top.candidates[top.idx++];
      window.searchNodes++;
      if (window.searchNodes > nodeBudget) { result = { status: 'BUDGET' }; break; }

      const newBoard = OTH.applyMove(top.board, cand.r, cand.c, OTH.BLACK, cand.flips);
      const settle = settleToBlackCached(newBoard);
      const moveInfo = { blackMove: { r: cand.r, c: cand.c } };

      if (settle.winner !== null) {
        if (settle.winner === OTH.BLACK) {
          const path = stack.slice(1).map((f) => f.moveInfo).concat([moveInfo]);
          result = { status: 'WIN', path };
          break;
        }
        continue;
      }
      stack.push({ board: settle.board, candidates: rankedShuffled(settle.board, K), idx: 0, moveInfo });
    }
    if (!result) result = stack.length === 0 ? { status: 'EXHAUSTED' } : { status: 'UNKNOWN' };
    window.searchResult = result;
    return { status: result.status, nodes: window.searchNodes, path: result.path };
  };

  // ---- 用獨立的 verify_scratch 實例跑一次真引擎全程驗證（保留給手動探索用，
  //      自動流程不再呼叫它，見檔頭說明）----
  window.verifySequence = function (blackMoves) {
    pyodide.runPython('verify_scratch = Game()');
    const log = [];
    for (const [r, c] of blackMoves) {
      const ok = py(`verify_scratch.place(${r}, ${c})`);
      if (!ok) { log.push({ r, c, error: 'rejected_or_illegal' }); return { ok: false, log }; }
      let st = JSON.parse(py('verify_scratch.state()'));
      if (st.winner) return { ok: st.winner === 1, winner: st.winner, log, black: st.black, white: st.white };
      while (st.current === 2 && !st.winner) {
        const mv = py('verify_scratch.ai_move()');
        const arr = mv.toJs ? mv.toJs() : mv;
        if (!arr) break;
        py(`verify_scratch.place(${arr[0]}, ${arr[1]})`);
        st = JSON.parse(py('verify_scratch.state()'));
      }
      if (st.winner) return { ok: st.winner === 1, winner: st.winner, log, black: st.black, white: st.white };
    }
    return { ok: false, note: '跑完序列還沒分勝負' };
  };

  // ---- 即時（隨機）找一條當下可用的必勝序列，找到後才真的落子 ----
  const FIRST_MOVES = [[2, 3], [3, 2], [4, 5], [5, 4]];

  function findRandomWinningSequence(onDone) {
    resetSettleMemo(); // 整輪搜尋共用一份 settleToBlack 快取，開始前先清空
    const firstMove = FIRST_MOVES[Math.floor(Math.random() * FIRST_MOVES.length)];
    let board0 = OTH.initBoard();
    const flips0 = OTH.flipsOn(board0, firstMove[0], firstMove[1], OTH.BLACK);
    board0 = OTH.applyMove(board0, firstMove[0], firstMove[1], OTH.BLACK, flips0);
    const settle0 = settleToBlackCached(board0);
    if (settle0.winner !== null) { onDone(null); return; }
    board0 = settle0.board;

    const secondCandidates = shuffle(OTH.legalMovesOn(board0, OTH.BLACK));
    let idx = 0;

    function tryNextCandidate() {
      if (idx >= secondCandidates.length) { onDone(null); return; }
      const secondMove = secondCandidates[idx++];
      window.initSearchFromMoves([firstMove, secondMove], 3);
      let budget = 6000;
      let doublings = 0;

      function loop() {
        const res = window.runSearch(1000, budget);
        if (res.status === 'WIN') {
          const fullMoves = (window.searchPrefix || []).concat(window.searchResult.path)
            .map((p) => [p.blackMove.r, p.blackMove.c]);
          onDone({ fullMoves, firstMove, secondMove });
          return;
        }
        if (res.status === 'TIME_PAUSE') { setTimeout(loop, 0); return; }
        if (res.status === 'BUDGET') {
          doublings++;
          if (doublings > 2) { setTimeout(tryNextCandidate, 0); return; } // 這條分支太貴，換下一個隨機候選
          budget *= 2;
          window.searchResult = null;
          setTimeout(loop, 0);
          return;
        }
        setTimeout(tryNextCandidate, 0); // EXHAUSTED / UNKNOWN -> 換下一個候選
      }
      loop();
    }

    tryNextCandidate();
  }

  // ---- 執行（全速跑完，不模擬真人下棋節奏，畫面可能來不及顯示中間步驟）----
  window.__othelloBotStop = false;
  window.__othelloBotBlackMoves = [];

  function boardIsFresh() {
    const s = refresh();
    return s.black === 2 && s.white === 2 && s.current === 1;
  }

  function printResult(reason) {
    console.log('=== 黑白棋自動對局結束：' + reason + ' ===');
    console.log('黑棋落子路徑（本次即時搜尋，每次執行通常不同）:', JSON.stringify(window.__othelloBotBlackMoves));
  }

  function runSequence(moves) {
    for (let i = 0; i < moves.length; i++) {
      if (window.__othelloBotStop) { printResult('手動停止'); return; }

      const [r, c] = moves[i];
      const result = window.playMove(r, c);

      if (result.error) {
        printResult('第 ' + (i + 1) + ' 手失敗（' + result.error + '），棋盤可能不是初始盤面');
        return;
      }

      window.__othelloBotBlackMoves.push([r, c]);

      if (result.done) {
        const s = result.state;
        printResult(s.winner === 1 ? '黑棋獲勝！ ' + s.black + ':' + s.white : '對局結束（winner=' + s.winner + '，' + s.black + ':' + s.white + '）');
        return;
      }
    }
    printResult('序列跑完（JS mirror 判定應已獲勝，若在此中止代表 mirror 跟真引擎有落差，需要回報）');
  }

  if (!boardIsFresh()) {
    console.warn('棋盤非初始狀態，請重新整理頁面後再執行。');
    return;
  }

  console.log('正在即時搜尋一條新的必勝序列...');
  findRandomWinningSequence((found) => {
    if (!found) {
      console.warn('這次隨機候選都沒找到必勝序列，重新執行一次腳本再試。');
      return;
    }
    runSequence(found.fullMoves);
  });
})();
