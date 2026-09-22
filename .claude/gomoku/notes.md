# gomoku 開發筆記（給 AI／維護者看，非玩家說明）

給人看的版本在 [../../gomoku/攻略.md](../../gomoku/攻略.md)。這份放實際對戰要用的程式碼（`playMove()`、已驗證必勝套路）、AI 邏輯怎麼被破解的分析、以及想找第 11 條以後套路的本地搜尋工具。

## 開局動作（每次對戰第一件事）

1. 讀取 `document.getElementById('renju').checked` 確認禁手規則狀態，除非使用者要求，不要自己動這個 checkbox。
2. 不要用截圖+點擊座標下棋，直接用引擎 API，見下方程式碼。

## 對戰結束後（每次對戰最後一件事）

不管輸贏，只要這場對局有新發現，當場就把它寫回這份筆記（或人看的 `攻略.md`），不要只在對話裡講講就結束。

## 直接可貼的操作程式碼

```js
// 不點擊、直接驅動引擎 + 同步畫面（refresh() 是頁面自帶全域函式）
window.playMove = function(r,c){
  const py = s => pyodide.runPython(s);
  const forb = py(`game.forbidden(${r},${c})`);
  if(forb) return {error:'forbidden', reason: forb};
  const ok = py(`game.place(${r},${c})`);
  if(!ok) return {error:'rejected'};
  refresh();
  let s = JSON.parse(py('game.state()'));
  if(s.winner) return {state:s, done:true};
  const mv = py('game.ai_move()');
  const arr = mv.toJs?mv.toJs():mv;
  py(`game.place(${arr[0]},${arr[1]})`);
  refresh();
  s = JSON.parse(py('game.state()'));
  return {state:s, whiteMove:[arr[0],arr[1]], done: !!s.winner};
};
```

## 最快的玩法：直接複用下面 10 條已驗證必勝套路

黑方固定天元 (7,7) 起手、白方第一手固定回 (6,6)。下面每一條都已經用真引擎（獨立 scratch 實例）驗證過 `winner:'black'`。**要下棋時直接挑一條，把整串座標丟給 `playMove()` 跑完就贏**，不用臨場判斷：

```js
const blackMoves = [[7,7],[6,7],[7,8],[6,8],[5,9],[8,6],[7,9],[6,10],[7,11],[4,8],[8,12]]; // 套路四，11手
let last;
for(const [r,c] of blackMoves){ last = window.playMove(r,c); if(last.done) break; }
```

| 套路 | 黑方落子順序 |
|---|---|
| 一 | `(7,7)(8,7)(9,7)(8,8)(6,9)(6,4)(7,9)(6,10)(5,9)(4,9)(9,10)(4,5)(7,10)(8,11)(9,12)(7,12)(7,11)(8,12)(9,13)` |
| 二 | `(7,7)(7,8)(7,9)(8,8)(9,6)(4,6)(9,8)(10,8)(6,10)(5,11)(9,9)(8,9)(10,9)(8,10)(8,11)(7,11)(6,11)(4,11)` |
| 三 | `(7,7)(8,9)(8,8)(6,9)(6,4)(8,10)(8,11)(7,10)(9,12)(9,10)(10,10)(9,9)(9,11)(9,13)` |
| 四 | `(7,7)(6,7)(7,8)(6,8)(5,9)(8,6)(7,9)(6,10)(7,11)(4,8)(8,12)` |
| 五 | `(7,7)(7,8)(8,7)(6,9)(9,6)(8,8)(8,9)(7,9)(7,10)(8,11)(5,8)(9,12)` |
| 六 | `(7,7)(9,9)(6,8)(7,8)(7,6)(7,9)(8,9)(9,10)(8,10)(9,11)(9,8)(9,7)` |
| 七 | `(7,7)(6,8)(7,8)(7,9)(7,10)(5,7)(4,6)(6,7)(6,9)(8,7)(5,10)(4,11)` |
| 八 | `(7,7)(6,9)(7,8)(8,7)(9,6)(8,8)(8,9)(7,9)(7,10)(8,11)(5,8)(9,12)` |
| 九 | `(7,7)(7,6)(8,7)(8,6)(6,8)(9,5)(8,8)(7,8)(7,9)(8,10)(5,7)(9,11)` |
| 十 | `(7,7)(10,8)(6,8)(7,8)(7,6)(7,9)(5,7)(4,6)(8,7)(9,8)(10,9)(11,10)` |

套路一～三是早期手動摸索出來的（找起來慢、常常失敗，過程教訓見下方）；套路四～十全部改用「本地搜尋工具」那節的搜尋工具找到，每條約 1 秒內找到並驗證通過。**之後想找第 11 條以後，一律用搜尋工具，不要回頭手動摸索。**

## 血淚教訓（不要再犯）

