function calculate(input) {
  var value = input + 3;
  value = value * 2;
  value -= 1;
  return value;
}
module.exports = {
  mode: "flattened",
  results: [calculate(1), calculate(7), calculate(-2)]
};
