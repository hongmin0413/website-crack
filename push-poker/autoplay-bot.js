// 雙人推撲克（poker-push.yicheng-self.workers.dev）自動對戰腳本
// 用法：開遊戲首頁（還沒選模式也沒關係）開 DevTools Console，貼上整份執行，
//       就會自動選難度、自動猜拳、打到分出勝負，不用再手動呼叫 run()。
//       想手動走一步觀察判斷，可呼叫 pushPokerBot.step()（要先確定已在對局中）；
//       分出勝負後想再自動打一場，呼叫 pushPokerBot.run() 即可。
// 難度設定：改下面 CONFIG.difficulty 即可，'easy' = 簡單、'hard' = 困難。

window.pushPokerBot = (function () {
  const CONFIG = {
    difficulty: 'hard', // 'easy' 簡單 / 'hard' 困難，要跑哪個難度就改這裡
  };

  const rarity = { 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 8 }; // 數字越大代表這張牌越稀有（能移動它的骰法越少），推回對手用這份權重
  // 自己搶牌用的權重：1 幾乎每種骰法都摸得到（見 rarity 表，5/6 種骰法都能碰到 1），
  // 不急著現在拿，這裡直接歸零——真人玩過的心得：能不先推 1 就不要先推，優先把骰到的機會留給大牌。
  const grabRarity = { ...rarity, 1: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 背景分頁也能繼續跑：參考 2048 那份腳本踩過的雷（見 2048/攻略.md）——Chrome
  // 分頁被切到背景後，rAF 會被直接暫停（完全不觸發），setTimeout 則只是被節流
  // （沒差幾分鐘大約每分鐘才醒一次），所以這裡從頭到尾都只用 setTimeout，絕對不用
  // requestAnimationFrame。但光是這樣還不夠：如果每一步都要串好幾個 setTimeout
  // 才能等到畫面出現變化（例如原本擲骰後用 for 迴圈重試 20 次、等骰到不是我的回合
  // 又固定 sleep），節流狀態下等於同一步要熬過好幾輪「每分鐘才醒一次」，一步就可能
  // 卡好幾分鐘，體感上跟完全停掉沒兩樣。改用 MutationObserver 等待條件成立：它是
  // 「DOM 一有變化就觸發」，不是排程出來的計時器，不吃 Chrome 這套背景計時器節流
  // 預算，畫面（不管前景背景）一有變化就能立刻醒過來重新檢查條件，只有真的等不到
  // 變化時才會靠底下這顆保底 setTimeout 逾時放棄。這樣「我方回合是否輪到」「拆法
  // 選項是否已經出現」都能幾乎即時反應，不會被我們自己的輪詢頻率拖慢。
  function waitForChange(predicate, maxWaitMs = 15000) {
    return new Promise((resolve) => {
      if (predicate()) { resolve(true); return; }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        if (predicate()) finish(true);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const timer = setTimeout(() => finish(predicate()), maxWaitMs); // 保底逾時，避免條件永遠不成立時卡死
    });
  }

  // 破壞動畫：頁面用 CSS transition/animation 做骰子、推牌、燒灼特效（0.2~1.2s 不等），
  // 純視覺效果，遊戲邏輯不會等動畫播完才更新狀態（沒有 animationend/transitionend 監聽）。
  // 開局就把所有動畫時間砍到接近 0，之後的 sleep 也才敢跟著縮短，玩起來明顯變快。
  function killAnimations() {
    if (document.getElementById('pushpoker-bot-no-anim')) return;
    const style = document.createElement('style');
    style.id = 'pushpoker-bot-no-anim';
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        transition-duration: 0.001s !important;
        transition-delay: 0s !important;
      }
    `;
    document.head.appendChild(style);
  }
  killAnimations();

  function visibleButtons() {
    return Array.from(document.querySelectorAll('button')).filter(
      (b) => b.getClientRects().length > 0
    );
  }

  // 從選單畫面自動開局：選難度、按開始對戰、猜拳（隨機出拳，平手會重新出現猜拳按鈕，
  // 迴圈內判斷到按鈕消失才算分出勝負，自然涵蓋「平手重猜」）。如果呼叫時已經在對局中
  // （選單/猜拳按鈕都不存在），兩段都會直接跳過，不影響原本從中途接手的用法。
  async function ensureGameStarted() {
    const diffLabel = CONFIG.difficulty === 'hard' ? '困難' : '簡單';
    const diffBtn = visibleButtons().find((b) => b.textContent.trim() === diffLabel);
    if (diffBtn) {
      diffBtn.click();
      await sleep(100);
      const startBtn = visibleButtons().find((b) => b.textContent.includes('開始對戰'));
      if (startBtn) {
        startBtn.click();
        await sleep(200);
      }
    }

    const rpsChoices = ['ROCK', 'SCISSORS', 'PAPER'];
    for (let tries = 0; tries < 30; tries++) {
      if (!document.querySelector('button[data-rps]')) break; // 沒有猜拳畫面，或已分出勝負
      const pick = rpsChoices[Math.floor(Math.random() * 3)];
      document.querySelector(`button[data-rps="${pick}"]`).click();
      await sleep(250);
    }
  }

  // 注意：畫面上即使不是我的回合，電腦「決定這樣走」的預覽也會渲染出一樣的
  // button.opt 節點，一定要先確認是我的回合才能去點擊，不然會誤點電腦的決策預覽。
  function isMyTurn() {
    return document.body.innerText.includes('你的回合');
  }

  function getCenter() {
    const slots = Array.from(document.querySelectorAll('.slot'));
    const my = new Set();
    const opp = new Set();
    for (const s of slots) {
      const n = parseInt(s.dataset.slot);
      const card = s.querySelector('.card');
      if (!card) continue;
      const label = card.getAttribute('aria-label') || '';
      (label.includes('你的') ? my : opp).add(n);
    }
    return { my, opp };
  }

  // 拆法按鈕文字格式不固定（"直接用 X"、"折成 X+Y"、"拆 X+Y，Y 已在中央"…），
  // 用「推回」把「已在中央/推回」說明切掉，剩下的部分抓所有 1-6 數字即可涵蓋所有格式。
  function parseOpt(btn) {
    const text = btn.textContent;
    const before = text.split('推回')[0];
    const nums = Array.from(before.matchAll(/[1-6]/g)).map((m) => parseInt(m[0]));
    return [...new Set(nums)];
  }

  async function step() {
    const log = [];
    let { my, opp } = getCenter();
    if (my.size === 6) return { done: true, winner: 'you', my: 6, opp: opp.size, log };
    if (opp.size === 6) return { done: true, winner: 'computer', my: my.size, opp: 6, log };

    if (!isMyTurn()) {
      log.push('not my turn, waiting');
      await waitForChange(isMyTurn, 20000); // 用 DOM 變化偵測等電腦下完，不是固定 sleep 硬等
      ({ my, opp } = getCenter());
      return {
        done: my.size === 6 || opp.size === 6,
        winner: my.size === 6 ? 'you' : opp.size === 6 ? 'computer' : null,
        my: my.size,
        opp: opp.size,
        log,
      };
    }

    let btns = visibleButtons();
    const rollBtn = btns.find((b) => b.textContent.includes('擲骰子'));
    if (rollBtn) {
      rollBtn.click();
      log.push('rolled');
    }

    // 擲骰後 options 不會馬上出現；用 waitForChange 偵測 DOM 變化，比固定輪詢
    // 可靠也更省時間，背景分頁時也不會被我們自己的輪詢間隔拖慢（見上面 waitForChange 說明）。
    const visibleOpts = () =>
      Array.from(document.querySelectorAll('button.opt')).filter((b) => b.getClientRects().length > 0);
    await waitForChange(() => !isMyTurn() || visibleOpts().length > 0, 10000);
    const opts = isMyTurn() ? visibleOpts() : [];

    if (opts.length > 0 && isMyTurn()) {
      ({ my, opp } = getCenter());
      let best = null;
      let bestScore = -Infinity;
      for (const o of opts) {
        const nums = parseOpt(o);
        const N = nums.filter((n) => !my.has(n)); // 這個拆法實際會移動的、我還沒有的牌
        const P = N.filter((n) => opp.has(n)); // 其中會把對手的牌推回起點的部分
        let score = N.reduce((s, c) => s + grabRarity[c], 0);
        // 推回對手的加分要看「推回幾張」：推回 2 張以上是真正的淨牌差優勢（見 2.1 第 3 點
        // 「拆 1+2+3 一次推回對手 3 張」那個例子），值得用高權重去換；但只推回 1 張時，用同樣
        // 高的權重會出問題——實測真的發生過「自己的 6 明明還在，卻為了推對手一張普通的牌
        // 選了拆法放掉 6」。改成 0.5 倍後用窮舉腳本重新驗證，發現「對手剛好有 4 被單獨推回」
        // 這種情況 0.5 倍還是不夠低，仍會蓋過「直接用 6」；6 是全場唯一入口，比 0.5 倍再降到
        // 0.35 倍才能在窮舉所有骰值 × 對手推回組合下，穩定保住「直接用 6」不被單張推回打敗。
        score += P.length >= 2 ? 1.5 * P.reduce((s, c) => s + rarity[c], 0) : 0.35 * P.reduce((s, c) => s + rarity[c], 0);

        const myAfter = new Set([...my, ...N]);
        const oppAfter = new Set([...opp].filter((x) => !P.includes(x)));

        if (myAfter.size === 6) score += 1000; // 這步直接獲勝
        if (opp.size >= 3 && P.length > 0) score += 60 * opp.size * P.length; // 對手快贏了，防守優先
        // 移動張數只當極小的平手判斷依據，不能蓋過稀有度：舊版用 N.length * my.size * 2，
        // 局勢越後面權重越誇張，導致寧可折 1+2+3 湊「張數」也不肯單留稀有的 6，等於白白放掉
        // 全場唯一能拿 6 的機會——這正是「先推大數字、能不推 1 就不推」這條心得對應要修的問題。
        score += N.length * 0.5;

        const low = [1, 2, 3];
        if (low.every((x) => myAfter.has(x)) && !low.some((x) => oppAfter.has(x))) {
          score -= 6; // 同時集滿 1+2+3 卻沒碰對手，會暴露在對手一次「6=1+2+3」團滅的風險下
        }

        if (score > bestScore) {
          bestScore = score;
          best = o;
        }
      }
      log.push('picked: ' + best.textContent.trim() + ' score=' + bestScore.toFixed(1));
      best.click();
      await sleep(200);
    } else if (rollBtn) {
      log.push('no legal move, turn passes');
    } else {
      log.push('idle, waiting');
      await sleep(300);
    }

    ({ my, opp } = getCenter());
    return {
      done: my.size === 6 || opp.size === 6,
      winner: my.size === 6 ? 'you' : opp.size === 6 ? 'computer' : null,
      my: my.size,
      opp: opp.size,
      log,
    };
  }

  // 避免腳本被重複貼上執行時，兩個 run() 迴圈同時搶著點按鈕。
  let running = false;

  async function run(maxSteps = 400) {
    if (running) {
      console.log('pushPokerBot 已經在自動遊玩了，不重複啟動。');
      return;
    }
    running = true;
    try {
      await ensureGameStarted();
      for (let i = 0; i < maxSteps; i++) {
        const r = await step();
        console.log('#' + i, r.my + ':' + r.opp, r.log.join(' | '));
        if (r.done) {
          console.log(r.winner === 'you' ? '🏆 你贏了' : '💀 電腦贏了');
          return r;
        }
      }
      console.log('達到步數上限，尚未分出勝負，可再呼叫一次 pushPokerBot.run() 繼續');
    } finally {
      running = false;
    }
  }

  return { step, run, getCenter, isMyTurn, ensureGameStarted, config: CONFIG };
})();

console.log('pushPokerBot 已就緒，難度=' + window.pushPokerBot.config.difficulty + '，自動開始遊玩中……（要換難度就改 pushPokerBot.config.difficulty 後重新貼上整份腳本）');
window.pushPokerBot.run();
