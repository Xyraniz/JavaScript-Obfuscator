function makeState({ value: initial = 4, step = 3, name = "counter" } = {}) {
  let value = initial;
  return function advance(delta = step) {
    value += delta;
    const current = value;
    return { name, current, repeated: name };
  };
}
const next = makeState({ value: 7, step: 2 });
module.exports = [next(), next(4), next()];
