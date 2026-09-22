# othello 開發筆記（給 AI／維護者看，非玩家說明）

給人看的版本在 [../../othello/攻略.md](../../othello/攻略.md)。這份放實際對戰要用的程式碼（`playMove()`、已驗證必勝套路）、AI 演算法還原、本地搜尋工具與調校過程。

## 開局動作（每次對戰第一件事）

不要用截圖+點擊下棋，直接用引擎 API，見下方 `window.playMove(r,c)`。

## 對戰結束後（每次對戰最後一件事）

不管輸贏，只要這場對局有新發現（AI 的新弱點、更好的候選排序、新驗證過的套路等），當場就把它寫回這份筆記（或人看的 `攻略.md`），不要只在對話裡講講就結束。

## 直接可貼的操作程式碼（實際對戰用）

```js
// 不點擊、直接驅動引擎 + 同步畫面（refresh() 是頁面自帶全域函式）
window.playMove = function(r, c){
  const py = s => pyodide.runPython(s);
  const ok = py(`game.place(${r}, ${c})`);
  if(!ok) return {error:'illegal'};
  let s = refresh();
  while(s.current === 2 && !s.winner){ // 白方（AI）自動連下，直到輪回黑方或分出勝負
    py("_mv = game.ai_move()\nif _mv is not None:\n    game.place(_mv[0], _mv[1])");
    s = refresh();
  }
  return {state: s, done: !!s.winner};
};
```

## 最快的玩法：直接複用下面已驗證的必勝套路

黑方固定天元開局 `(2,3)`。下面 10 條黑方落子序列都已經用**真引擎**（獨立 `verify_scratch` 實例，含真正的 `ai_move()`）完整驗證過 `winner: 1`（黑勝）。**要下棋時直接挑一條，把整串座標丟給 `playMove()` 跑完就贏**：

```js
const blackMoves = [[2,3],[3,2],[2,5],[5,2],[4,5],[5,4],[1,2],[2,7],[0,5],[0,4],[0,2],[4,6],[4,7],[0,7],[1,7],[5,6],[2,0],[4,0],[4,1],[7,5],[7,2],[7,4],[5,0],[5,7],[1,0],[6,7],[6,2],[1,1],[0,1],[6,1]]; // 套路一，36:28
let last;
for(const [r,c] of blackMoves){ last = window.playMove(r,c); if(last.done) break; }
```

