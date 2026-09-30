function outer(value) {
  const read = () => value;
  {
    let value = "inner";
    if (!value) throw new Error("unexpected");
  }
  return read();
}
const callbacks = [];
for (let index = 0; index < 4; index++) {
  callbacks.push(() => index);
}
module.exports = {
  outer: outer("captured"),
  callbackValues: callbacks.map(callback => callback()),
  keys: Object.keys({ alpha: 1, beta: 2 })
};
