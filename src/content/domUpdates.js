export function setTextContentIfChanged(element, nextText) {
  if (!element || element.textContent === nextText) return false;
  element.textContent = nextText;
  return true;
}
