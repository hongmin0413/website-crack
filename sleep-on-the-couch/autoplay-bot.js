/**
 * sleep-on-the-couch.lol 自動作答腳本
 *
 * 用法：點「開始」（或「無盡地獄」）換到 /game 或 /hell 頁面之後，才把整段貼到 Console 執行
 * （點下去那個動作會讓頁面整個重載，先貼在首頁腳本會被清掉）。
 *
 * 兩種人設，改最上面的 PERSONA 切換：
 * - 'tender'（體貼版，預設）：每題選我判斷「求生欲最高」的答案。
 * - 'blunt' （直男版）：每題選我判斷「一般直男會不小心回」的答案——不是存心討罵，是
 *   單純沒接收到情緒訊號、只回答字面問題、習慣用邏輯/事實而不是安慰去回應。
 *
 * 策略（由高到低）：
 * 1. 題庫比對：這網站把全部 192 題的情境／選項文字（不含對方回覆／地雷提示）
 *    內嵌在頁面自己的 Next.js RSC 資料裡，腳本會在執行當下重新解析一次，
 *    比對「目前畫面上的情境文字」對到題庫裡的哪一題，然後依照 PERSONA 選對應選項
 *    （用選項本文比對，不受畫面選項洗牌順序影響）。
 * 2. 找不到對應題目（例如題庫改版、或男友版有別的題）時，退回用關鍵字評分函式
 *    即時判斷目前畫面上的幾個選項（兩種人設各有一套評分方向）。
 *
 * 重要：判斷「哪個選項像哪種人設」全程只看「情境」跟「選項文字」本身，沒有讀取
 * 題庫裡對方會怎麼回、或哪個選項會被判「地雷」的欄位，是純粹針對選項內容做的判斷
 * （見 攻略.md 的分析方法）。
 */
