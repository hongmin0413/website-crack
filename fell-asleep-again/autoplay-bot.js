/**
 * sleep-on-the-couch.lol/bf 自動作答腳本（「他又睡著了？」，直男測驗）
 *
 * 用法：點「開始」（或「無盡敷衍」）換到 /bf/game 或 /bf/hell 頁面之後，才把整段貼到 Console 執行
 * （點下去那個動作會讓頁面整個重載，先貼在首頁腳本會被清掉）。
 *
 * 這款跟「今晚睡沙發？」（../sleep-on-the-couch/）角色相反：玩家站在女友這邊，
 * 對方（男友）丟一句敷衍/沒接住情緒的話，妳要在 15～19 秒內挑一句接。指標是「無聊指數」
 * （不是怒氣值），越低越好，衝到 100 他就翻身睡了。
 *
 * 兩種人設，改最上面的 PERSONA 切換：
 * - 'tender'（體貼版，預設）：每題選我判斷「真的接住他那句話」的選項——玩笑接得住、
 *   聊具體的事、不說教不翻舊帳，讓無聊指數往下掉。
 * - 'blunt' （直女版）：每題選我判斷「直女會忍不住講出口」的選項——不是隨口敷衍，是
 *   選項裡最嗆、最不演的那句，通常會讓無聊指數飆升甚至直接把天聊死，用來對照失敗案例。
 *
 * 策略（由高到低）：
 * 1. 題庫比對：跟「今晚睡沙發？」同一顆引擎，全部 228 題的情境／選項文字內嵌在頁面
 *    自己的 Next.js RSC 資料裡，腳本執行當下重新解析一次，比對「目前畫面上他說的那句話」
 *    對到題庫哪一題，依 PERSONA 選對應選項（用選項本文比對，不受畫面選項洗牌順序影響）。
 * 2. 找不到對應題目時，退回用關鍵字評分函式即時判斷目前畫面上的幾個選項。
 *
 * 重要：判斷「哪個選項算體貼／哪個算直女」全程只看「他說的那句話」跟「選項文字」本身，
 * 沒有讀取題庫裡「對方後續回覆」的欄位（這份資料本身也沒把它暴露出來），純粹針對選項
 * 內容做判斷（分析方法見 攻略.md）。
 */
