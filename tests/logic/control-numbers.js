function classify(value) {
  if (value > 8) return "large";
  if (value === 8) return "exact";
  return value ? value + 2 : 0;
}
let total = 0;
for (let i = 1; i <= 5; i++) {
  total += classify(i);
}
let countdown = 3;
while (countdown > 0) countdown--;
const choose = total > 15 ? "upper" : "lower";
module.exports = { total, countdown, choose, empty: classify(0), high: classify(12) };
