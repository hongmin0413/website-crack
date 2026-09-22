# dino 開發筆記（給 AI／維護者看，非玩家說明）

給人看的版本在 [../../dino/攻略.md](../../dino/攻略.md)。這份放程式碼層級的細節、分析方法、除錯教訓。

## 遊戲物件與資料結構

核心邏輯就是原版 Chrome 離線小恐龍 `offline.min.js` 的 `Runner` class，整個遊戲物件掛在全域變數：

```js
Runner.instance_
```

| 欄位 | 說明 |
|---|---|
| `Runner.instance_.tRex` | 恐龍本身：`xPos`、`jumping`、`ducking` |
| `Runner.instance_.horizon.obstacles` | 目前畫面上的障礙物陣列，每個有 `xPos`、`yPos`、`width`、`typeConfig.type` |
| `Runner.instance_.currentSpeed` | 目前捲動速度（px/frame，起始 `SPEED`，每影格 `+ACCELERATION`，封頂 `MAX_SPEED`） |
| `Runner.instance_.crashed` | 是否已撞毀 |
| `Runner.instance_.distanceMeter` | 分數；`digits.join('')` 可讀目前分數字串 |

### 關鍵常數（`Runner.config`）

```js
SPEED: 6            // 初始速度
ACCELERATION: 0.001  // 每影格加速量
MAX_SPEED: 13         // 速度封頂（不會無限加速）
GAMEOVER_CLEAR_TIME: 1200  // 撞毀後要等這麼久才能用按鍵重開
```

### 分數上限

```js
distanceMeter.config.MAX_DISTANCE_UNITS: 5   // 固定 5 位數計分器
distanceMeter.maxScore: 99999                 // 分數顯示上限
```

遊戲沒有「破關」概念，唯一的天花板是：① 速度在 13 封頂後難度不再上升、② 分數顯示最多到 99999。理論上完美操作可以無限玩下去。

### 障礙物生成邏輯（`Horizon.prototype.updateObstacles` / `addNewObstacle`）

- **不是一次生成全部**，是滾動式：畫面上永遠只有「現有障礙物 + 最多一個排隊中的下一個」。
- 觸發生成下一個的時機：目前最新的障礙物已經**進入可視範圍**，且它的右邊界 + 預留間隔（`gap`，隨速度變動）快要超出畫布右緣時。
- 新障礙物的類型是**隨機**挑選（仙人掌 小/大/連續、翼龍），部分類型有 `minSpeed` 門檻（速度不夠快不會出現），並有防止同型態連續出現的機制。

## 網站內建「AI/機器人模式」的真實邏輯

`https://elgoog.hk/assets/p/dinosaur-game/js/index.min.js` 裡有一段完整、獨立於原版 `Runner` 的機器人邏輯，掛在：

```js
window.__elgoogDinoBot.startFromRunner()  // 對應畫面上的「AI/機器人模式」checkbox
```

反解出來的判斷方式（`autoplay-bot.js` 的 `cfg` 就是照抄這份參數）：

- **跳 or 蹲的核心判斷**：`障礙物.yPos >= jumpYThreshold(75)` → 跳；否則 → 蹲。
  - `yPos` 是障礙物在 640×640 canvas 座標系裡的垂直位置，數字越大代表越靠近地面。
  - 地面障礙物（仙人掌）與低飛翼龍一律落在 `yPos >= 75`，所以永遠是「跳」。
  - 只有飛得比較高、剛好卡在恐龍站立時頭部高度的翼龍，`yPos < 75`，才需要「蹲」（蹲下降低碰撞箱高度即可安全通過）。
- **提前量會動態調整**（`jumpStartUpperFrames` / `jumpStartLowerFrames` 為基礎值）：
  - 障礙物寬度 `>= wideObstacleWidth(42)`（例如連續仙人掌）→ 提早跳。
  - 跟下一個障礙物的間隔 `<= chainGapFramesThreshold(14)` 影格 → 視為連續障礙，提早跳，才有空檔應付下一個。
  - 障礙物 `xPos <= emergencyDistance(70)` → 緊急狀況，無視冷卻強制動作。
- **有重試機制**：跳起來落地（`landingGraceMs` 寬限時間內）如果障礙物還在，且距上次跳躍超過 `retryCooldownMs`，會再跳一次，避免因誤判卡死。
- **按鍵是模擬真實 `KeyboardEvent`**（`document.createEvent('KeyboardEvent')` + `dispatchEvent`），跟真人按鍵效果相同，不是呼叫內部函式作弊。

## 如何驗證 / 重新分析（給未來的自己）

1. 打開 DevTools Console，貼上：
   ```js
   fetch(location.origin + '/gomoku/gomoku.py').then(r=>r.text()).then(console.log)
   ```
   類的手法（對這個站則是 `assets/p/dinosaur-game/js/index.min.js`）可以直接把原始碼抓下來看，不需要用力反混淆——**這類靜態網站的邏輯通常就是明碼放在可 fetch 到的 JS 檔裡**，先找檔案名稱、再搜尋關鍵字（例如 `Bot Activated`、`jumpYThreshold`）就能定位到核心邏輯。
2. 確認 `Runner.instance_` 是否存在、`horizon.obstacles` 結構是否一致（elgoog.hk 版跟原版 Chrome 內建版本結構應該相同，因為就是同一份 `offline.min.js`）。
3. 若網站更新導致參數改變，重新抓 `index.min.js` 搜尋 `l={default:{...` 這段設定物件即可拿到最新參數。

## 使用 `autoplay-bot.js`

1. 打開遊戲頁面，開啟 DevTools Console。
2. 貼上整份 `autoplay-bot.js` 並執行。
3. 腳本會：自動開始遊戲、依上述邏輯自動跳/蹲、撞毀後自動重新開始，並把成績記錄進 `window.__dinoBotLog`；分數達到 `TARGET_SCORE`（預設 1000，可在腳本開頭改）時自動停止控制。
4. 常用查詢：
   ```js
   window.__dinoBotLog       // 每次撞毀的分數紀錄
   window.__dinoBotBest      // 目前最高分
   window.__dinoBotAttempts  // 已重來次數
   window.__dinoBotStop = true // 手動停止
   ```

## 已驗證結果

實測跑過一次，單局不中斷情況下衝到 **1006 分**（達標後自動停止）。過程中曾經因為「腳本啟動時遊戲還沒重新開始」而空跑一局，之後修正為「偵測到 `crashed` 就自動按跳躍鍵重開」解決。

## 這件事帶來的一般性心得（可套用在其他類似網站分析上）

- 遇到「這個網站的小遊戲 / AI 模式」這類需求，第一步永遠是 **看它是不是純前端邏輯**（`view-source` 或 DevTools Sources 面板），純前端的話原始碼幾乎一定可以直接 fetch 到，不用靠截圖或按鍵推敲。
- 遊戲物件如果掛在 `window` 全域變數上（像 `Runner.instance_`），可以直接用 `javascript_exec` 讀取即時狀態（位置、速度、障礙物），比對截圖判斷快非常多、也準非常多。
- 「按鍵模擬」用 `document.createEvent('KeyboardEvent')` + 手動覆寫 `keyCode` getter 最穩，比 `new KeyboardEvent()`（`keyCode` 在新版瀏覽器是唯讀、標準建構子塞不進去）相容性更好。
- 分析出對方的判斷邏輯（門檻值、時機）後，自己重寫一份效果相同、但邏輯是自己控制的版本，比直接呼叫對方暴露出來的內部函式更穩定、也更容易依需求調整（例如改目標分數、改反應提前量）。
