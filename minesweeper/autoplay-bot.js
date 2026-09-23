/**
 * 踩地雷（ychung1998.github.io/minesweeper 版）自動遊玩腳本
 *
 * 使用方式：打開 https://ychung1998.github.io/minesweeper/，開 DevTools Console，
 * （可選）改下面 CONFIG 的難度，貼上整段執行。原理、演算法推導、已驗證勝率
 * 詳見 minesweeper/攻略.md 跟 .claude/minesweeper/notes.md。
 *
 * 只有踩雷輸了才會自動重開下一局，一直重試到獲勝為止；獲勝就停下來並在
 * console 印出玩了幾局才贏。
 * 停止腳本：window.__minesweeperBotStop = true
 * 查詢目前戰績：window.__minesweeperBotStats
 */
(function () {
  const CONFIG = {
    DIFFICULTY: 'expert', // 'beginner'（9×9/10雷） | 'intermediate'（16×16/40雷） | 'expert'（30×16/99雷）
  };

  window.__minesweeperBotStop = false;
  window.__minesweeperBotStats = { attempts: 0, result: null };

  const boardEl = document.getElementById('board');
  const difficultyEl = document.getElementById('difficulty');
  const smileyEl = document.getElementById('smiley');
  const timerEl = document.getElementById('timer');

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function key(r, c) { return r + ',' + c; }

  function readBoard() {
    const cells = boardEl.querySelectorAll('.cell');
    let rows = 0, cols = 0;
    cells.forEach((el) => {
      const r = +el.dataset.r, c = +el.dataset.c;
      if (r + 1 > rows) rows = r + 1;
      if (c + 1 > cols) cols = c + 1;
    });
    const grid = Array.from({ length: rows }, () => new Array(cols).fill(null));
    cells.forEach((el) => {
      const r = +el.dataset.r, c = +el.dataset.c;
      const revealed = el.classList.contains('revealed');
      grid[r][c] = {
        el,
        revealed,
        n: revealed && el.dataset.n ? +el.dataset.n : 0,
      };
    });
    return { grid, rows, cols };
  }

  function neighborsOf(r, c, rows, cols) {
    const out = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push([nr, nc]);
      }
    }
    return out;
  }

  function solve(grid, rows, cols) {
    const constraints = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        if (!cell.revealed || cell.n === 0) continue;
        const unrevealed = neighborsOf(r, c, rows, cols).filter(([nr, nc]) => !grid[nr][nc].revealed);
        if (unrevealed.length > 0) {
          constraints.push({ cells: new Set(unrevealed.map(([nr, nc]) => key(nr, nc))), count: cell.n });
        }
      }
    }

    const mines = new Set();
    const safe = new Set();

    function reduce(con) {
      const cells = new Set();
      let count = con.count;
      for (const k of con.cells) {
        if (mines.has(k)) { count--; continue; }
        if (safe.has(k)) continue;
        cells.add(k);
      }
      return { cells, count };
    }

    let changed = true;
    while (changed) {
      changed = false;
      const reduced = constraints.map(reduce).filter((c) => c.cells.size > 0);

      for (const con of reduced) {
        if (con.count === 0) {
          for (const k of con.cells) if (!safe.has(k)) { safe.add(k); changed = true; }
        } else if (con.count === con.cells.size) {
          for (const k of con.cells) if (!mines.has(k)) { mines.add(k); changed = true; }
        }
      }
      if (changed) continue;

      for (let i = 0; i < reduced.length && !changed; i++) {
        for (let j = 0; j < reduced.length && !changed; j++) {
          if (i === j) continue;
          const a = reduced[i], b = reduced[j];
          if (a.cells.size === 0 || a.cells.size >= b.cells.size) continue;
          let isSubset = true;
          for (const k of a.cells) if (!b.cells.has(k)) { isSubset = false; break; }
          if (!isSubset) continue;
          const diffCells = [...b.cells].filter((k) => !a.cells.has(k));
          const diffCount = b.count - a.count;
          if (diffCount === 0) {
            for (const k of diffCells) if (!safe.has(k)) { safe.add(k); changed = true; }
          } else if (diffCount === diffCells.length && diffCount > 0) {
            for (const k of diffCells) if (!mines.has(k)) { mines.add(k); changed = true; }
          }
        }
      }
    }

    return { safe, mines, constraints: constraints.map(reduce).filter((c) => c.cells.size > 0) };
  }

  const COMPONENT_CELL_CAP = 28;
  const NODE_BUDGET = 400000;

  function logAdd(a, b) {
    if (a === -Infinity) return b;
    if (b === -Infinity) return a;
    const m = Math.max(a, b);
    return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
  }

  function buildComponents(constraints) {
    const parent = new Map();
    function find(x) { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
    for (const con of constraints) {
      for (const c of con.cells) if (!parent.has(c)) parent.set(c, c);
      const arr = [...con.cells];
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
    const groups = new Map();
    for (const con of constraints) {
      const root = find([...con.cells][0]);
      if (!groups.has(root)) groups.set(root, { cells: new Set(), constraints: [] });
      const g = groups.get(root);
      g.constraints.push(con);
      for (const c of con.cells) g.cells.add(c);
    }
    return [...groups.values()];
  }

  function enumerateComponent(cellsSet, constraints) {
    const cells = [...cellsSet];
    const n = cells.length;
    if (n > COMPONENT_CELL_CAP) return null;
    const cellIndex = new Map(cells.map((c, i) => [c, i]));
    const cons = constraints.map((con) => ({ need: con.count, idx: [...con.cells].map((c) => cellIndex.get(c)) }));
    const memberOf = cells.map(() => []);
    cons.forEach((con, ci) => con.idx.forEach((i) => memberOf[i].push(ci)));
    const remaining = cons.map((con) => con.idx.length);
    const current = cons.map(() => 0);
    const assignment = new Array(n).fill(-1);
    const distK = new Map();
    const cellMineCountByK = cells.map(() => new Map());
    let totalMines = 0;
    let budget = NODE_BUDGET;

    function tryAssign(pos, val) {
      const touched = memberOf[pos];
      for (let idx = 0; idx < touched.length; idx++) {
        const ci = touched[idx];
        current[ci] += val;
        remaining[ci]--;
        if (current[ci] > cons[ci].need || current[ci] + remaining[ci] < cons[ci].need) {
          for (let j = 0; j <= idx; j++) { const cj = touched[j]; current[cj] -= val; remaining[cj]++; }
          return false;
        }
      }
      assignment[pos] = val;
      totalMines += val;
      return true;
    }
    function undoAssign(pos, val) {
      for (const ci of memberOf[pos]) { current[ci] -= val; remaining[ci]++; }
      assignment[pos] = -1;
      totalMines -= val;
    }
    function recordSolution() {
      const k = totalMines;
      distK.set(k, (distK.get(k) || 0) + 1);
      for (let i = 0; i < n; i++) {
        if (assignment[i] === 1) {
          const m = cellMineCountByK[i];
          m.set(k, (m.get(k) || 0) + 1);
        }
      }
    }
    function dfs(pos) {
      if (budget-- <= 0) return false;
      if (pos === n) { recordSolution(); return true; }
      for (const val of [0, 1]) {
        if (tryAssign(pos, val)) {
          const ok = dfs(pos + 1);
          undoAssign(pos, val);
          if (!ok) return false;
        }
      }
      return true;
    }

    if (!dfs(0)) return null;
    return { cells, distK, cellMineCountByK };
  }

  function convolveLog(a, b) {
    const out = new Map();
    for (const [ka, la] of a) for (const [kb, lb] of b) {
      const k = ka + kb, v = la + lb;
      out.set(k, logAdd(out.has(k) ? out.get(k) : -Infinity, v));
    }
    return out;
  }

  function guessCell(grid, rows, cols, mineCount, solveResult) {
    const { mines, safe, constraints } = solveResult;
    const unrevealed = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (!grid[r][c].revealed) unrevealed.push(key(r, c));
    }
    if (unrevealed.length === rows * cols) {
      return key(Math.floor(rows / 2), Math.floor(cols / 2));
    }

    const remainingMines = Math.max(0, mineCount - mines.size);
    const frontierAll = new Set();
    for (const con of constraints) for (const k of con.cells) frontierAll.add(k);
    const nonFrontierBase = unrevealed.filter((k) => !frontierAll.has(k) && !mines.has(k) && !safe.has(k));

    const components = buildComponents(constraints);
    const exactComps = [];
    const fallbackCells = [...nonFrontierBase];
    for (const comp of components) {
      const res = enumerateComponent(comp.cells, comp.constraints);
      if (res) exactComps.push(res);
      else fallbackCells.push(...comp.cells);
    }

    const prob = new Map();

    if (exactComps.length > 0) {
      const compDistArrs = exactComps.map((c) => [...c.distK]);
      let fullConv = null;
      for (const arr of compDistArrs) {
        const m = new Map(arr);
        fullConv = fullConv ? convolveLog([...fullConv], [...m]) : m;
      }

      const effectiveNonFrontier = fallbackCells.length;
      const maxN = Math.max(effectiveNonFrontier, remainingMines, 1) + 2;
      const logFact = [0];
      for (let i = 1; i <= maxN; i++) logFact.push(logFact[i - 1] + Math.log(i));
      function logC(n, k) { if (k < 0 || k > n || n < 0) return -Infinity; return logFact[n] - logFact[k] - logFact[n - k]; }

      exactComps.forEach((comp, ci) => {
        let others = null;
        compDistArrs.forEach((arr, j) => {
          if (j === ci) return;
          const m = new Map(arr);
          others = others ? convolveLog([...others], [...m]) : m;
        });
        if (!others) others = new Map([[0, 0]]);

        const owCache = new Map();
        for (const [k] of comp.distK) {
          let logSum = -Infinity;
          for (const [t, lv] of others) {
            const lc = logC(effectiveNonFrontier, remainingMines - k - t);
            if (lc === -Infinity) continue;
            logSum = logAdd(logSum, lv + lc);
          }
          owCache.set(k, logSum);
        }

        let Z = -Infinity;
        for (const [k, cnt] of comp.distK) {
          const w = owCache.get(k);
          if (w === -Infinity || w === undefined) continue;
          Z = logAdd(Z, Math.log(cnt) + w);
        }

        comp.cells.forEach((cellKey, idx) => {
          const m = comp.cellMineCountByK[idx];
          let num = -Infinity;
          for (const [k, cnt] of m) {
            const w = owCache.get(k);
            if (w === -Infinity || w === undefined) continue;
            num = logAdd(num, Math.log(cnt) + w);
          }
          const p = (num === -Infinity || Z === -Infinity) ? 0 : Math.exp(num - Z);
          prob.set(cellKey, p);
        });
      });

      if (effectiveNonFrontier > 0 && fullConv) {
        const sWeights = [];
        for (const [s, lv] of fullConv) {
          const lc = logC(effectiveNonFrontier, remainingMines - s);
          if (lc === -Infinity) continue;
          sWeights.push([s, lv + lc]);
        }
        if (sWeights.length > 0) {
          const maxLW = Math.max(...sWeights.map((x) => x[1]));
          let zLin = 0, mineFrac = 0;
          for (const [s, lw] of sWeights) {
            const w = Math.exp(lw - maxLW);
            zLin += w;
            mineFrac += w * ((remainingMines - s) / effectiveNonFrontier);
          }
          const nfProb = zLin > 0 ? mineFrac / zLin : remainingMines / effectiveNonFrontier;
          for (const k of fallbackCells) prob.set(k, nfProb);
        }
      }
    }

    if (prob.size === 0) {
      for (const con of constraints) {
        const p = con.count / con.cells.size;
        for (const k of con.cells) if (!prob.has(k) || p < prob.get(k)) prob.set(k, p);
      }
      const globalP = unrevealed.length > 0 ? remainingMines / unrevealed.length : 0;
      for (const k of nonFrontierBase) if (!prob.has(k) || globalP < prob.get(k)) prob.set(k, globalP);
    }

    let best = null, bestP = Infinity;
    for (const [k, p] of prob) {
      if (mines.has(k) || safe.has(k)) continue;
      if (p < bestP) { bestP = p; best = k; }
    }
    return best;
  }

  function selectDifficulty() {
    if (difficultyEl.value !== CONFIG.DIFFICULTY) {
      difficultyEl.value = CONFIG.DIFFICULTY;
      difficultyEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      smileyEl.click(); // 已經是目標難度，直接按笑臉重開一局乾淨的
    }
  }

  const MINE_COUNT = { beginner: 10, intermediate: 40, expert: 99 };

  async function playOneGame() {
    selectDifficulty();
    await sleep(0);
    const mineCount = MINE_COUNT[CONFIG.DIFFICULTY];

    while (true) {
      if (window.__minesweeperBotStop) return 'stopped';

      const face = smileyEl.textContent;
      if (face === '😎') return 'win';
      if (face === '😵') return 'lose';

      const { grid, rows, cols } = readBoard();
      const result = solve(grid, rows, cols);

      if (result.safe.size > 0) {
        for (const k of result.safe) {
          if (window.__minesweeperBotStop) return 'stopped';
          const [r, c] = k.split(',').map(Number);
          grid[r][c].el.click();
          await sleep(0);
          const f = smileyEl.textContent;
          if (f === '😎' || f === '😵') return f === '😎' ? 'win' : 'lose';
        }
        continue;
      }

      const guess = guessCell(grid, rows, cols, mineCount, result);
      if (guess == null) return 'stuck'; // 理論上不會發生（還有未翻格子時一定猜得出一個）
      const [gr, gc] = guess.split(',').map(Number);
      grid[gr][gc].el.click();
      await sleep(0);
    }
  }

  async function main() {
    let attempts = 0;
    while (!window.__minesweeperBotStop) {
      attempts++;
      const outcome = await playOneGame();
      if (outcome === 'stopped') { attempts--; break; }

      if (outcome === 'win') {
        window.__minesweeperBotStats = { attempts, result: 'win' };
        console.log(`🎉 第 ${attempts} 局獲勝！難度 ${CONFIG.DIFFICULTY}，用時 ${timerEl.textContent}s`);
        return window.__minesweeperBotStats;
      }
      console.log(`[第 ${attempts} 局] 💥 踩雷，重新開始第 ${attempts + 1} 局...`);
      await sleep(0);
    }
    window.__minesweeperBotStats = { attempts, result: 'stopped' };
    console.log('踩地雷 bot 已停止（未獲勝）：', window.__minesweeperBotStats);
    return window.__minesweeperBotStats;
  }

  main();
})();