(function () {
  // ---------- PERSONA：想玩哪種人設，改這裡 ----------
  const PERSONA = 'tender'; // 'tender' 體貼版 | 'blunt' 直男版

  if (window.__socInterval) clearInterval(window.__socInterval);
  window.__socLog = [];

  // ---------- 0. 關掉畫面動畫（訊息淡入/怒氣條變色/怒氣條長度過渡都有 CSS transition
  // 跟 animation，不影響倒數計時的實際秒數，純粹讓畫面轉場不要卡格，題目間切換更快） ----------
  if (!document.getElementById('soc-kill-anim')) {
    const style = document.createElement('style');
    style.id = 'soc-kill-anim';
    style.textContent = `
      *, *::before, *::after {
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        scroll-behavior: auto !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- 1. 在頁面自己的資料裡重新挖出題庫（只留 scene/scenario/options 文字） ----------
  function extractBank() {
    try {
      const jsonScripts = [...document.querySelectorAll('script')].filter((s) => !s.src).map((s) => s.textContent);
      const big = jsonScripts.find((t) => t && t.includes('\\"questions\\":{'));
      if (!big) return null;
      const start = big.indexOf('push([1,') + 'push([1,'.length;
      const end = big.lastIndexOf('])');
      const decoded = JSON.parse(big.slice(start, end));
      const key = '"questions":{';
      const kidx = decoded.indexOf(key);
      const braceStart = kidx + key.length - 1;
      let depth = 0, i = braceStart, endIdx = -1;
      for (; i < decoded.length; i++) {
        const c = decoded[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      return JSON.parse(decoded.slice(braceStart, endIdx + 1));
    } catch (e) {
      return null;
    }
  }

  // 體貼版每題選「a」（逐題判斷過求生欲最高的答案）；直男版逐題記錄代號，判斷準則見 攻略.md
  const BLUNT_LETTER = {
    1: 'e', 2: 'd', 3: 'c', 4: 'b', 5: 'd', 6: 'c', 7: 'c', 8: 'd', 9: 'd', 10: 'c',
    11: 'c', 12: 'b', 13: 'c', 14: 'c', 15: 'c', 16: 'c', 17: 'b', 18: 'd', 19: 'd', 20: 'b',
    21: 'b', 22: 'b', 23: 'b', 24: 'd', 25: 'd', 26: 'b', 27: 'b', 28: 'b', 29: 'b', 30: 'c',
    31: 'b', 32: 'b', 33: 'c', 34: 'b', 35: 'c', 36: 'b', 37: 'b', 38: 'b', 39: 'b', 40: 'd',
    41: 'b', 42: 'c', 43: 'b', 44: 'b', 45: 'b', 46: 'b', 47: 'b', 48: 'b', 49: 'b', 50: 'b',
    51: 'b', 52: 'b', 53: 'c', 54: 'b', 55: 'b', 56: 'c', 57: 'b', 58: 'c', 59: 'b', 60: 'b',
    61: 'c', 62: 'b', 63: 'c', 64: 'c', 65: 'b', 66: 'c', 67: 'c', 68: 'd', 69: 'b', 70: 'b',
    71: 'c', 72: 'b', 73: 'b', 74: 'b', 75: 'b', 76: 'b', 77: 'b', 78: 'b', 79: 'b', 80: 'b',
    81: 'b', 82: 'c', 83: 'b', 84: 'c', 85: 'b', 86: 'b', 87: 'b', 88: 'b', 89: 'c', 90: 'b',
    91: 'c', 92: 'c', 93: 'c', 94: 'c', 95: 'c', 96: 'b', 97: 'c', 98: 'b', 99: 'b', 100: 'b',
    101: 'c', 102: 'c', 103: 'c', 104: 'b', 105: 'b', 106: 'c', 107: 'b', 108: 'c', 109: 'b', 110: 'b',
    111: 'b', 112: 'b', 113: 'b', 114: 'b', 115: 'b', 116: 'b', 117: 'b', 118: 'b', 119: 'b', 120: 'b',
    121: 'b', 122: 'b', 123: 'b', 124: 'b', 125: 'b', 126: 'c', 127: 'b', 128: 'b', 129: 'b', 130: 'b',
    131: 'b', 132: 'b', 133: 'b', 134: 'b', 135: 'b', 136: 'c', 137: 'b', 138: 'c', 139: 'b', 140: 'c',
    141: 'b', 142: 'b', 143: 'b', 144: 'b', 145: 'b', 146: 'b', 147: 'c', 148: 'b', 149: 'c', 150: 'b',
    151: 'b', 152: 'b', 153: 'b', 154: 'b', 155: 'b', 156: 'b', 157: 'b', 158: 'c', 159: 'b', 160: 'c',
    161: 'c', 162: 'b', 163: 'b', 164: 'b', 165: 'b', 166: 'b', 167: 'b', 168: 'b', 169: 'b', 170: 'b',
    171: 'b', 172: 'b', 173: 'b', 174: 'b', 175: 'c', 176: 'b', 177: 'b', 178: 'b', 179: 'b', 180: 'b',
    181: 'b', 182: 'c', 183: 'b', 184: 'b', 185: 'b', 186: 'b', 187: 'c', 188: 'c', 189: 'b', 190: 'b',
    191: 'b', 192: 'b',
  };

  function buildAnswerMap(bank) {
    const map = {};
    if (!bank) return map;
    for (const id in bank) {
      const q = bank[id];
      let letter = 'a';
      if (PERSONA === 'blunt') {
        letter = BLUNT_LETTER[id] || 'b';
        if (!q.options[id + letter]) letter = 'b';
        if (!q.options[id + letter]) letter = 'a';
      }
      const key = id + letter;
      if (q.options && q.options[key]) {
        map[q.scenario] = q.options[key].text;
      }
    }
    return map;
  }

  const bank = extractBank();
  const answerMap = buildAnswerMap(bank);
  window.__socAnswerMapSize = Object.keys(answerMap).length;

  // ---------- 2. 找不到題庫比對時的備用：關鍵字評分 ----------
  // 體貼版方向：道歉/負責/具體行動/傾聽/肯定對方 加分；甩鍋/說教/敷衍/計較金錢 扣分。
  const TENDER_POS = [
    '抱歉', '對不起', '是我不對', '我的錯', '我錯了', '我不該', '我來處理', '我來', '我會',
    '我馬上', '我去買', '我請假', '我排時間', '帶你去', '買給你', '陪你', '聽你說', '我在聽',
    '我在乎', '很在乎', '我愛你', '想你', '心疼', '辛苦你了', '辛苦了', '委屈你了', '抱一個',
    '抱抱', '摸摸頭', '我知道錯了', '我改', '我會改', '下次我會', '我記得', '我會記得', '謝謝你',
    '你說得對', '算我不對', '我陪著你', '我陪你', '我不會離開', '我會留下', '我會挽留', '當然要',
    '當然會', '恭喜你', '太替你開心', '為你驕傲', '你好棒', '我請你吃', '我補償你', '我道歉',
    '我在', '別怕', '不怕',
    '你講給我聽', '說給我聽', '告訴我', '我想聽', '我想知道', '我想了解', '我現在', '我馬上',
    '你去坐', '你去休息', '你先休息', '我來刷', '我來洗', '我來弄', '我來做', '我來處理',
    '我搞定', '交給我', '換我', '我扛', '我排休', '我來安排', '浴室給我', '我洗碗', '我拖地',
    '我很喜歡', '我喜歡', '比較懂', '喜歡這樣的你', '因為在跟你', '我沒想到你會', '我沒注意到',
    '我會注意', '你比較重要', '你更重要', '以你為主',
    '喜歡就買', '你決定就好', '你想要就', '你開心就好', '對自己好', '你值得', '犒賞自己',
  ];
  const TENDER_NEG = [
    '而已', '小題大作', '想太多', '太敏感', '神經', '無聊', '幹嘛', '很煩', '很吵', '吵死',
    '晚點', '等一下再說', '等等再說', '沒空', '很忙', '不然要怎樣', '隨便你', '隨便', '都可以',
    '看你', '分手就分手', '滾', '又怎樣', '我沒有錯', '這有什麼好生氣', '關我什麼事', '干我什麼事',
    '你先', '你也', '你才', '你自己', '自己不會', '多少錢', '講那麼多', '有必要嗎', '算了',
    '沒差', '無所謂', '還好吧', '還好啊', '有嗎', '是嗎', '這樣啊', '喔是喔', '哈哈', '開玩笑的',
    '逗你的', '跟你開玩笑', '本來就',
    '要我怎麼辦', '我也很努力', '你應該', '應該可以理解', '所以是你', '所以還是你', '這樣很累',
    '讓你誤會', '你誤會了', '你想太多了吧', '我是為你好', '為你好', '邏輯上', '客觀來說',
    '理性來說', '平心而論',
    '你不要', '你幹嘛', '你怎麼', '沒有意義', '沒意義', '這什麼問題', '問這幹嘛', '假設性',
    '你管', '你哪有', '你很奇怪', '你有病', '你神經',
    '划算', '這個價錢', '這价錢', '算了一下', '吃十頓飯', '再看看好嗎', '沒在用', '上次買的',
    '太貴', '不划算', '浪費錢',
  ];
  function isFakeCare(t) {
    return /^(我也|我知道|我了解|我明白|我懂|我也想|我也很想)[\s\S]{0,20}(但|可是)/.test(t);
  }
  function tenderScore(t) {
    let s = 0;
    for (const k of TENDER_POS) if (t.includes(k)) s += 2;
    for (const k of TENDER_NEG) if (t.includes(k)) s -= 2;
    if (isFakeCare(t)) s -= 4;
    if (t.length < 6 && s <= 0) s -= 1;
    if (/\d/.test(t) && s >= 0) s += 0.5;
    if (/因為.*你/.test(t)) s += 1;
    return s;
  }
  function bluntScore(t) {
    return -tenderScore(t);
  }
  function heuristicScore(t) {
    return PERSONA === 'blunt' ? bluntScore(t) : tenderScore(t);
  }

  // ---------- 3. 讀畫面上的題目/選項 ----------
  function isTimestamp(t) {
    return /週[一二三四五六日]\s*\d{1,2}:\d{2}/.test(t) || /^\d{1,2}:\d{2}$/.test(t);
  }
  function getLeaves() {
    return [...document.querySelectorAll('body *')].filter(
      (el) => el.children.length === 0 && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
    );
  }
  function getOptions() {
    const leaves = getLeaves();
    const texts = leaves.map((el) => el.textContent.trim());
    const labelIdx = texts.findIndex((t) => t === '你要回什麼');
    if (labelIdx === -1) return { opts: [], scenario: null };
    let scenario = '';
    for (let i = labelIdx - 1; i >= 0; i--) {
      if (texts[i]) { scenario = texts[i]; break; }
    }
    const opts = [];
    for (let i = labelIdx + 1; i < leaves.length; i++) {
      const t = texts[i];
      if (!t) continue;
      if (t === '下一題' || isTimestamp(t) || t.includes('沒有回話')) break;
      if (t.length < 2 || t.length > 150) continue;
      opts.push(leaves[i]);
      if (opts.length >= 6) break;
    }
    return { opts, scenario };
  }
  function getNextBtn() {
    return [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '下一題' && b.getBoundingClientRect().top > 150
    );
  }

  // ---------- 4. 主迴圈 ----------
  let lastOptSig = '';
  function tick() {
    try {
      const nextBtn = getNextBtn();
      if (nextBtn && !nextBtn.dataset.socClicked) {
        nextBtn.dataset.socClicked = '1';
        nextBtn.click();
        window.__socLog.push({ t: Date.now(), action: 'next' });
        return;
      }
      const { opts, scenario } = getOptions();
      if (opts.length < 2) return;
      const sig = opts.map((o) => o.textContent.trim()).join('|');
      if (sig === lastOptSig) return;
      lastOptSig = sig;

      const wanted = answerMap[scenario];
      let chosen = wanted ? opts.find((o) => o.textContent.trim() === wanted) : null;
      let via = 'bank';
      if (!chosen) {
        const scored = opts.map((o) => ({ el: o, text: o.textContent.trim(), score: heuristicScore(o.textContent.trim()) }));
        scored.sort((a, b) => b.score - a.score);
        chosen = scored[0].el;
        via = 'heuristic';
      }
      chosen.click();
      window.__socLog.push({ t: Date.now(), action: 'answer', via, scenario, chosen: chosen.textContent.trim() });
    } catch (e) {
      window.__socLog.push({ error: String(e) });
    }
  }

  window.__socInterval = setInterval(tick, 120);
  console.log(
    `sleep-on-the-couch 自動作答已啟動（人設：${PERSONA}）。題庫比對到 ${window.__socAnswerMapSize} 題。` +
    '查看紀錄：window.__socLog，停止：clearInterval(window.__socInterval)'
  );
})();