| 套路 | 黑方落子順序（30手） | 終局比分（黑:白） |
|---|---|---|
| 一 | `(2,3)(3,2)(2,5)(5,2)(4,5)(5,4)(1,2)(2,7)(0,5)(0,4)(0,2)(4,6)(4,7)(0,7)(1,7)(5,6)(2,0)(4,0)(4,1)(7,5)(7,2)(7,4)(5,0)(5,7)(1,0)(6,7)(6,2)(1,1)(0,1)(6,1)` | 36:28 |
| 二 | `(2,3)(4,5)(5,2)(3,2)(2,1)(0,4)(5,4)(1,2)(3,1)(3,5)(6,2)(5,7)(5,0)(7,5)(0,3)(7,3)(1,4)(4,1)(4,0)(1,5)(2,6)(3,7)(4,6)(1,1)(6,1)(6,6)(1,6)(0,1)(0,7)(7,7)` | 33:30 |
| 三 | `(2,3)(2,1)(2,5)(0,5)(5,4)(3,2)(4,2)(5,6)(1,2)(0,3)(3,0)(3,6)(4,7)(1,5)(2,6)(3,7)(4,1)(1,1)(1,6)(6,6)(5,1)(5,2)(5,3)(7,2)(6,5)(6,4)(7,3)(0,0)(7,0)(7,6)` | 34:30 |
| 四 | `(2,3)(5,4)(3,2)(2,5)(4,5)(1,3)(2,7)(0,4)(4,6)(0,2)(3,1)(5,3)(2,1)(5,6)(4,1)(4,0)(5,1)(7,2)(6,2)(7,3)(6,4)(7,5)(0,6)(1,1)(6,1)(6,0)(1,0)(5,7)(3,7)(7,7)` | 33:31 |
| 五 | `(2,3)(3,2)(1,3)(2,5)(5,3)(2,7)(0,2)(5,4)(2,1)(3,1)(5,1)(3,5)(4,6)(7,3)(5,7)(5,6)(4,1)(4,0)(1,1)(1,4)(6,5)(7,2)(7,4)(1,0)(1,5)(6,1)(7,7)(7,0)(6,6)(0,7)` | 33:31 |
| 六 | `(2,3)(3,2)(4,5)(2,5)(1,3)(2,7)(0,2)(5,3)(0,4)(2,1)(3,1)(4,0)(5,1)(4,6)(1,5)(3,7)(1,0)(1,1)(1,6)(5,6)(6,6)(5,5)(6,1)(6,3)(6,5)(6,4)(6,2)(7,4)(7,6)(7,1)(0,6)` | 33:31 |
| 七 | `(2,3)(4,5)(6,2)(2,4)(4,2)(1,5)(2,1)(7,3)(5,1)(6,0)(3,1)(7,1)(6,1)(5,5)(7,5)(7,6)(5,6)(6,7)(3,2)(4,6)(0,4)(1,3)(2,7)(5,0)(5,7)(3,7)(0,1)(0,6)(0,7)(1,0)` | 33:31 |
| 八 | `(2,3)(2,1)(4,5)(3,2)(1,3)(2,5)(0,3)(1,4)(3,1)(1,2)(5,2)(4,0)(1,5)(4,6)(2,7)(6,4)(1,0)(1,1)(1,6)(3,7)(6,3)(0,6)(5,7)(6,1)(5,6)(6,2)(6,5)(7,4)(6,6)(7,6)(7,1)` | 33:31 |
| 九 | `(2,3)(5,4)(5,6)(2,5)(4,5)(3,2)(4,2)(1,3)(1,5)(2,7)(4,7)(6,5)(4,6)(1,2)(4,0)(3,0)(6,2)(6,3)(4,1)(0,6)(7,4)(7,2)(1,0)(1,4)(6,7)(0,3)(0,1)(7,6)(1,1)(7,0)(6,0)(1,6)` | 35:29 |
| 十 | `(2,3)(2,1)(5,5)(2,5)(3,5)(5,3)(1,3)(2,7)(0,2)(3,1)(3,7)(4,6)(1,0)(1,4)(1,1)(4,1)(6,6)(5,1)(1,5)(4,2)(6,5)(4,7)(1,6)(0,6)(6,4)(7,3)(6,3)(6,1)(6,2)(7,1)(7,6)` | 35:29 |

前四條以黑方第一手 `(2,3)`（黑方開局唯一 4 個對稱等價選擇之一）起手，差異在黑方第二手：套路一 `(3,2)`、二 `(4,5)`、三 `(2,1)`、四 `(5,4)`（這四個是黑方第二手全部合法選擇，已經分岔完）。套路五～十全部改在**第三手**分岔（分別從套路一～四的前綴接上另一個合法的第三手）：

- 套路五、六：接在套路一 `(2,3)(3,2)` 後面，分別改走 `(1,3)`、`(4,5)`（原套路一第三手是 `(2,5)`）
- 套路七：接在套路二 `(2,3)(4,5)` 後面，改走 `(6,2)`（原第三手是 `(5,2)`）
- 套路八：接在套路三 `(2,3)(2,1)` 後面，改走 `(4,5)`（原第三手是 `(2,5)`）
- 套路九：接在套路四 `(2,3)(5,4)` 後面，改走 `(5,6)`（原第三手是 `(3,2)`）
- 套路十：接在套路三 `(2,3)(2,1)` 後面，改走 `(5,5)`

**分岔點越晚、搜尋成本差異越大、也越不可預測**：同樣是第三手分岔，節點數從 361（套路九）到 60102（套路七）都有，差了快 170 倍，跟該分支底下黑方候選走法的優劣分布有關，沒有固定規律，只能實測。**之後想找第 11 條以後，一律用下面的搜尋工具從某條套路的中後段分岔，budget 給大一點（`nodeBudget` 抓 5~10 萬，用 `window.searchResult=null` + 再呼叫 `runSearch` 續跑來拉高上限），不要手動摸索。**

## AI 演算法（已完全破解）

