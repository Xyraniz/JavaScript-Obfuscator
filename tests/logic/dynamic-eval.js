const visibleName = "kept";
const answer = 41;
function readDynamically() {
  return eval("answer + 1");
}
module.exports = { value: readDynamically(), visibleName };
