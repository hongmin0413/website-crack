# 2048 Bot 優化建議

這份筆記是針對目前 `autoplay-bot.js`
的分析，重點放在搜尋方法、Heuristic（評分函數）、權重與效能取捨。

目前這版已經不是普通的 2048 腳本，核心包含：

-   Expectimax
-   蛇形權重（Snake）
-   固定角落
-   尾巴／身體異常判斷
-   Empty cells 評分
-   Chance node pruning
-   Iterative deepening
-   Transposition cache
-   悔棋重骰
-   TypedArray / memory pool 等效能優化

從目前實測結果來看，已經可以穩定打到 4096、8192，甚至出現 100,000+
分的單局，因此後續優化重點比較適合放在 **Heuristic 與 Chance Node
策略**，而不是單純暴力增加搜尋時間。

------------------------------------------------------------------------

## 1. 最值得注意：目前的搜尋 depth 沒有等於「幾步玩家操作」

目前搜尋結構是：

``` text
玩家
 ↓
隨機生成
 ↓
玩家
 ↓
隨機生成
 ↓
玩家
 ↓
...
```

因此 `depth = 6` 實際上只有大約 3 次玩家決策與 3 次隨機生成。

所以註解中的「depth 5 之後分數已飽和」需要小心解讀：這個 depth
定義和「往前看 6 個玩家操作」並不完全相同。

### 建議

不要直接把 `MAX_SEARCH_DEPTH` 暴力往上拉，而是：

-   淺層：完整搜尋
-   深層：開始進行 chance pruning
-   優先保留前幾層的精確性

例如：

``` text
玩家 1
  chance
玩家 2
  chance
玩家 3
  chance
玩家 4
  chance
...
```

在較深層才開始犧牲部分 chance node 精度來換取搜尋速度。

------------------------------------------------------------------------

# 2. Snake 權重值得重新實驗

目前的 Snake：

``` text
15 14 13 12
 8  9 10 11
 7  6  5  4
 0  1  2  3
```

目前是：

``` js
score += weightedValue(tile) * weight;
```

也就是位置權重採用線性差距。

例如：

``` text
4096 × 15
2048 × 14
1024 × 13
```

這代表相鄰位置的重要程度差距不算非常大。

### 可以實驗指數型 Snake

例如：

``` text
32768 16384 8192 4096
 2048  1024  512  256
  128    64   32   16
    8     4    2    1
```

這種方式會非常強烈地要求最大方塊維持在蛇頭附近。

不過指數權重也可能過度僵化，因此最好的做法不是直接認定哪一種一定比較強，而是實際跑
benchmark：

``` text
Linear Snake
vs
Exponential Snake
```

各跑 100～500 局比較。

------------------------------------------------------------------------

# 3. `weightedValue()` 的 32 門檻有明顯斷層

目前：

``` js
const BIG_TILE_THRESHOLD = 32;
const BIG_TILE_MULTIPLIER = 4;

function weightedValue(v) {
    return v >= BIG_TILE_THRESHOLD ? v * BIG_TILE_MULTIPLIER : v;
}
```

因此：

``` text
16 → 16
32 → 128
```

32 相對於 16 不只是兩倍，而是直接變成八倍的評分。

這可能造成 heuristic 對 32 產生不自然的偏好。

### 建議改成連續函數

例如：

``` js
function weightedValue(v) {
    if (v === 0) return 0;
    return v * Math.log2(v);
}
```

或者：

``` js
function weightedValue(v) {
    if (v === 0) return 0;
    return v * Math.pow(Math.log2(v), 1.5);
}
```

這樣 2、4、8、16、32、64、128......的重要程度會比較平滑。

------------------------------------------------------------------------

# 4. 建議加入 Smoothness

目前 `evaluate()` 主要考慮：

``` text
Snake position
Body anomaly
Tail bonus
Empty cells
```

但沒有直接衡量「相鄰方塊數值是否接近」。

2048 很重要的一件事是：

> 相鄰的方塊如果數值階級接近，通常比較容易繼續合併。

例如：

``` text
1024 512 256 128
  64  32  16   8
   4   2   0   0
   0   0   0   0
```

通常比數字四散的盤面更容易維持結構。

### 建議

``` js
function smoothness(flat) {
    let score = 0;

    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            const i = r * 4 + c;
            const v = flat[i];
            if (!v) continue;

            const lv = Math.log2(v);

            if (c < 3 && flat[i + 1]) {
                score -= Math.abs(
                    lv - Math.log2(flat[i + 1])
                );
            }

            if (r < 3 && flat[i + 4]) {
                score -= Math.abs(
                    lv - Math.log2(flat[i + 4])
                );
            }
        }
    }

    return score;
}
```

然後：