白方 AI 原始碼可直接 `fetch('othello.py')` 讀到（同源、無 CORS 問題）。核心邏輯：

- **落子規則**：8×8、黑先，落子必須至少翻轉一顆對方棋子；某方無合法步時自動跳過（`_resolve_turn`），雙方皆無合法步則結束，子多者勝。
- **評分函式 `evaluate(board, color)`**：`位置權重 + 機動性*1.5 + 子數差*權重`
  - 位置權重表：角極高分 120、角旁 `-20/-40`（送角風險，故意設計成負分讓 AI 避開）、邊 `20`、中心平庸 `3~5`。
  - 機動性：`100*(我方合法步數-對方合法步數)/(兩者相加)`。
  - 子數差：`100*(我方子數-對方子數)/(總子數)`，權重殘局（空格≤12）拉高到 `2.0`，前中盤只有 `0.1`（故意前中盤不看重子數，只看位置+機動性）。
- **搜尋**：`negamax + alpha-beta`，一般深度 4；殘局空格 ≤8 時 `depth=空格數`（等於窮盡搜尋到底，殘局是完美的，打不過）。
- **關鍵弱點**：深度只有 4，且前中盤刻意壓低子數差權重（只有 0.1），代表它願意為了位置/機動性犧牲不少子——這給了「深路徑規劃」很大操作空間：只要黑方每步都照抄下方單人搜尋工具找到的序列，因為 AI 是**盤面的決定性函式**，白方每一手都算得出來（不用呼叫 Python），黑方選擇的問題就退化成「單人路徑搜尋」，跟五子棋當初「白方零前瞻」被破解是同一類手法，只是這次白方前瞻到 4 層（殘局更深到窮盡），計算成本高很多。

## 本地搜尋工具（想找新套路，用這個）

已用 **3 場完整自我對局**（開局到終局全程，含殘局窮盡搜尋那段）逐步比對驗證：下面 JS 版 `OTH.aiMove` 跟真引擎 `game.ai_move()` 每一步輸出**完全一致**，0 誤差。