- **不要心算 canvas 座標，也不要用截圖+點擊落子**：一律用 `window.playMove(r,c)`，兩次真的算錯像素座標直接輸掉整局。
- **引擎完全決定性（同盤面同回應）**：只要黑方每步完全照抄「已驗證套路」的落子順序，白方回應必定一致。若要用 `game.undo(n)` 做任何實驗，一定要包 try/finally 或確保呼叫次數配對，避免真局面被搞壞。
- **合法性一律以 `game.forbidden()`／`scratch.forbidden()` 為準，不要自己心算三三/四四禁手**：連續三子以外的跳三（B_BB 這種帶空格的形狀）也可能被判活三；`SIM2.preciseForbidden` 只是近似版，找到新套路後務必過 `verifySequence` 這關（它呼叫的是真正的 `forbidden()`）。
- **白方 AI 是單點貪婪、零前瞻**（`score = self_score(me)*1.1 + self_score(opp)`，逐格評分取最高分），沒有任何盤面級推演——這就是為什麼手動臨場判斷常常失敗：白方很多「陷阱」其實是它自己在追求局部分數極大化時的巧合產物，光憑肉眼或 1 層前瞻的程式很難穩定預判。**改用下面「本地搜尋工具」的本地搜尋+真引擎驗證，才是可靠做法**，找套路成功率跟速度都遠勝手動判斷，之後不要再走回頭路。

## 白方 AI 演算法（已完全破解）

白方 AI 原始碼可直接 `fetch('gomoku.py')` 讀到（同源、無 CORS 問題）。核心邏輯：

```python
# ai_move 逐格掃描「靠近既有棋子」的空格，取分數最高者（同分取 r 小、c 小者）
score = self._score(r, c, me) * 1.1 + self._score(r, c, opp)
# _score(r,c,color)：假設 color 落在 (r,c)，四方向 count/openEnds 查表加總
#   count>=5→1000萬；count4 openEnds2→10萬/1→1萬；count3→1000/100；count2→100/10；count1→1
```

**AI 是完全貪婪、單點評分、零前瞻**：沒有任何盤面級的多步推演，那些「巧合」陷阱多半是白方單純極大化自己某點的局部分數，剛好疊加在它自己另一條發展中的線上。**因為白方對任何盤面的下一手是決定性、無分支的函式**，找必勝路線不是雙人賽局搜尋，是單人路徑搜尋：黑方選一個候選，白方回應直接算得出來（不用呼叫 Python），遞迴到黑方連五即可。整個模擬用純 JS 做，比逐步呼叫 Pyodide 的暴力搜尋快幾百倍（**實測 700~1200 節點、200~1000 毫秒內找到保證獲勝的完整序列**，舊版「暴力搜尋不可行」的結論已作廢）。

## 本地搜尋工具（想找新套路/第 11 條以後，用這個）

