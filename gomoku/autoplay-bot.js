/**
 * 五子棋（Gomoku）自動遊玩腳本 — 每次執行都即時搜尋，落子路徑不固定
 *
 * 使用方式：
 * 1. 打開 https://ychung1998.github.io/gomoku/ ，選人機對戰模式（我執黑），確認棋盤是全新空局
 * 2. 打開瀏覽器 DevTools 的 Console
 * 3. 貼上這整段程式碼並按 Enter
 * 4. 腳本會先即時搜尋一條保證獲勝的完整序列（每次執行結果通常不同），找到後
 *    才真的在畫面上全速依序落子
 * 5. 結束後在 console 印出這次實際使用的黑棋落子路徑
 *
 * 原理詳見 gomoku/攻略.md「AI 演算法已完全破解 + 本地搜尋工具」一節。
 * 停止腳本：window.__gomokuBotStop = true
 * 查詢狀態：window.__gomokuBotBlackMoves
 */
(function () {
  const py = (s) => pyodide.runPython(s);

  window.playMove = function (r, c) {
    const forb = py(`game.forbidden(${r},${c})`);
    if (forb) return { error: 'forbidden', reason: forb };
    const ok = py(`game.place(${r},${c})`);
    if (!ok) return { error: 'rejected' };
    refresh();
    let s = JSON.parse(py('game.state()'));
    if (s.winner) return { state: s, done: true };
    const mv = py('game.ai_move()');
    const arr = mv.toJs ? mv.toJs() : mv;
    py(`game.place(${arr[0]},${arr[1]})`);
    refresh();
    s = JSON.parse(py('game.state()'));
    return { state: s, whiteMove: [arr[0], arr[1]], done: !!s.winner };
  };

  // ---- 純 JS 重現白方 AI 的評分/選子邏輯 ----
  const SIM = (function () {
    const SIZE = 15, DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
    const inb = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
    function scoreAt(b, r, c, color) {
      let total = 0;
      for (const [dr, dc] of DIRS) {
        let count = 1, openEnds = 0;
        for (const s of [1, -1]) {
          let nr = r + dr * s, nc = c + dc * s;
          while (inb(nr, nc) && b[nr][nc] === color) { count++; nr += dr * s; nc += dc * s; }
          if (inb(nr, nc) && b[nr][nc] === 0) openEnds++;
        }
        if (count >= 5) total += 10000000;
        else if (count === 4) total += openEnds === 2 ? 100000 : (openEnds ? 10000 : 0);
        else if (count === 3) total += openEnds === 2 ? 1000 : (openEnds ? 100 : 0);
        else if (count === 2) total += openEnds === 2 ? 100 : (openEnds ? 10 : 0);
        else total += 1;
      }
      return total;
    }
    function nearStone(b, r, c, dist = 2) {
      for (let dr = -dist; dr <= dist; dr++) for (let dc = -dist; dc <= dist; dc++) {
        const nr = r + dr, nc = c + dc;
        if (inb(nr, nc) && b[nr][nc] !== 0) return true;
      }
      return false;
    }
    function aiMove(b, me, empty) {
      if (empty) return [7, 7];
      const opp = me === 1 ? 2 : 1;
      let best = null, bestScore = -1;
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (b[r][c] !== 0 || !nearStone(b, r, c)) continue;
        const score = scoreAt(b, r, c, me) * 1.1 + scoreAt(b, r, c, opp);
        if (score > bestScore) { bestScore = score; best = [r, c]; }
      }
      return best;
    }
    return { scoreAt, aiMove, nearStone, SIZE, DIRS };
  })();

  // ---- 精確版禁手判斷 + 候選/勝負工具 ----
  const SIM2 = (function () {
    const SIZE = 15, DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
    const inb = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;
    function preciseForbidden(b, r, c) {
      if (b[r][c] !== 0) return false;
      function runLen(bb, rr, cc, dr, dc, col) {
        let count = 1;
        for (const s of [1, -1]) {
          let nr = rr + dr * s, nc = cc + dc * s;
          while (inb(nr, nc) && bb[nr][nc] === col) { count++; nr += dr * s; nc += dc * s; }
        }
        return count;
      }
      function fours(bb, rr, cc, dr, dc) {
        const found = new Set();
        for (let off = -4; off <= 0; off++) {
          const cells = [];
          let valid = true;
          for (let i = 0; i < 5; i++) {
            const x = rr + dr * (off + i), y = cc + dc * (off + i);
            if (!inb(x, y)) { valid = false; break; }
            cells.push([x, y]);
          }
          if (!valid) continue;
          const blacks = cells.filter(([x, y]) => bb[x][y] === 1);
          const empties = cells.filter(([x, y]) => bb[x][y] === 0);
          if (blacks.length !== 4 || empties.length !== 1) continue;
          const [er, ec] = empties[0];
          bb[er][ec] = 1;
          const makesExactFive = runLen(bb, er, ec, dr, dc, 1) === 5;
          bb[er][ec] = 0;
          if (makesExactFive) found.add(blacks.map((p) => p.join(',')).sort().join('|'));
        }
        return found;
      }
      b[r][c] = 1;
      let fiveOrMore = false, sixPlus = false, threeDirs = 0;
      const allFours = new Set();
      for (const [dr, dc] of DIRS) {
        const run = runLen(b, r, c, dr, dc, 1);
        if (run === 5) fiveOrMore = true;
        if (run >= 6) sixPlus = true;
        for (const k of fours(b, r, c, dr, dc)) allFours.add(k);
        let count = 1, openEnds = 0;
        for (const s of [1, -1]) {
          let nr = r + dr * s, nc = c + dc * s;
          while (inb(nr, nc) && b[nr][nc] === 1) { count++; nr += dr * s; nc += dc * s; }
          if (inb(nr, nc) && b[nr][nc] === 0) openEnds++;
        }
        if (count === 3 && openEnds === 2) threeDirs++;
      }
      b[r][c] = 0;
      if (fiveOrMore) return false;
      if (sixPlus) return '長連禁手';
      if (allFours.size >= 2) return '四四禁手';
      if (threeDirs >= 2) return '三三禁手';
      return false;
    }
    function checkWin(b, r, c, col) {
      for (const [dr, dc] of DIRS) {
        let count = 1;
        for (const s of [1, -1]) {
          let nr = r + dr * s, nc = c + dc * s;
          while (inb(nr, nc) && b[nr][nc] === col) { count++; nr += dr * s; nc += dc * s; }
        }
        if (col === 1 ? count === 5 : count >= 5) return true;
      }
      return false;
    }
    function blackCandidates(b, requireConnect = true) {
      const { nearStone } = SIM;
      const out = [];
      for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
        if (b[r][c] !== 0 || !nearStone(b, r, c)) continue;
        if (preciseForbidden(b, r, c)) continue;
        if (requireConnect) {
          let maxCount = 0;
          for (const [dr, dc] of DIRS) {
            let count = 1;
            for (const s of [1, -1]) {
              let nr = r + dr * s, nc = c + dc * s;
              while (inb(nr, nc) && b[nr][nc] === 1) { count++; nr += dr * s; nc += dc * s; }
            }
            if (count > maxCount) maxCount = count;
          }
          if (maxCount < 2) continue;
        }
        out.push([r, c]);
      }
      return out;
    }
    function rankCandidates(b, cands) {
      return cands.map(([r, c]) => ({ r, c, s: SIM.scoreAt(b, r, c, 1) })).sort((a, b2) => b2.s - a.s);
    }
    return { preciseForbidden, checkWin, blackCandidates, rankCandidates, SIZE, DIRS };
  })();

  // ---- 單人路徑 DFS：黑方每層試 branchFactor 個候選，白方回應直接算 ----
  window.searchWin = function (inputBoard, maxDepth, branchFactor, nodeBudget) {
    let nodes = 0;
    function rec(b, depthRemaining, path) {
      nodes++;
      if (nodes > nodeBudget) return 'BUDGET';
      if (depthRemaining <= 0) return null;
      const cands = SIM2.rankCandidates(b, SIM2.blackCandidates(b));
      for (const { r, c } of cands.slice(0, branchFactor)) {
        b[r][c] = 1;
        if (SIM2.checkWin(b, r, c, 1)) { const res = [...path, [r, c]]; b[r][c] = 0; return res; }
        const wm = SIM.aiMove(b, 2, false);
        let result = null;
        if (wm) {
          b[wm[0]][wm[1]] = 2;
          if (!SIM2.checkWin(b, wm[0], wm[1], 2)) result = rec(b, depthRemaining - 1, [...path, [r, c]]);
          b[wm[0]][wm[1]] = 0;
        }
        b[r][c] = 0;
        if (result === 'BUDGET') return 'BUDGET';
        if (result) return result;
      }
      return null;
    }
    const res = rec(inputBoard.map((row) => row.slice()), maxDepth, []);
    return { result: res, nodes };
  };

  // ---- 用獨立 scratch 實例跑一次真引擎全程驗證 ----
  window.verifySequence = function (blackMoves) {
    py('scratch = Game(renju=True)');
    const log = [];
    for (const [r, c] of blackMoves) {
      const forb = py(`scratch.forbidden(${r},${c})`);
      if (forb) { log.push({ r, c, error: 'forbidden', reason: String(forb) }); return { ok: false, log }; }
      if (!py(`scratch.place(${r},${c})`)) { log.push({ r, c, error: 'rejected' }); return { ok: false, log }; }
      let st = JSON.parse(py('scratch.state()'));
      if (st.winner) { log.push({ r, c, blackWin: true }); return { ok: true, log, winner: 'black' }; }
      const wm = py('scratch.ai_move()');
      const warr = wm.toJs ? wm.toJs() : wm;
      py(`scratch.place(${warr[0]},${warr[1]})`);
      st = JSON.parse(py('scratch.state()'));
      log.push({ black: [r, c], white: [warr[0], warr[1]] });
      if (st.winner) { log.push({ whiteWin: true }); return { ok: false, log, winner: 'white' }; }
    }
    return { ok: true, log, winner: null, note: '序列跑完還沒分勝負' };
  };

  function shuffle(arr) {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function candidatesAround(center, radius) {
    const [cr, cc] = center;
    const out = [];
    for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = cr + dr, c = cc + dc;
      if (r >= 0 && r < 15 && c >= 0 && c < 15) out.push([r, c]);
    }
    return shuffle(out);
  }

  // ---- 即時（隨機）找一條當下可用的必勝序列，找到後才真的落子 ----
  function findRandomWinningSequence(onDone, maxAttempts, maxDepth, branchFactor, nodeBudget) {
    const b0 = Array.from({ length: 15 }, () => Array(15).fill(0));
    b0[7][7] = 1;
    const w1 = SIM.aiMove(b0, 2, false);
    b0[w1[0]][w1[1]] = 2;

    const candidates = candidatesAround([7, 7], 3);
    let idx = 0;

    function tryNext() {
      if (idx >= maxAttempts || idx >= candidates.length) { onDone(null); return; }
      const secondMove = candidates[idx++];
      const b = b0.map((row) => row.slice());
      if (b[secondMove[0]][secondMove[1]] !== 0 || SIM2.preciseForbidden(b, secondMove[0], secondMove[1])) {
        setTimeout(tryNext, 0);
        return;
      }
      b[secondMove[0]][secondMove[1]] = 1;
      const w2 = SIM.aiMove(b, 2, false);
      b[w2[0]][w2[1]] = 2;
      const searchRes = window.searchWin(b, maxDepth, branchFactor, nodeBudget);
      if (!searchRes.result || searchRes.result === 'BUDGET') { setTimeout(tryNext, 0); return; }
      const fullMoves = [[7, 7], secondMove, ...searchRes.result];
      const verifyRes = window.verifySequence(fullMoves);
      if (verifyRes.ok && verifyRes.winner === 'black') {
        onDone({ fullMoves, secondMove, nodes: searchRes.nodes });
      } else {
        setTimeout(tryNext, 0);
      }
    }
    tryNext();
  }

  // ---- 執行（全速跑完，不模擬真人下棋節奏，畫面可能來不及顯示中間步驟）----
  window.__gomokuBotStop = false;
  window.__gomokuBotBlackMoves = [];

  function boardIsFresh() {
    const s = JSON.parse(py('game.state()'));
    return s.board.every((row) => row.every((cell) => cell === 0));
  }

  function printResult(reason) {
    console.log('=== 五子棋自動對局結束：' + reason + ' ===');
    console.log('黑棋落子路徑（本次即時搜尋，每次執行通常不同）:', JSON.stringify(window.__gomokuBotBlackMoves));
  }

  function runSequence(moves) {
    for (let i = 0; i < moves.length; i++) {
      if (window.__gomokuBotStop) { printResult('手動停止'); return; }

      const [r, c] = moves[i];
      const result = window.playMove(r, c);

      if (result.error) {
        printResult('第 ' + (i + 1) + ' 手失敗（' + result.error + '），棋盤可能不是全新局');
        return;
      }

      window.__gomokuBotBlackMoves.push([r, c]);

      if (result.done) {
        printResult(result.state.winner === 'black' ? '黑棋獲勝！' : '對局結束（winner=' + result.state.winner + '）');
        return;
      }
    }
    printResult('序列跑完（已通過真引擎驗證，理論上不應在此中止）');
  }

  if (!boardIsFresh()) {
    console.warn('棋盤非空（不是全新局），請重新整理頁面後再執行。');
    return;
  }

  console.log('正在即時搜尋一條新的必勝序列...');
  findRandomWinningSequence(
    (found) => {
      if (!found) {
        console.warn('這次隨機挑的候選都沒找到必勝序列，重新執行一次腳本再試（會換一批隨機候選）。');
        return;
      }
      runSequence(found.fullMoves);
    },
    20, 10, 8, 500000
  );
})();