```js
// 1) 純 JS 重現 othello.py 的翻子/合法步/評分/negamax+alpha-beta 邏輯
window.OTH = (function(){
  const SIZE=8, EMPTY=0, BLACK=1, WHITE=2;
  const DIRS=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  const WEIGHTS=[
    [120,-20,20,5,5,20,-20,120],
    [-20,-40,-5,-5,-5,-5,-40,-20],
    [20,-5,15,3,3,15,-5,20],
    [5,-5,3,3,3,3,-5,5],
    [5,-5,3,3,3,3,-5,5],
    [20,-5,15,3,3,15,-5,20],
    [-20,-40,-5,-5,-5,-5,-40,-20],
    [120,-20,20,5,5,20,-20,120],
  ];
  const other=c=>c===BLACK?WHITE:BLACK;
  function flipsOn(b,r,c,color){
    if(b[r][c]!==EMPTY) return [];
    const opp=other(color);
    let total=[];
    for(const [dr,dc] of DIRS){
      let line=[];
      let nr=r+dr, nc=c+dc;
      while(nr>=0&&nr<SIZE&&nc>=0&&nc<SIZE&&b[nr][nc]===opp){ line.push([nr,nc]); nr+=dr; nc+=dc; }
      if(line.length && nr>=0&&nr<SIZE&&nc>=0&&nc<SIZE&&b[nr][nc]===color) total=total.concat(line);
    }
    return total;
  }
  function legalMovesOn(b,color){
    const out=[];
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++) if(b[r][c]===EMPTY && flipsOn(b,r,c,color).length) out.push([r,c]);
    return out;
  }
  function applyMove(b,r,c,color,flips){
    b[r][c]=color;
    for(const [fr,fc] of flips) b[fr][fc]=color;
  }
  function evaluate(b,color){
    const opp=other(color);
    let pos=0;
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){
      const cell=b[r][c];
      if(cell===color) pos+=WEIGHTS[r][c];
      else if(cell===opp) pos-=WEIGHTS[r][c];
    }
    const myMoves=legalMovesOn(b,color).length;
    const oppMoves=legalMovesOn(b,opp).length;
    let mobility=0;
    if(myMoves+oppMoves) mobility=100*(myMoves-oppMoves)/(myMoves+oppMoves);
    let myDiscs=0, oppDiscs=0;
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){ if(b[r][c]===color)myDiscs++; else if(b[r][c]===opp)oppDiscs++; }
    const empties=SIZE*SIZE-myDiscs-oppDiscs;
    let discDiff=0;
    if(myDiscs+oppDiscs) discDiff=100*(myDiscs-oppDiscs)/(myDiscs+oppDiscs);
    const discWeight = empties<=12?2.0:0.1;
    return pos + mobility*1.5 + discDiff*discWeight;
  }
  function minimax(b, depth, alpha, beta, toMove, aiColor){
    const moves=legalMovesOn(b,toMove);
    const opp=other(toMove);
    if(moves.length===0){
      if(legalMovesOn(b,opp).length===0){
        let my=0,his=0;
        for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){ if(b[r][c]===aiColor)my++; else if(b[r][c]===other(aiColor))his++; }
        return my!==his ? 100000+(my-his) : 0;
      }
      if(depth===0) return evaluate(b,aiColor);
      return minimax(b, depth-1, alpha, beta, opp, aiColor);
    }
    if(depth===0) return evaluate(b,aiColor);
    const maximizing = toMove===aiColor;
    let value = maximizing? -Infinity: Infinity;
    for(const [r,c] of moves){
      const nb=b.map(row=>row.slice());
      applyMove(nb,r,c,toMove,flipsOn(nb,r,c,toMove));
      const score=minimax(nb, depth-1, alpha, beta, opp, aiColor);
      if(maximizing){ value=Math.max(value,score); alpha=Math.max(alpha,value); }
      else { value=Math.min(value,score); beta=Math.min(beta,value); }
      if(alpha>=beta) break;
    }
    return value;
  }
  function aiMove(b, current, depth=4){
    const moves=legalMovesOn(b,current);
    if(moves.length===0) return null;
    if(moves.length===1) return moves[0];
    let myDiscs=0, oppDiscs=0;
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){ if(b[r][c]!==EMPTY) { if(b[r][c]===current) myDiscs++; else oppDiscs++; } }
    const empties = SIZE*SIZE-myDiscs-oppDiscs;
    const d = empties<=8 ? empties : depth;
    const opp=other(current);
    let best=moves[0], bestVal=-Infinity;
    for(const [r,c] of moves){
      const nb=b.map(row=>row.slice());
      applyMove(nb,r,c,current,flipsOn(nb,r,c,current));
      const val=minimax(nb, d-1, -Infinity, Infinity, opp, current);
      if(val>bestVal){ bestVal=val; best=[r,c]; }
    }
    return best;
  }
  function initBoard(){
    const b=Array.from({length:SIZE},()=>Array(SIZE).fill(EMPTY));
    b[3][3]=WHITE; b[3][4]=BLACK; b[4][3]=BLACK; b[4][4]=WHITE;
    return b;
  }
  return {SIZE,EMPTY,BLACK,WHITE,DIRS,WEIGHTS,other,flipsOn,legalMovesOn,applyMove,evaluate,minimax,aiMove,initBoard};
})();

// 2) 回合推進（跳過/終局判定，比照 Python 的 _resolve_turn）+ 黑方候選排序（角優先、翻子數次之）
window.OTH2 = (function(){
  const {SIZE,BLACK,WHITE,other,flipsOn,legalMovesOn,applyMove,aiMove,WEIGHTS} = OTH;
  function countDiscs(b){
    let bl=0,w=0; for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){ if(b[r][c]===BLACK)bl++; else if(b[r][c]===WHITE)w++; }
    return {bl,w};
  }
  function resolveTurn(b, current){
    while(true){
      if(legalMovesOn(b,current).length>0) return {current, winner:null};
      const opp = other(current);
      if(legalMovesOn(b,opp).length>0){ current = opp; continue; }
      const {bl,w} = countDiscs(b);
      return {current, winner: bl===w?'draw':(bl>w?BLACK:WHITE)};
    }
  }
  // 黑方落子後，自動推進白方（AI）強制回應，直到輪回黑方或分出勝負；whiteMoves 附翻子紀錄供回溯用
  function settleToBlack(b, mover){
    let res = resolveTurn(b, other(mover));
    const whiteMoves=[];
    while(res.winner===null && res.current===WHITE){
      const wm = aiMove(b, WHITE, 4);
      const flips = flipsOn(b, wm[0], wm[1], WHITE);
      applyMove(b, wm[0], wm[1], WHITE, flips);
      whiteMoves.push({r:wm[0], c:wm[1], flips});
      res = resolveTurn(b, BLACK);
    }
    return {current: res.current, winner: res.winner, whiteMoves};
  }
  function rankBlackMoves(b){
    const moves = legalMovesOn(b, BLACK);
    return moves.map(([r,c])=>{
      const flips = flipsOn(b,r,c,BLACK);
      return {r,c,flips, score: WEIGHTS[r][c]*10 + flips.length};
    }).sort((a,b2)=>b2.score-a.score);
  }
  return {countDiscs, resolveTurn, settleToBlack, rankBlackMoves};
})();

// 3) 單人路徑 DFS：只有黑方分支（白方是決定性函式，直接算，不用分支），
//    可續跑（時間到就回傳 TIME_PAUSE，狀態留在 window 上，下次呼叫 runSearch 繼續）
function undoMove(b,r,c,mover,flips){
  b[r][c]=OTH.EMPTY;
  const opp = OTH.other(mover);
  for(const [fr,fc] of flips) b[fr][fc]=opp;
}
function undoApplied(b, moveInfo){
  for(let i=moveInfo.whiteMoves.length-1;i>=0;i--){ const m=moveInfo.whiteMoves[i]; undoMove(b, m.r, m.c, OTH.WHITE, m.flips); }
  undoMove(b, moveInfo.blackMove.r, moveInfo.blackMove.c, OTH.BLACK, moveInfo.blackMove.flips);
}
window.initSearch = function(branchFactor){
  window.searchBoard = OTH.initBoard();
  window.searchStack = [{candidates: OTH2.rankBlackMoves(window.searchBoard).slice(0,branchFactor), idx:0, moveInfo:null}];
  window.searchNodes = 0; window.searchBranchFactor = branchFactor; window.searchResult = null;
};
// 從指定的黑方開局前幾手（forcedMoves）開始搜，找不同分支的套路時用這個（比從頭搜快）
window.initSearchFromMoves = function(forcedMoves, branchFactor){
  const board = OTH.initBoard();
  const path = [];
  for(const [r,c] of forcedMoves){
    const flips = OTH.flipsOn(board, r, c, OTH.BLACK);
    OTH.applyMove(board, r, c, OTH.BLACK, flips);
    const settle = OTH2.settleToBlack(board, OTH.BLACK);
    path.push({blackMove:{r,c,flips}, whiteMoves: settle.whiteMoves});
    if(settle.winner!==null) throw new Error('game ended during forced prefix');
  }
  window.searchBoard = board;
  window.searchStack = [{candidates: OTH2.rankBlackMoves(board).slice(0,branchFactor), idx:0, moveInfo:null}];
  window.searchNodes = 0; window.searchBranchFactor = branchFactor; window.searchResult = null; window.searchPrefix = path;
};
window.runSearch = function(timeBudgetMs, nodeBudget){
  const t0 = performance.now();
  const board = window.searchBoard, stack = window.searchStack, K = window.searchBranchFactor;
  let result = window.searchResult;
  while(stack.length && !result){
    if(performance.now()-t0 > timeBudgetMs) return {status:'TIME_PAUSE', nodes: window.searchNodes};
    const top = stack[stack.length-1];
    if(top.idx >= top.candidates.length){
      const finished = stack.pop();
      if(finished.moveInfo) undoApplied(board, finished.moveInfo);
      continue;
    }
    const cand = top.candidates[top.idx++];
    window.searchNodes++;
    if(window.searchNodes > nodeBudget){ result={status:'BUDGET'}; break; }
    OTH.applyMove(board, cand.r, cand.c, OTH.BLACK, cand.flips);
    const settle = OTH2.settleToBlack(board, OTH.BLACK);
    const moveInfo = {blackMove:{r:cand.r,c:cand.c,flips:cand.flips}, whiteMoves: settle.whiteMoves};
    if(settle.winner !== null){
      if(settle.winner===OTH.BLACK){
        const path = stack.slice(1).map(f=>f.moveInfo).concat([moveInfo]);
        result = {status:'WIN', path};
        undoApplied(board, moveInfo);
        break;
      }
      undoApplied(board, moveInfo);
      continue;
    }
    stack.push({candidates: OTH2.rankBlackMoves(board).slice(0,K), idx:0, moveInfo});
  }
  if(!result) result = stack.length===0 ? {status:'EXHAUSTED'} : {status:'UNKNOWN'};
  window.searchResult = result;
  return {status: result.status, nodes: window.searchNodes, path: result.path};
};

// 4) 用「獨立的 verify_scratch 實例」跑一次真引擎全程驗證（絕對準確，含真正的 ai_move()）
window.verifySequence = function(blackMoves){
  pyodide.runPython("verify_scratch = Game()");
  const py = s => pyodide.runPython(s);
  const log = [];
  for(const [r,c] of blackMoves){
    const ok = py(`verify_scratch.place(${r}, ${c})`);
    if(!ok){ log.push({r,c,error:'rejected_or_illegal'}); return {ok:false, log}; }
    let st = JSON.parse(py("verify_scratch.state()"));
    if(st.winner) return {ok: st.winner===1, winner: st.winner, log, black: st.black, white: st.white};
    while(st.current===2 && !st.winner){
      const mv = py("verify_scratch.ai_move()");
      const arr = mv.toJs ? mv.toJs() : mv;
      if(!arr) break;
      py(`verify_scratch.place(${arr[0]}, ${arr[1]})`);
      st = JSON.parse(py("verify_scratch.state()"));
    }
    if(st.winner) return {ok: st.winner===1, winner: st.winner, log, black: st.black, white: st.white};
  }
  return {ok:false, note:'跑完序列還沒分勝負'};
};
```

