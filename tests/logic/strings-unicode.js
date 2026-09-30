const message = "AI can inspect this phrase 🙂";
function repeat(text) {
  return text + " / " + text;
}
const record = { "fixed-key": repeat(message), message };
record["computed-key"] = repeat(message);
module.exports = {
  first: record["fixed-key"],
  second: record["computed-key"],
  repeated: record.message === message,
  unicode: "雪と火 🚀"
};