```js
// 1) 純 JS 重現白方 AI 的評分/選子邏輯（已逐格比對驗證跟真引擎完全一致）
window.SIM = (function(){
  const SIZE=15, DIRS=[[0,1],[1,0],[1,1],[1,-1]];
  const inb=(r,c)=>r>=0&&r<SIZE&&c>=0&&c<SIZE;
  function scoreAt(b,r,c,color){
    let total=0;
    for(const [dr,dc] of DIRS){
      let count=1, openEnds=0;
      for(const s of [1,-1]){
        let nr=r+dr*s, nc=c+dc*s;
        while(inb(nr,nc) && b[nr][nc]===color){count++;nr+=dr*s;nc+=dc*s;}
        if(inb(nr,nc) && b[nr][nc]===0) openEnds++;
      }
      if(count>=5) total+=10000000;
      else if(count===4) total += openEnds===2?100000:(openEnds?10000:0);
      else if(count===3) total += openEnds===2?1000:(openEnds?100:0);
      else if(count===2) total += openEnds===2?100:(openEnds?10:0);
      else total+=1;
    }
    return total;
  }
  function nearStone(b,r,c,dist=2){
    for(let dr=-dist;dr<=dist;dr++)for(let dc=-dist;dc<=dist;dc++){
      const nr=r+dr,nc=c+dc;
      if(inb(nr,nc)&&b[nr][nc]!==0) return true;
    }
    return false;
  }
  function aiMove(b, me, empty){
    if(empty) return [7,7];
    const opp = me===1?2:1;
    let best=null, bestScore=-1;
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){
      if(b[r][c]!==0 || !nearStone(b,r,c)) continue;
      const score = scoreAt(b,r,c,me)*1.1 + scoreAt(b,r,c,opp);
      if(score>bestScore){bestScore=score;best=[r,c];}
    }
    return best;
  }
  return {scoreAt, aiMove, nearStone, SIZE, DIRS};
})();

// 2) 精確版禁手判斷（完整移植 Python 的 _fours() 5格窗掃描，比單純 count/openEnds 準——
//    粗略版漏抓過一次「四四禁手」，搜尋出來的路線在真引擎驗證時失敗過）
window.SIM2 = (function(){
  const SIZE=15, DIRS=[[0,1],[1,0],[1,1],[1,-1]];
  const inb=(x,y)=>x>=0&&x<SIZE&&y>=0&&y<SIZE;
  function preciseForbidden(b, r, c){
    if(b[r][c]!==0) return false;
    function runLen(bb,rr,cc,dr,dc,col){
      let count=1;
      for(const s of [1,-1]){
        let nr=rr+dr*s,nc=cc+dc*s;
        while(inb(nr,nc)&&bb[nr][nc]===col){count++;nr+=dr*s;nc+=dc*s;}
      }
      return count;
    }
    function fours(bb,rr,cc,dr,dc){
      const found = new Set();
      for(let off=-4; off<=0; off++){
        const cells = [];
        let valid = true;
        for(let i=0;i<5;i++){
          const x = rr+dr*(off+i), y = cc+dc*(off+i);
          if(!inb(x,y)){ valid=false; break; }
          cells.push([x,y]);
        }
        if(!valid) continue;
        const blacks = cells.filter(([x,y])=>bb[x][y]===1);
        const empties = cells.filter(([x,y])=>bb[x][y]===0);
        if(blacks.length!==4 || empties.length!==1) continue;
        const [er,ec] = empties[0];
        bb[er][ec]=1;
        const makesExactFive = runLen(bb,er,ec,dr,dc,1)===5;
        bb[er][ec]=0;
        if(makesExactFive) found.add(blacks.map(p=>p.join(',')).sort().join('|'));
      }
      return found;
    }
    b[r][c]=1;
    let fiveOrMore=false, sixPlus=false, threeDirs=0;
    const allFours = new Set();
    for(const [dr,dc] of DIRS){
      const run = runLen(b,r,c,dr,dc,1);
      if(run===5) fiveOrMore=true;
      if(run>=6) sixPlus=true;
      for(const k of fours(b,r,c,dr,dc)) allFours.add(k);
      let count=1, openEnds=0;
      for(const s of [1,-1]){
        let nr=r+dr*s, nc=c+dc*s;
        while(inb(nr,nc) && b[nr][nc]===1){count++;nr+=dr*s;nc+=dc*s;}
        if(inb(nr,nc) && b[nr][nc]===0) openEnds++;
      }
      if(count===3 && openEnds===2) threeDirs++;
    }
    b[r][c]=0;
    if(fiveOrMore) return false;
    if(sixPlus) return '長連禁手';
    if(allFours.size>=2) return '四四禁手';
    if(threeDirs>=2) return '三三禁手';
    return false;
  }
  function checkWin(b,r,c,col){
    for(const [dr,dc] of DIRS){
      let count=1;
      for(const s of [1,-1]){
        let nr=r+dr*s,nc=c+dc*s;
        while(inb(nr,nc)&&b[nr][nc]===col){count++;nr+=dr*s;nc+=dc*s;}
      }
      if(col===1 ? count===5 : count>=5) return true; // 黑恰五勝，白 >=5 即勝
    }
    return false;
  }
  function blackCandidates(b, requireConnect=true){
    const {nearStone} = window.SIM;
    const out=[];
    for(let r=0;r<SIZE;r++)for(let c=0;c<SIZE;c++){
      if(b[r][c]!==0 || !nearStone(b,r,c)) continue;
      if(preciseForbidden(b,r,c)) continue;
      if(requireConnect){
        let maxCount=0;
        for(const [dr,dc] of DIRS){
          let count=1;
          for(const s of [1,-1]){
            let nr=r+dr*s,nc=c+dc*s;
            while(inb(nr,nc)&&b[nr][nc]===1){count++;nr+=dr*s;nc+=dc*s;}
          }
          if(count>maxCount) maxCount=count;
        }
        if(maxCount<2) continue;
      }
      out.push([r,c]);
    }
    return out;
  }
  function rankCandidates(b, cands){
    return cands.map(([r,c])=>({r,c,s:window.SIM.scoreAt(b,r,c,1)})).sort((a,b)=>b.s-a.s);
  }
  return {preciseForbidden, checkWin, blackCandidates, rankCandidates, SIZE, DIRS};
})();

// 3) 單人路徑 DFS：黑方每層試 branchFactor 個「自身進攻分數」最高的候選，
//    白方回應用 SIM.aiMove 直接算（零分支），找到黑方連五就回傳整條序列。
window.searchWin = function(inputBoard, maxDepth, branchFactor, nodeBudget){
  let nodes = 0;
  function rec(b, depthRemaining, path){
    nodes++;
    if(nodes > nodeBudget) return 'BUDGET';
    if(depthRemaining <= 0) return null;
    const cands = SIM2.rankCandidates(b, SIM2.blackCandidates(b));
    for(const {r,c} of cands.slice(0, branchFactor)){
      b[r][c] = 1;
      if(SIM2.checkWin(b,r,c,1)){ const res=[...path,[r,c]]; b[r][c]=0; return res; }
      const wm = window.SIM.aiMove(b, 2, false);
      let result = null;
      if(wm){
        b[wm[0]][wm[1]] = 2;
        if(!SIM2.checkWin(b, wm[0], wm[1], 2)) result = rec(b, depthRemaining-1, [...path,[r,c]]);
        b[wm[0]][wm[1]]=0;
      }
      b[r][c]=0;
      if(result === 'BUDGET') return 'BUDGET';
      if(result) return result;
    }
    return null;
  }
  const res = rec(inputBoard.map(row=>row.slice()), maxDepth, []);
  return {result: res, nodes};
};

// 4) 用「獨立的 scratch Game 實例」跑一次真引擎全程驗證（絕對準確、不動到真正對局），
//    找到候選序列後一定要先過這關再真的下棋。
window.verifySequence = function(blackMoves){
  const py = s => pyodide.runPython(s);
  py('scratch = Game(renju=True)');
  const log = [];
  for(const [r,c] of blackMoves){
    const forb = py(`scratch.forbidden(${r},${c})`);
    if(forb){ log.push({r,c,error:'forbidden',reason:String(forb)}); return {ok:false, log}; }
    if(!py(`scratch.place(${r},${c})`)){ log.push({r,c,error:'rejected'}); return {ok:false, log}; }
    let st = JSON.parse(py('scratch.state()'));
    if(st.winner){ log.push({r,c, blackWin:true}); return {ok:true, log, winner:'black'}; }
    const wm = py('scratch.ai_move()');
    const warr = wm.toJs?wm.toJs():wm;
    py(`scratch.place(${warr[0]},${warr[1]})`);
    st = JSON.parse(py('scratch.state()'));
    log.push({black:[r,c], white:[warr[0],warr[1]]});
    if(st.winner){ log.push({whiteWin:true}); return {ok:false, log, winner:'white'}; }
  }
  return {ok:true, log, winner:null, note:'序列跑完還沒分勝負，可加大 maxDepth 重搜'};
};

// 5) 批次找新套路：指定黑方第 2 手座標，自動算好白方第1、2手、跑搜尋、跑驗證，一次回傳結果。
window.tryDivergence = function(secondMove, maxDepth=10, branchFactor=8, nodeBudget=500000){
  const b0 = Array.from({length:15},()=>Array(15).fill(0));
  b0[7][7] = 1;
  const w1 = window.SIM.aiMove(b0, 2, false);
  b0[w1[0]][w1[1]] = 2;
  b0[secondMove[0]][secondMove[1]] = 1;
  const w2 = window.SIM.aiMove(b0, 2, false);
  b0[w2[0]][w2[1]] = 2;
  const searchRes = window.searchWin(b0, maxDepth, branchFactor, nodeBudget);
  if(!searchRes.result || searchRes.result==='BUDGET') return {ok:false, reason:'search_failed', nodes: searchRes.nodes};
  const fullMoves = [[7,7], secondMove, ...searchRes.result];
  const verifyRes = window.verifySequence(fullMoves);
  return {ok: verifyRes.ok && verifyRes.winner==='black', fullMoves, blackMoveCount: fullMoves.length, nodes: searchRes.nodes, verifyRes};
};
```