**找新套路的固定流程：**
1. `window.initSearch(branchFactor)` 從開局重新搜；或 `window.initSearchFromMoves([[r,c],...], branchFactor)` 指定黑方前幾手強制走法（想岔開已有套路時用這個）。
2. `window.runSearch(timeBudgetMs, nodeBudget)`：`status:'WIN'` 才算數；`'TIME_PAUSE'`（時間到但還沒搜完）直接再呼叫一次 `runSearch` 續跑（狀態留在 `window.searchBoard/searchStack` 上不會丟失）；`'BUDGET'`（節點數超過 `nodeBudget`）要先 `window.searchResult = null` 再呼叫 `runSearch(timeBudgetMs, 更大的nodeBudget)` 才會繼續（否則會直接原地回傳同一個 BUDGET 結果，不會真的續跑）。
3. 拿到 `WIN` 後，`(window.searchPrefix||[]).concat(window.searchResult.path).map(p=>[p.blackMove.r,p.blackMove.c])` 取得完整黑方落子序列。
4. **務必用 `window.verifySequence(blackMoves)` 過一次真引擎再放心複用**（呼叫真正的 `ai_move()`，跟 JS mirror 分開的獨立驗證）。
5. `branchFactor` 給 3~4 通常就能在幾十到幾百個節點內找到解；若卡住可以調大 `branchFactor` 或用 `initSearchFromMoves` 換個分岔點重試。
6. 驗證通過的新序列記得補進本檔案「最快的玩法」那節的套路表格。

