import { obfuscate } from "../src/obfuscator.js";

const $ = (id) => document.getElementById(id);
const source = $("source"), output = $("output"), run = $("run");
const error = $("error"), status = $("status");
const copy = $("copy"), download = $("download");
let latest = "";

function updateCount() {
  $("input-count").textContent = source.value.length.toLocaleString("es-ES") + " caracteres";
}
function options() {
  const seed = Number($("seed").value);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("La semilla debe ser un entero no negativo.");
  return {
    seed,
    compact: $("compact").checked,
    renameVariables: $("rename").checked,
    stringArray: $("strings").checked,
    numbersToExpressions: $("numbers").checked,
    simplifyBranches: $("branches").checked,
    controlFlowFlattening: $("control-flow").checked,
    antiTamper: $("anti-tamper").checked
  };
}

source.addEventListener("input", updateCount);
run.addEventListener("click", () => {
  error.hidden = true;
  if (!source.value.trim()) {
    error.textContent = "Pega código JavaScript antes de continuar.";
    error.hidden = false;
    return;
  }
  run.disabled = true;
  status.textContent = "Transformando sintaxis…";
  try {
    const result = obfuscate(source.value, options());
    latest = result.code;
    output.value = latest;
    $("output-count").textContent = latest.length.toLocaleString("es-ES") + " caracteres";
    $("size-result").textContent = result.stats.inputBytes.toLocaleString("es-ES") + " → " +
      result.stats.outputBytes.toLocaleString("es-ES") + " bytes" +
      (result.stats.dynamicScopeSkippedRenaming ? " · renombrado omitido por eval/with" : "") +
      (result.stats.flattenedFunctions ? " · " + result.stats.flattenedFunctions + " funciones aplanadas" : "") +
      (result.stats.antiTamperActive ? " · integridad activa" : "");
    copy.disabled = false;
    download.disabled = false;
    status.textContent = "Listo. Puedes revisar, copiar o descargar el resultado.";
  } catch (cause) {
    error.textContent = cause.message || "No se pudo procesar el código.";
    error.hidden = false;
    status.textContent = "Corrige el código de entrada y vuelve a intentarlo.";
  } finally {
    run.disabled = false;
  }
});
$("clear").addEventListener("click", () => {
  source.value = "";
  output.value = "";
  latest = "";
  updateCount();
  $("output-count").textContent = "—";
  $("size-result").textContent = "";
  error.hidden = true;
  copy.disabled = true;
  download.disabled = true;
  status.textContent = "El código nunca sale de tu navegador.";
});
copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(latest);
    status.textContent = "Código copiado al portapapeles.";
  } catch (_) {
    output.focus(); output.select();
    status.textContent = "Selecciona y copia el resultado.";
  }
});
download.addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([latest], { type: "text/javascript;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "protected.js"; anchor.click();
  URL.revokeObjectURL(url);
});
updateCount();