**找新套路的固定流程：**
1. `window.tryDivergence([r,c])` 指定黑方第 2 手想試的座標，內部自動算好白方兩手回應、跑搜尋、跑驗證，回傳 `{ok, fullMoves, blackMoveCount, nodes}`。`ok:true` 才算數。
2. **想一次測多個分岔點，直接批次跑**（最省時間）：`[[6,8],[9,7],[8,6],[6,9]].map(m=>({move:m, ...window.tryDivergence(m)})).filter(r=>r.ok)` —— 候選裡通常有一半左右會 `ok:false`（搜不到解或驗證失敗），直接跳過即可，不用深究失敗原因。
3. 若要手動控制種子盤面（例如從第 3 手才分岔），**白方每一手都要用 `SIM.aiMove` 真的算出來，不要憑印象手動塞座標**（塞錯過一次，塞成 (6,7) 但真正算出來是 (6,6)，後面整條搜尋建立在不存在的盤面上，驗證時失敗）。
4. 拿到 `ok:true` 的 `fullMoves` 後，用上面的 `window.playMove(r,c)` 在真正的 `game` 上依序重演，取得畫面上的「黑方 獲勝！」再視覺確認一次。
5. 驗證通過的新序列記得補進本檔案「已驗證必勝套路」的表格。