(function () {
  // ---------- PERSONA：想玩哪種人設，改這裡 ----------
  const PERSONA = 'tender'; // 'tender' 體貼版 | 'blunt' 直女版

  if (window.__faaInterval) clearInterval(window.__faaInterval);
  window.__faaLog = [];

  // ---------- 0. 關掉畫面動畫（不影響倒數計時的實際秒數，純粹讓畫面轉場不要卡格） ----------
  if (!document.getElementById('faa-kill-anim')) {
    const style = document.createElement('style');
    style.id = 'faa-kill-anim';
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

  // ---------- 1. 在頁面自己的資料裡重新挖出題庫（只留 scenario/options 文字） ----------
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

  // 體貼版：每題預設選「a」，例外改選別的代號；判斷準則跟逐輪校正過程記在 notes.md
  const TENDER_OVERRIDE = {
    1009: 'b', 1042: 'b', 1058: 'b', 1061: 'b', 1068: 'b', 1073: 'b',
    1093: 'c', 1098: 'b', 1103: 'b', 1106: 'b', 1111: 'b', 1122: 'b', 1127: 'c',
    1129: 'b', 1133: 'c', 1135: 'd', 1137: 'b', 1139: 'c', 1140: 'b', 1141: 'b', 1142: 'b',
    1143: 'c', 1144: 'c', 1148: 'b', 1152: 'b', 1158: 'a', 1160: 'b', 1161: 'b', 1165: 'b',
    1167: 'c', 1169: 'c', 1173: 'c', 1176: 'c', 1184: 'e', 1190: 'c', 1216: 'b',
    1218: 'b', 1220: 'b', 1232: 'b',
  };

  // 直女版：每題預設選「d」，例外改選別的代號——選「直女會忍不住講出口」的最嗆選項
  const BLUNT_LETTER_OVERRIDE = {
    1005: 'c', 1007: 'c', 1012: 'c', 1018: 'c', 1019: 'c', 1031: 'c', 1038: 'e', 1052: 'c',
    1054: 'e', 1055: 'b', 1064: 'c', 1073: 'e', 1083: 'e', 1086: 'e', 1087: 'e', 1088: 'e',
    1089: 'e', 1093: 'a', 1096: 'e', 1097: 'e', 1099: 'e', 1102: 'e', 1103: 'e', 1104: 'e',
    1105: 'e', 1112: 'e', 1113: 'e', 1115: 'e', 1118: 'e', 1119: 'e', 1120: 'e', 1121: 'e',
    1126: 'c', 1128: 'e', 1129: 'e', 1131: 'e', 1134: 'e', 1135: 'e', 1136: 'e', 1137: 'e',
    1144: 'e', 1145: 'e', 1147: 'e', 1150: 'e', 1151: 'e', 1152: 'e', 1153: 'e', 1157: 'c',
    1158: 'c', 1160: 'e', 1161: 'e', 1166: 'e', 1167: 'e', 1168: 'e', 1169: 'a', 1179: 'e',
    1183: 'e', 1185: 'e', 1186: 'c', 1190: 'b', 1191: 'b', 1201: 'e', 1203: 'e', 1208: 'e',
    1209: 'e', 1210: 'e', 1211: 'e', 1212: 'e', 1214: 'e', 1215: 'e', 1219: 'e', 1222: 'e',
    1223: 'e', 1227: 'e', 1232: 'e',
  };

  function buildAnswerMap(bank) {
    const map = {};
    if (!bank) return map;
    for (const id in bank) {
      const q = bank[id];
      const letter = PERSONA === 'blunt'
        ? (BLUNT_LETTER_OVERRIDE[id] || 'd')
        : (TENDER_OVERRIDE[id] || 'a');
      const key = id + letter;
      const opt = q.options && q.options[key];
      if (opt) map[q.scenario] = opt.text || opt;
    }
    return map;
  }

  const bank = extractBank();
  const answerMap = buildAnswerMap(bank);
  window.__faaAnswerMapSize = Object.keys(answerMap).length;

  // ---------- 2. 找不到題庫比對時的備用：關鍵字評分 ----------
  // 體貼版方向：具體接話/一起做/正面延續話題 加分；敷衍/翻舊帳/嗆人 扣分。
  const TENDER_POS = [
    '我請', '我陪', '我來', '一起', '幫你', '記得', '你教我', '你挑', '你選', '你決定',
    '好啊', '真的假的', '我等', '我幫', '我陪你', '成交', '下次', '我學', '你負責', '換我',
    '我出', '算我', '我請客', '沒問題', '走吧', '好呀',
  ];
  const TENDER_NEG = [
    '隨便', '算了', '還好', '不用了', '無所謂', '有差嗎', '哪有差', '不想理', '滾', '分手',
    '廢物', '垃圾', '笨蛋', '白痴', '活該', '幼稚', '噁心', '可悲', '丟臉', '報警', '巨嬰',
  ];
  // 「要求對方自證/表態/公平計較」的語氣，字面不難聽但無聊指數照樣漲得兇，跟敷衍分開列
  const TENDER_INTERROGATE = [
    '講一遍', '算給我聽', '你把你', '比較公平', '報告', '交代清楚', '解釋清楚', '講給我聽',
    '講講看', '我聽聽', '我不打斷', '慢慢講',
  ];
  function isGrudge(t) {
    return t.length > 20 && /上次/.test(t) && /(結果|後來)/.test(t);
  }
  function tenderScore(t) {
    let s = 0;
    for (const k of TENDER_POS) if (t.includes(k)) s += 2;
    for (const k of TENDER_NEG) if (t.includes(k)) s -= 3;
    for (const k of TENDER_INTERROGATE) if (t.includes(k)) s -= 2;
    if (isGrudge(t)) s -= 2;
    return s;
  }
  function bluntScore(t) {
    let s = -tenderScore(t);
    for (const k of TENDER_NEG) if (t.includes(k)) s += 2;
    return s;
  }
  function heuristicScore(t) {
    return PERSONA === 'blunt' ? bluntScore(t) : tenderScore(t);
  }

  // ---------- 3. 讀畫面上的題目/選項（選項本身就是 <button>，比「今晚睡沙發？」好定位） ----------
  function isControlButton(el) {
    const t = el.textContent.trim();
    if (!t) return true;
    return t === '下一題' || t.includes('音效') || t.includes('收回') || t.includes('撤回') || t === '離開對話';
  }
  function getLeaves() {
    return [...document.querySelectorAll('body *')].filter(
      (el) => el.children.length === 0 && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE' && el.tagName !== 'BUTTON'
    );
  }
  function getScenario() {
    const leaves = getLeaves();
    const texts = leaves.map((el) => el.textContent.trim());
    const labelIdx = texts.findIndex((t) => t === '妳要回什麼');
    if (labelIdx === -1) return null;
    for (let i = labelIdx - 1; i >= 0; i--) {
      if (texts[i]) return texts[i];
    }
    return null;
  }
  function getOptionButtons() {
    return [...document.querySelectorAll('button')].filter((b) => !isControlButton(b) && b.textContent.trim().length >= 2);
  }
  function getNextBtn() {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '下一題');
  }

  // ---------- 4. 主迴圈 ----------
  let lastOptSig = '';
  function tick() {
    try {
      const nextBtn = getNextBtn();
      if (nextBtn && !nextBtn.dataset.faaClicked) {
        nextBtn.dataset.faaClicked = '1';
        nextBtn.click();
        window.__faaLog.push({ t: Date.now(), action: 'next' });
        return;
      }
      const opts = getOptionButtons();
      if (opts.length < 2) return;
      const sig = opts.map((o) => o.textContent.trim()).join('|');
      if (sig === lastOptSig) return;
      lastOptSig = sig;

      const scenario = getScenario();
      const wanted = scenario ? answerMap[scenario] : null;
      let chosen = wanted ? opts.find((o) => o.textContent.trim() === wanted) : null;
      let via = 'bank';
      if (!chosen) {
        const scored = opts.map((o) => ({ el: o, text: o.textContent.trim(), score: heuristicScore(o.textContent.trim()) }));
        scored.sort((a, b) => b.score - a.score);
        chosen = scored[0].el;
        via = 'heuristic';
      }
      chosen.click();
      window.__faaLog.push({ t: Date.now(), action: 'answer', via, scenario, chosen: chosen.textContent.trim() });
    } catch (e) {
      window.__faaLog.push({ error: String(e) });
    }
  }

  window.__faaInterval = setInterval(tick, 120);
  console.log(
    `他又睡著了？自動作答已啟動（人設：${PERSONA}）。題庫比對到 ${window.__faaAnswerMapSize} 題。` +
    '查看紀錄：window.__faaLog，停止：clearInterval(window.__faaInterval)'
  );
})();