``` js
return snakeValue(flat)
    - anomalyPenalty * ANOMALY_PENALTY_WEIGHT
    + tailBonus
    + empties * EMPTY_WEIGHT
    + smoothness(flat) * SMOOTHNESS_WEIGHT;
```

------------------------------------------------------------------------

# 5. Empty cells 不一定適合固定線性權重

目前：

``` js
const EMPTY_WEIGHT = 8;
```

也就是：

``` text
空格 × 8
```

但 2048 的空格價值通常不是線性的。

例如：

``` text
10 個空格
8 個
6 個
4 個
2 個
1 個
0 個
```

越接近 0，危險程度越高。

### 建議實驗非線性 Empty bonus

例如：

``` js
const emptyBonus =
    empties * empties * EMPTY_WEIGHT;
```

或者：

``` js
const emptyBonus =
    Math.pow(empties, 3) * EMPTY_WEIGHT;
```

這會讓 AI 在盤面開始變危險時，更強烈地保留生存空間。

------------------------------------------------------------------------

# 6. `criticality()` 可以從「只看四鄰」改成距離衰減

目前 `criticality()` 只計算：

``` text
上
下
左
右
```

也就是只有相鄰方塊會影響空格的重要性。

### 可以改成距離衰減

例如：

``` js
function criticality(flat, i) {
    const r = (i / 4) | 0;
    const c = i % 4;

    let score = 0;

    for (let j = 0; j < 16; j++) {
        if (!flat[j]) continue;

        const jr = (j / 4) | 0;
        const jc = j % 4;

        const dist =
            Math.abs(r - jr) +
            Math.abs(c - jc);

        score +=
            weightedValue(flat[j]) /
            (1 + dist * dist);
    }

    return score;
}
```

這樣：

``` text
距離 1 → 很重要
距離 2 → 還有影響
距離 3 → 有一些影響
距離更遠 → 影響快速下降
```

會比「只有上下左右」更平滑。

------------------------------------------------------------------------

# 7. Chance node pruning 可以做 Adaptive

目前的策略是：

``` text
前 6 個 critical 空格：
    展開 2 + 4

其他空格：
    只展開 2
```

這確實能大幅減少節點數，但它其實已經不是完全精確的 Expectimax，而是近似
Expectimax。

問題在於：

``` text
4 出現機率只有 10%
```

雖然機率低，但高分盤面中，一顆 4 出現在錯誤位置仍然可能非常致命。

### 建議

淺層：

``` text
完整展開所有空格
2 + 4
```

深層：

``` text
criticality pruning
```

例如概念上：

``` text
depth 低
→ 完整

depth 中
→ 大部分完整

depth 高
→ pruning
```

這通常比每一層都使用相同 pruning 規則更合理。

------------------------------------------------------------------------

# 8. `TAIL_SIZE = 6` 可以改成動態

目前：

``` js
const TAIL_SIZE = 6;
```

但盤面不同階段，尾巴的重要程度不同。

例如：

### 開局

空格很多，沒有必要過度強調尾巴。

### 中期

尾巴開始變得非常重要。

### Endgame

盤面幾乎滿格時，尾巴與空間管理又會變得更加重要。

因此可以考慮：

``` js
function getTailSize(empties) {
    if (empties >= 8) return 4;
    if (empties >= 5) return 6;
    if (empties >= 3) return 7;
    return 8;
}
```

讓 heuristic 隨盤面狀態改變。

------------------------------------------------------------------------

# 9. 固定角落策略可以再改進

目前：

``` text
第一個盤面
 ↓
選角落
 ↓
整局鎖死
```

優點是避免：

``` text
左 → 右 → 左 → 右
```

一直抖動。

但缺點是：

> 如果開局判斷錯了角落，整局都必須承受這個決定。

### 方案 A：前 10～20 步先觀察

例如：

``` text
開局
 ↓
暫時不鎖
 ↓
觀察 10～20 步
 ↓
再決定角落
```

### 方案 B：允許有限度換角落

例如：

``` text
目前角落 A
 ↓
只有新的角落 B 明顯優於 A
 ↓
才允許切換
```

可以避免角落頻繁抖動，同時降低第一次選錯的風險。

------------------------------------------------------------------------

# 10. 悔棋可以從「同方向重骰」進一步升級

目前流程：

``` text
選 RIGHT
 ↓
RIGHT
 ↓
盤面突然 dirty
 ↓
UNDO
 ↓
再 RIGHT
```

這是合理的，因為你想利用 undo 重新取得隨機方塊。

但可以再進一步：

``` text
原本最佳 move = RIGHT
 ↓
RIGHT 後 dirty
 ↓
UNDO
 ↓
重新 bestMove()
 ↓
如果仍然 RIGHT → RIGHT
如果變成 DOWN → DOWN
```

這樣 reroll 不只是：

> 「重新抽一個方塊」