## 搜尋候選排序（實測調校過，改動前先看這節）

`OTH2.rankBlackMoves()` 決定 DFS 先試哪一手。它**不影響正確性**（不管怎麼排，找到的序列都會過終局驗證），但直接決定「要翻多少節點才撞到必勝解」，是搜尋速度最大的單一槓桿。目前的公式：

```js
score = WEIGHTS[r][c] * 10 - whiteOpts * 12 - flipCount * 3
```

三項的來歷（30 次隨機搜尋 x 2 組種子實測比較，`scratchpad/bench-ab.js`）：

| 排序 | 中位節點數 | p90 節點數 |
|---|---|---|
| 舊版：`WEIGHTS*10 + flipCount`（角優先＋**獎勵**多翻子） | 1660 / 2595 | 8470 / 11173 |
| 只加「減白方機動力」 | 1088 | 3874 |
| 只加「減翻子數」 | 2191 | 6282 |
| **現用：兩者都加** | **526 / 526** | **4111 / 4988** |

- **減白方機動力（`whiteOpts`）貢獻最大**：白方是決定性函式，可選的合法步越少，越容易被逼進唯一解、越快收斂到終局，這正是單人路徑搜尋想要的。
- **減翻子數**：早期少翻子（安靜手）讓自己的邊界小，是黑白棋通則。舊版公式 `+ flipCount` 等於在**獎勵**多翻子，方向剛好相反——這是舊版最大的浪費來源。
- 兩項單獨用都有效，合起來才到 526（比舊版少 3~5 倍節點）。

