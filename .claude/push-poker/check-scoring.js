// 離線窮舉驗證 autoplay-bot.js 的算分邏輯，不用開瀏覽器。
// 用法：node .claude/push-poker/check-scoring.js
//
// 針對每個骰子點數，窮舉所有拆法組合、以及對手在相關數字上「有沒有推回可能」跟
// 「對手總張數」的每一種情境，檢查有沒有「明明有單張大數字選項可選，卻在沒有正當
// 理由（沒有防守壓力 opp.size>=3、也不是真的一次推回 2 張以上）的情況下选了拆兩張」
// 的案例——這正是真人實測抓到兩次的那類 bug（見 push-poker/攻略.md 2.4 節）。
//
// 已知會印出但不是 bug 的案例：骰到 3 選 1+2、骰到 5 選 2+3 或 1+4，即使完全沒有
// 推回對手也一樣。這是因為 2/3 同一稀有度、4/5 同一稀有度，被放棄的那張跟拿到的那
// 張稀有度打平，此時「多拿一張幾乎免費的 1」在數學上不虧，玩家本人也確認過這種情況
// 不用改（跟骰到 6 那種「全場唯一入口」的情況不一樣，6 才需要嚴格保護）。如果之後
// 改動算分權重，重新跑這支腳本，只要新增的可疑案例不是這兩種已知案例，就代表又出現
// 真正的 bug，要再檢查。

const rarity = { 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 8 };
const grabRarity = { ...rarity, 1: 0 };

// 跟 autoplay-bot.js 裡的算分邏輯保持一致（維護時記得兩邊一起改）。
function scoreOpt(nums, my, opp, oppSize) {
  const N = nums.filter((n) => !my.has(n));
  const P = N.filter((n) => opp.has(n));
  let score = N.reduce((s, c) => s + grabRarity[c], 0);
  score += P.length >= 2
    ? 1.5 * P.reduce((s, c) => s + rarity[c], 0)
    : 0.35 * P.reduce((s, c) => s + rarity[c], 0);
  const myAfter = new Set([...my, ...N]);
  const oppAfter = new Set([...opp].filter((x) => !P.includes(x)));
  if (myAfter.size === 6) score += 1000;
  if (oppSize >= 3 && P.length > 0) score += 60 * oppSize * P.length;
  score += N.length * 0.5;
  const low = [1, 2, 3];
  if (low.every((x) => myAfter.has(x)) && !low.some((x) => oppAfter.has(x))) score -= 6;
  return { score, N, P };
}

const ALL_NUMS = [1, 2, 3, 4, 5, 6];
function subsets(arr) {
  if (arr.length === 0) return [[]];
  const [head, ...rest] = arr;
  const withoutHead = subsets(rest);
  return [...withoutHead, ...withoutHead.map((s) => [head, ...s])];
}
const allSubsets = subsets(ALL_NUMS).filter((s) => s.length > 0);
function optionsFor(dice) {
  return allSubsets.filter((s) => s.reduce((a, b) => a + b, 0) === dice);
}

let issues = 0;
let checked = 0;
for (let dice = 1; dice <= 6; dice++) {
  const opts = optionsFor(dice);
  if (opts.length <= 1) continue; // 沒有選擇餘地
  const involved = [...new Set(opts.flat())];
  const biggestSingle = Math.max(
    ...opts.filter((o) => o.length === 1).map((o) => o[0]).concat([-Infinity])
  );
  const my = new Set(); // 假設自己還沒放任何一張，最容易觸發問題的情境
  const n = involved.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const opp = new Set();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) opp.add(involved[i]);
    for (const extraOpp of [0, 1, 2, 3]) {
      const oppSize = opp.size + extraOpp;
      checked++;
      let best = null;
      let bestScore = -Infinity;
      let bestInfo = null;
      for (const o of opts) {
        const { score, N, P } = scoreOpt(o, my, opp, oppSize);
        if (score > bestScore) {
          bestScore = score;
          best = o;
          bestInfo = { N, P };
        }
      }
      if (biggestSingle === -Infinity) continue;
      const chosenIsBiggestSingle = best.length === 1 && best[0] === biggestSingle;
      if (!chosenIsBiggestSingle) {
        const legitDefense = oppSize >= 3 && bestInfo.P.length > 0;
        const legitMultiPush = bestInfo.P.length >= 2;
        if (!legitDefense && !legitMultiPush) {
          issues++;
          console.log(
            '可疑：dice=' + dice,
            'opp(涉及數字)=' + [...opp],
            'oppSize=' + oppSize,
            '-> 選了',
            best,
            '(score=' + bestScore.toFixed(2) + ')',
            '而不是單張大牌 [' + biggestSingle + ']'
          );
        }
      }
    }
  }
}
console.log('---');
console.log('共檢查', checked, '種情境，發現', issues, '個可疑案例（預期只有骰到 3/5 那兩種已知不算 bug 的案例）');