而是：

> 「重新抽一個方塊後，重新評估整個決策」。

------------------------------------------------------------------------

# 11. Transposition cache 可以考慮跨 move

目前：

``` js
const cache = newCache();
```

是在每次 `bestMove()` 時建立。

優點：

-   不會無限吃記憶體
-   不需要處理大量舊盤面
-   邏輯簡單

缺點：

> 每一步之間的高度相似盤面沒有共享 cache。

可以考慮做 global transposition table，例如：

``` js
const GLOBAL_CACHE_LIMIT = 100000;
```

超過一定數量就清除。

不過這屬於效能優化，優先級低於 heuristic。

------------------------------------------------------------------------

# 12. 不建議現在直接把搜尋時間暴力拉高

目前：

``` js
SEARCH_TIME_BUDGET_MS = 25;
EXTENDED_SEARCH_TIME_BUDGET_MS = 60;
```

不要第一時間就改成：

``` js
25 → 100
```

原因是：

> 如果 heuristic 本身還有改善空間，增加搜尋時間可能只是讓 AI
> 更精準地執行一個不夠好的評分函數。

目前比較像：

``` text
搜尋能力
████████████████████

評分函數
████████████░░░░░░░░
```

所以優先改善 heuristic 比單純增加 CPU 時間更值得。

------------------------------------------------------------------------

# 13. 最重要：用大量局數做 A/B Test

目前看到的結果例如：

``` text
80568
80784
34512
80464
60416
5680
70280
27180
80796
110744
```

很有參考價值，但單局最高分不能很好地判斷 heuristic 是否真的改善。

2048 的隨機性很高。

### 建議每個版本至少跑 100～500 局

記錄：

``` text
平均分
Median
P25
P75
最高分
2048 達成率
4096 達成率
8192 達成率
16384 達成率
平均最大 tile
平均 moves
```

尤其值得比較：

``` text
平均最大 tile
8192 達成率
16384 達成率
平均分
```

這些比單純看最高分更有意義。

------------------------------------------------------------------------

# 建議的修改優先順序

不要一次全部改掉。

## 第一階段：Heuristic

先改：

1.  Smoothness
2.  非線性 Empty bonus
3.  移除 `weightedValue()` 的 32 硬切斷層
4.  實驗 Linear / Exponential Snake

------------------------------------------------------------------------

## 第二階段：Chance pruning

改成：

``` text
淺層
→ 完整 2/4

深層
→ criticality pruning
```

------------------------------------------------------------------------

## 第三階段：Criticality

從：

``` text
只看上下左右
```

改成：

``` text
距離衰減
```

------------------------------------------------------------------------

## 第四階段：Corner

從：

``` text
第一盤面直接鎖死
```

改成：

``` text
前 10～20 步觀察
→ 再鎖
```

或者：

``` text
用搜尋後的期望值選 corner
```

------------------------------------------------------------------------

# 我最推薦先做的 V2

如果要保留目前整個架構，只改最值得測試的部分，我會先做：

``` text
                 Snake
                   │
                   ▼
             Position score
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
   Empty cells  Smoothness  Merge potential
       │           │           │
       └───────────┼───────────┘
                   ▼
             Body anomaly
                   │
                   ▼
             Final score
```

概念上的評分：

``` js
score =
    snake
    + emptyBonus
    + smoothness * 10
    + mergePotential * 20
    - anomaly * 6;
```

這裡的 `10 / 20 / 6` 不應視為最終答案，而應該當成初始參數，透過大量對局
benchmark 調整。

------------------------------------------------------------------------

# 最後的優先級

  優先級   項目                     原因
  -------- ------------------------ -----------------------------------
  ★★★★★    Smoothness               目前 heuristic 明顯缺少的核心資訊
  ★★★★★    Empty 非線性權重         生存能力很重要
  ★★★★★    Snake 權重 A/B Test      可能直接影響高分上限
  ★★★★☆    Chance pruning           精確度與搜尋速度的核心 trade-off
  ★★★★☆    Criticality 距離衰減     目前判斷空格的方法偏簡單
  ★★★☆☆    Dynamic Tail             有潛力，但需要 benchmark
  ★★★☆☆    Corner 延後鎖定          可以降低開局誤判
  ★★☆☆☆    Reroll 後重新 bestMove   改善策略完整性
  ★★☆☆☆    Global cache             主要是效能優化
  ★☆☆☆☆    單純增加搜尋時間         在 heuristic 尚未改善前優先級最低

**總結：目前這支 Bot 的下一個突破點，我會放在 `evaluate()`，不是
`search()`。**

尤其值得先測的是：

``` text
目前版本
vs
Snake + Smoothness + 非線性 Empty
```

先跑 100～500 局，再決定下一步要不要動搜尋深度與 pruning。