### settleToBlack 快取

`settleToBlack()`（白方被迫回應那串）是盤面的純函式，而 DFS 不同分支經常走到同一個盤面，所以整輪搜尋共用一份 `Map` 快取（`settleToBlackCached`，每次 `findRandomWinningSequence` 開頭清空）。實測命中率約 **38%**，整體快約 **1.5 倍**；因為是純函式快取，**節點數與搜尋結果完全不變**（實測前後節點數一模一樣，526/4111），純粹省掉重算深度4 minimax。

### 整體實測（舊 vs 新，同機同種子各 30 次）

| | 中位耗時 | p90 耗時 | 中位節點 |
|---|---|---|---|
| 舊 | 2085ms / 5672ms | 13228ms / 17985ms | 1660 / 2595 |
| 新 | 1112ms / 1093ms | 2443ms / 5573ms | 526 / 526 |

成功率新舊都是 **100%（60 次全中）**——原本擔心的「找不到必勝序列」在 60 次基準測試裡一次都沒出現，真正的痛點是耗時（尤其 p90），所以強化重點放在那裡。

### 試過但否決的做法

- **在 minimax 內部加置換表（transposition table）**：先量測「同一個 (盤面, 深度, 輪到誰) 在一次深度4搜尋裡重複出現的比率」，實測只有 **2~8%**（`scratchpad/probe-tt.js`），上限不到 5% 的節點節省，還得先扣掉雜湊成本；而要正確實作又必須處理 alpha-beta 的 bound flag（EXACT/LOWER/UPPER）與視窗判斷，是會靜默破壞 mirror 精確性的高風險程式碼。**投報率不成比例，否決。**
- **調整預算階梯／自適應 branchFactor**（fail-fast 後改用 bf 4~5 重試，而不是換下一個候選）：實測中位/p90 都沒有穩定勝過現行「bf 3 + 預算 6000 加倍兩次後換候選」，差異落在計時雜訊範圍內。**沒有證據支持，維持現狀。**

## 血淚教訓（不要再犯）

- **這款 AI 比五子棋強很多（真 negamax+alpha-beta，非零前瞻），但仍是決定性函式**——不要被「深度4」嚇到就想放棄找必勝序列，單人路徑搜尋一樣有效，只是每個節點要跑一次深度4的 minimax（含大量 `legalMovesOn` 呼叫），比五子棋單點評分貴了兩三個數量級，所以 `branchFactor` 要控制小（3~4），不能像五子棋那樣開到 8。
- **JS mirror 一定要先跑過完整自我對局比對（含殘局窮盡搜尋那段）再信任**：只驗證開局幾步不夠，`evaluate()` 的 `discWeight` 在空格≤12 時會切換（`0.1→2.0`），`ai_move` 在空格≤8 時搜尋深度也會切換成窮盡搜尋，這兩個分支切換點都必須跑到才算驗證完整。本次用 3 場完整對局（開局到終局）驗證，0 誤差。
- **呼叫真引擎 `ai_move()` 一次要價 ~100ms~3 秒**（隨盤面分支數與殘局窮盡搜尋而變慢），批次驗證/搜尋時避免逐步呼叫 Python，一律用 JS mirror 算，只在最後 `verifySequence` 驗證階段才呼叫真引擎。
- **黑方開局只有 4 個對稱等價的合法選擇**（`(2,3)/(3,2)/(4,5)/(5,4)`，四者互為棋盤對稱），選哪個結果等價；真正有意義的分岔點是黑方第 2 手。
